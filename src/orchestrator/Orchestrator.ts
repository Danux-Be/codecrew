import { ClaudeClient } from "../clients/ClaudeClient.js";
import { GLMClient } from "../clients/GLMClient.js";
import type { FileChange, ProjectContext } from "../clients/types.js";
import type { PlanStep } from "../clients/schemas.js";
import { listProjectTree, readFileIfExists, resolveFilesGlob, resolveInRoot, writeFileEnsured } from "../tools/fileSystem.js";
import { runCommand } from "../tools/terminal.js";
import { computeFileDiff } from "../utils/diffing.js";
import { logger } from "../ui/logger.js";
import type { RunOptions } from "./types.js";

/**
 * Orchestrateur principal : fait collaborer Claude (plan + relecture) et GLM
 * (implémentation) étape par étape, avec une boucle de correction bornée
 * avant application des modifications sur le disque.
 */
export class Orchestrator {
  constructor(
    private readonly claude: ClaudeClient,
    private readonly glm: GLMClient,
  ) {}

  async run(options: RunOptions): Promise<void> {
    const context = await this.buildContext(options);

    let planSpinner = logger.spinner("claude", "Analyse du projet et génération du plan d'implémentation...");
    const plan = await this.claude.createPlan(options.task, context);
    planSpinner.succeed("Plan généré.");

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

    for (const step of plan.steps) {
      logger.title(`Étape ${step.id}/${plan.steps.length} — ${step.description}`);

      const baseline = await this.readBaseline(options.root, step.files);
      const { changes, forced } = await this.implementStepWithReview(step, baseline, options);

      if (!options.dryRun) {
        for (const change of changes) {
          const abs = resolveInRoot(options.root, change.path);
          await writeFileEnsured(abs, change.content);
        }
      }

      totalApplied += changes.length;
      if (forced) totalForced += 1;

      logger.success(
        options.dryRun
          ? `Étape ${step.id} : ${changes.length} fichier(s) proposé(s) (mode dry-run, rien écrit sur disque).`
          : `Étape ${step.id} : ${changes.length} fichier(s) appliqué(s).`,
      );
    }

    if (options.testCommand && !options.dryRun) {
      await this.runTests(options);
    }

    logger.title("Résumé");
    logger.success(
      `${plan.steps.length} étape(s) traitée(s), ${totalApplied} fichier(s) touché(s)` +
        (totalForced > 0 ? `, dont ${totalForced} appliqué(s) malgré des réserves de Claude (limite d'itérations atteinte).` : "."),
    );
  }

  /**
   * Boucle GLM (implémentation) -> Claude (relecture) pour une étape donnée,
   * avec un nombre maximal d'itérations en cas de demande de changements.
   */
  private async implementStepWithReview(
    step: PlanStep,
    baseline: Map<string, string | null>,
    options: RunOptions,
  ): Promise<{ changes: FileChange[]; forced: boolean }> {
    let feedback: string | undefined;
    let lastChanges: FileChange[] = [];

    for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
      const label = iteration === 1 ? "Implémentation..." : `Implémentation (correction ${iteration - 1})...`;
      const glmSpinner = logger.spinner("glm", label);

      const currentFiles = step.files.map((path) => ({ path, content: baseline.get(path) ?? null }));
      const changes = await this.glm.implementStep(step, currentFiles, feedback);
      glmSpinner.succeed("Code généré.");
      lastChanges = changes;

      const diffs = changes.map((c) => computeFileDiff(c.path, baseline.get(c.path) ?? null, c.content));
      for (const diff of diffs) {
        logger.info(`--- diff: ${diff.path} ---`);
        logger.diff(diff.unified);
      }

      const reviewSpinner = logger.spinner("claude", "Relecture du code...");
      const review = await this.claude.reviewChanges(step.description, step.instructions, diffs);

      if (review.verdict === "approve") {
        reviewSpinner.succeed(`Approuvé — ${review.summary}`);
        return { changes, forced: false };
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
        return { changes: lastChanges, forced: true };
      }

      feedback = [review.summary, ...review.issues.map((i) => `- [${i.file}] ${i.comment}`)].join("\n");
    }

    // Inatteignable si maxIterations >= 1, gardé pour la sûreté du typage.
    return { changes: lastChanges, forced: true };
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
