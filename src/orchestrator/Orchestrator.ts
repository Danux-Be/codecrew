import { isQuotaExhaustedError } from "../clients/anthropicCompat.js";
import { ClaudeClient } from "../clients/ClaudeClient.js";
import { GLMClient } from "../clients/GLMClient.js";
import type { ImplementationPlan, PlanStep } from "../clients/schemas.js";
import type { FileChange, ProjectContext } from "../clients/types.js";
import {
  listProjectTree,
  readFileIfExists,
  resolveFilesGlob,
  resolveInRoot,
  writeFileEnsured,
} from "../tools/fileSystem.js";
import { runCommand } from "../tools/terminal.js";
import { computeFileDiff } from "../utils/diffing.js";
import { logger } from "../ui/logger.js";
import type { RunOptions } from "./types.js";

interface StepOutcome {
  changes: FileChange[];
  forcedByIterationLimit: boolean;
  reviewSkipped: boolean;
}

/**
 * Orchestrateur principal : fait collaborer Claude (plan + relecture) et GLM
 * (implémentation) étape par étape, avec une boucle de correction bornée
 * avant application des modifications sur le disque.
 *
 * Résilience : si l'un des deux agents tombe à court de crédit/quota en
 * cours de route, l'orchestrateur bascule automatiquement sur l'autre pour
 * le rôle concerné plutôt que d'interrompre tout le run :
 * - GLM indisponible -> Claude implémente lui-même l'étape (relecture inchangée)
 * - Claude indisponible -> GLM génère le plan et implémente, mais la
 *   relecture indépendante est désactivée pour le reste du run (GLM ne
 *   relit jamais son propre travail : ce ne serait pas une vraie relecture).
 * Si les deux agents sont indisponibles, l'erreur est propagée normalement.
 */
export class Orchestrator {
  private claudeAvailable = true;
  private glmAvailable = true;

  constructor(
    private readonly claude: ClaudeClient,
    private readonly glm: GLMClient,
  ) {}

  async run(options: RunOptions): Promise<void> {
    const context = await this.buildContext(options);

    const plan = await this.generatePlan(options.task, context);

    logger.title("Plan d'implémentation");
    logger.info(plan.summary);
    for (const step of plan.steps) {
      logger.info(`  ${step.id}. ${step.description}  [${step.files.join(", ")}]`);
    }

    if (plan.steps.length === 0) {
      logger.warn("Le plan ne contient aucune étape. Rien à faire.");
      return;
    }

    let totalApplied = 0;
    let totalForced = 0;
    let totalUnreviewed = 0;

    for (const step of plan.steps) {
      logger.title(`Étape ${step.id}/${plan.steps.length} — ${step.description}`);

      const baseline = await this.readBaseline(options.root, step.files);
      const outcome = await this.implementStepWithReview(step, baseline, options);

      if (!options.dryRun) {
        for (const change of outcome.changes) {
          const abs = resolveInRoot(options.root, change.path);
          await writeFileEnsured(abs, change.content);
        }
      }

      totalApplied += outcome.changes.length;
      if (outcome.forcedByIterationLimit) totalForced += 1;
      if (outcome.reviewSkipped) totalUnreviewed += 1;

      logger.success(
        options.dryRun
          ? `Étape ${step.id} : ${outcome.changes.length} fichier(s) proposé(s) (mode dry-run, rien écrit sur disque).`
          : `Étape ${step.id} : ${outcome.changes.length} fichier(s) appliqué(s).`,
      );
    }

    if (options.testCommand && !options.dryRun) {
      await this.runTests(options);
    }

    logger.title("Résumé");
    const notes: string[] = [];
    if (totalForced > 0) notes.push(`${totalForced} étape(s) appliquée(s) malgré des réserves (limite d'itérations atteinte)`);
    if (totalUnreviewed > 0) notes.push(`${totalUnreviewed} étape(s) appliquée(s) sans relecture indépendante (Claude indisponible)`);
    logger.success(
      `${plan.steps.length} étape(s) traitée(s), ${totalApplied} fichier(s) touché(s)` +
        (notes.length > 0 ? `, dont ${notes.join(", ")}.` : "."),
    );
  }

  /**
   * Génère le plan via Claude ; si Claude est indisponible (crédits
   * épuisés), bascule sur GLM. Si les deux échouent pour la même raison,
   * l'erreur est propagée.
   */
  private async generatePlan(task: string, context: ProjectContext): Promise<ImplementationPlan> {
    if (this.claudeAvailable) {
      const spinner = logger.spinner("claude", "Analyse du projet et génération du plan d'implémentation...");
      try {
        const plan = await this.claude.createPlan(task, context);
        spinner.succeed("Plan généré par Claude.");
        return plan;
      } catch (err) {
        if (!isQuotaExhaustedError(err)) {
          spinner.fail("Échec de la génération du plan.");
          throw err;
        }
        this.claudeAvailable = false;
        spinner.warn("Claude indisponible (crédits/quota épuisés) — bascule sur GLM pour le plan et la suite du run.");
        logger.warn("Aucune relecture indépendante ne sera possible tant que Claude reste indisponible.");
      }
    }

    if (this.glmAvailable) {
      const spinner = logger.spinner("glm", "Génération du plan d'implémentation (Claude indisponible)...");
      try {
        const plan = await this.glm.createPlan(task, context);
        spinner.succeed("Plan généré par GLM.");
        return plan;
      } catch (err) {
        if (!isQuotaExhaustedError(err)) {
          spinner.fail("Échec de la génération du plan.");
          throw err;
        }
        this.glmAvailable = false;
        spinner.fail("GLM également indisponible (crédits/quota épuisés).");
      }
    }

    throw new Error(
      "Impossible de générer un plan : Claude et GLM sont tous les deux indisponibles (crédits/quota épuisés).",
    );
  }

  /**
   * Boucle implémentation -> relecture pour une étape donnée, avec repli
   * automatique entre agents et un nombre maximal d'itérations en cas de
   * demande de changements.
   */
  private async implementStepWithReview(
    step: PlanStep,
    baseline: Map<string, string | null>,
    options: RunOptions,
  ): Promise<StepOutcome> {
    let feedback: string | undefined;
    let lastChanges: FileChange[] = [];

    for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
      const currentFiles = step.files.map((path) => ({ path, content: baseline.get(path) ?? null }));
      const changes = await this.implementStep(step, currentFiles, feedback, iteration);
      lastChanges = changes;

      const diffs = changes.map((c) => computeFileDiff(c.path, baseline.get(c.path) ?? null, c.content));
      for (const diff of diffs) {
        logger.info(`--- diff: ${diff.path} ---`);
        logger.diff(diff.unified);
      }

      if (!this.claudeAvailable) {
        logger.warn("Étape appliquée sans relecture indépendante (Claude indisponible).");
        return { changes, forcedByIterationLimit: false, reviewSkipped: true };
      }

      const reviewSpinner = logger.spinner("claude", "Relecture du code...");
      let review;
      try {
        review = await this.claude.reviewChanges(step.description, step.instructions, diffs);
      } catch (err) {
        if (!isQuotaExhaustedError(err)) {
          reviewSpinner.fail("Échec de la relecture.");
          throw err;
        }
        this.claudeAvailable = false;
        reviewSpinner.warn("Claude devenu indisponible (crédits/quota épuisés) pendant la relecture.");
        logger.warn("Étape appliquée sans relecture indépendante (Claude indisponible).");
        return { changes, forcedByIterationLimit: false, reviewSkipped: true };
      }

      if (review.verdict === "approve") {
        reviewSpinner.succeed(`Approuvé — ${review.summary}`);
        return { changes, forcedByIterationLimit: false, reviewSkipped: false };
      }

      reviewSpinner.warn(`Changements demandés — ${review.summary}`);
      for (const issue of review.issues) {
        logger.warn(`  [${issue.file}] ${issue.comment}`);
      }

      if (iteration >= options.maxIterations) {
        logger.warn(
          `Nombre maximal d'itérations (${options.maxIterations}) atteint pour cette étape : ` +
            "application des dernières modifications malgré les réserves ci-dessus.",
        );
        return { changes: lastChanges, forcedByIterationLimit: true, reviewSkipped: false };
      }

      feedback = [review.summary, ...review.issues.map((i) => `- [${i.file}] ${i.comment}`)].join("\n");
    }

    // Inatteignable si maxIterations >= 1, gardé pour la sûreté du typage.
    return { changes: lastChanges, forcedByIterationLimit: true, reviewSkipped: false };
  }

  /**
   * Implémente une étape via GLM ; si GLM est indisponible (crédits
   * épuisés), bascule sur Claude. Si les deux échouent pour la même
   * raison, l'erreur est propagée.
   */
  private async implementStep(
    step: PlanStep,
    currentFiles: Array<{ path: string; content: string | null }>,
    feedback: string | undefined,
    iteration: number,
  ): Promise<FileChange[]> {
    const label = iteration === 1 ? "Implémentation..." : `Implémentation (correction ${iteration - 1})...`;

    if (this.glmAvailable) {
      const spinner = logger.spinner("glm", label);
      try {
        const changes = await this.glm.implementStep(step, currentFiles, feedback);
        spinner.succeed("Code généré par GLM.");
        return changes;
      } catch (err) {
        if (!isQuotaExhaustedError(err)) {
          spinner.fail("Échec de l'implémentation.");
          throw err;
        }
        this.glmAvailable = false;
        spinner.warn("GLM indisponible (crédits/quota épuisés) — Claude implémente directement cette étape.");
      }
    }

    if (this.claudeAvailable) {
      const spinner = logger.spinner("claude", `${label} (GLM indisponible)`);
      try {
        const changes = await this.claude.implementStep(step, currentFiles, feedback);
        spinner.succeed("Code généré par Claude.");
        return changes;
      } catch (err) {
        if (!isQuotaExhaustedError(err)) {
          spinner.fail("Échec de l'implémentation.");
          throw err;
        }
        this.claudeAvailable = false;
        spinner.fail("Claude également indisponible (crédits/quota épuisés).");
      }
    }

    throw new Error(
      "Impossible d'implémenter cette étape : Claude et GLM sont tous les deux indisponibles (crédits/quota épuisés).",
    );
  }

  private async readBaseline(root: string, files: string[]): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    for (const path of files) {
      const abs = resolveInRoot(root, path);
      map.set(path, await readFileIfExists(abs));
    }
    return map;
  }

  private async buildContext(options: RunOptions): Promise<ProjectContext> {
    const fileTree = await listProjectTree(options.root);

    let targetedPaths: string[] = [];
    if (options.filesGlob) {
      targetedPaths = await resolveFilesGlob(options.root, options.filesGlob);
    }

    const targetedFiles = await Promise.all(
      targetedPaths.map(async (path) => {
        const abs = resolveInRoot(options.root, path);
        const content = (await readFileIfExists(abs)) ?? "";
        return { path, content };
      }),
    );

    return { root: options.root, fileTree, targetedFiles };
  }

  private async runTests(options: RunOptions): Promise<void> {
    const spinner = logger.spinner("system", `Exécution des tests : ${options.testCommand}`);
    const result = await runCommand(options.testCommand as string, options.root);

    if (result.exitCode === 0) {
      spinner.succeed("Tests OK.");
    } else {
      spinner.fail(`Tests en échec (code ${result.exitCode ?? "inconnu"}${result.timedOut ? ", timeout" : ""}).`);
      logger.info(result.stdout);
      if (result.stderr) logger.info(result.stderr);
    }
  }
}
