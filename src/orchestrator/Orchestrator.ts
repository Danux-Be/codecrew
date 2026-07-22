import { EventEmitter } from "node:events";

import { isAbortError, isQuotaExhaustedError } from "../clients/anthropicCompat.js";
import { ClaudeClient, type TokenUsage } from "../clients/ClaudeClient.js";
import { GLMClient } from "../clients/GLMClient.js";
import type { OllamaClient } from "../clients/OllamaClient.js";
import type { ImplementationPlan, PlanStep } from "../clients/schemas.js";
import type { FileChange, ProjectContext } from "../clients/types.js";
import {
  deleteFileIfExists,
  listProjectTree,
  readFileIfExists,
  resolveFilesGlob,
  resolveInRoot,
  writeFileEnsured,
} from "../tools/fileSystem.js";
import { runCommand } from "../tools/terminal.js";
import { computeFileDiff } from "../utils/diffing.js";
import { extractMentionedFiles } from "../utils/mentions.js";
import type { OrchestratorEvent, RunMode } from "./events.js";
import type { OrchestratorHooks } from "./hooks.js";
import type { RunOptions } from "./types.js";

const MEMORY_FILENAME = "CODECREW.md";

interface StepOutcome {
  changes: FileChange[];
  forcedByIterationLimit: boolean;
  reviewSkipped: boolean;
  localUsed: boolean;
}

/** Snapshot du contenu précédent des fichiers touchés par une étape appliquée, pour /undo. */
interface Checkpoint {
  root: string;
  stepId: number;
  description: string;
  files: Array<{ path: string; previousContent: string | null }>;
}

export interface SessionStats {
  durationMs: number;
  claudeTokens: TokenUsage;
  glmTokens: TokenUsage;
}

type ImplementAgent = "local" | "glm" | "claude";

/**
 * Orchestrateur principal : fait collaborer Claude (plan + relecture) et GLM
 * (implémentation) étape par étape, avec une boucle de correction bornée
 * avant application des modifications sur le disque.
 *
 * N'écrit jamais directement dans le terminal : émet des événements
 * structurés (`OrchestratorEvent`, canal `"event"`) consommés indifféremment
 * par le rendu console one-shot (`ConsoleReporter`) ou par le TUI interactif
 * (Ink) — voir `src/orchestrator/events.ts`.
 *
 * Résilience : si l'un des deux agents tombe à court de crédit/quota en
 * cours de route, l'orchestrateur bascule automatiquement sur l'autre pour
 * le rôle concerné plutôt que d'interrompre tout le run :
 * - GLM indisponible -> Claude implémente lui-même l'étape (relecture inchangée)
 * - Claude indisponible -> GLM génère le plan et implémente, mais la
 *   relecture indépendante est désactivée pour le reste du run (GLM ne
 *   relit jamais son propre travail : ce ne serait pas une vraie relecture).
 * Si les deux agents sont indisponibles, l'erreur est propagée normalement.
 *
 * 3ème agent optionnel (Ollama, local) : utilisé de façon opportuniste pour
 * les étapes marquées 'trivial' par l'architecte, afin d'économiser des
 * tokens Claude/GLM sur les tâches purement mécaniques. Toute panne locale
 * (modèle non installé, service arrêté, réponse invalide) déclenche un
 * repli silencieux sur GLM (puis Claude) — jamais un échec du run.
 *
 * Modes (`RunOptions.mode`, défaut "auto") :
 * - "auto" : comportement ci-dessus, entièrement autonome.
 * - "plan" : génère et affiche le plan puis s'arrête (aucun appel
 *   implémentation/relecture).
 * - "manual" : demande confirmation une fois par étape (via
 *   `hooks.confirmStep`), avant sa première tentative d'implémentation ;
 *   la boucle de correction interne à l'étape n'est jamais re-confirmée.
 */
export class Orchestrator extends EventEmitter {
  private claudeAvailable = true;
  private glmAvailable = true;
  private ollamaAvailable: boolean;

  /** Pile de snapshots pour /undo — un par étape appliquée (ni dry-run, ni "plan"). */
  private checkpoints: Checkpoint[] = [];

  /** Cumul depuis le début de la session (survit aux changements de modèle via /model), pour /cost. */
  private sessionStats: SessionStats = {
    durationMs: 0,
    claudeTokens: { inputTokens: 0, outputTokens: 0 },
    glmTokens: { inputTokens: 0, outputTokens: 0 },
  };

  constructor(
    private claude: ClaudeClient,
    private glm: GLMClient,
    private ollama?: OllamaClient,
  ) {
    super();
    this.ollamaAvailable = Boolean(ollama);
  }

  private send(event: OrchestratorEvent): void {
    this.emit("event", event);
  }

  getSessionStats(): SessionStats {
    return {
      durationMs: this.sessionStats.durationMs,
      claudeTokens: { ...this.sessionStats.claudeTokens },
      glmTokens: { ...this.sessionStats.glmTokens },
    };
  }

  /**
   * Annule la dernière étape appliquée (restaure le contenu précédent des
   * fichiers touchés, ou les supprime s'ils ont été créés) — un snapshot
   * par étape, en mémoire pour la durée de la session. Rappeler plusieurs
   * fois annule les étapes précédentes une par une, dans l'ordre inverse.
   */
  async undoLast(): Promise<{ stepId: number; description: string; files: string[] } | null> {
    const checkpoint = this.checkpoints.pop();
    if (!checkpoint) {
      this.send({ type: "undo:empty" });
      return null;
    }
    for (const f of checkpoint.files) {
      const abs = resolveInRoot(checkpoint.root, f.path);
      if (f.previousContent === null) {
        await deleteFileIfExists(abs);
      } else {
        await writeFileEnsured(abs, f.previousContent);
      }
    }
    const result = { stepId: checkpoint.stepId, description: checkpoint.description, files: checkpoint.files.map((f) => f.path) };
    this.send({ type: "undo:done", ...result });
    return result;
  }

  /**
   * Remplace le client d'un agent en cours de session (ex: changement de
   * modèle via `/model` dans le TUI) sans recréer l'Orchestrator — le
   * transcript et les autres statuts d'agents sont préservés. Réinitialise
   * l'agent concerné comme disponible (nouvelle instance de client).
   */
  setClaudeClient(client: ClaudeClient): void {
    this.claude = client;
    this.claudeAvailable = true;
    this.send({ type: "agent:status", agent: "claude", status: "available" });
  }

  setGlmClient(client: GLMClient): void {
    this.glm = client;
    this.glmAvailable = true;
    this.send({ type: "agent:status", agent: "glm", status: "available" });
  }

  setOllamaClient(client: OllamaClient | undefined): void {
    this.ollama = client;
    this.ollamaAvailable = Boolean(client);
    this.send({ type: "agent:status", agent: "ollama", status: client ? "available" : "not-configured" });
  }

  async run(options: RunOptions, hooks?: OrchestratorHooks): Promise<void> {
    const mode: RunMode = options.mode ?? "auto";
    if (mode === "manual" && !hooks?.confirmStep) {
      throw new Error("Le mode manuel nécessite une confirmation utilisateur (hooks.confirmStep manquant).");
    }

    const stats = {
      startedAt: Date.now(),
      claudeUsageBefore: this.claude.getUsage(),
      glmUsageBefore: this.glm.getUsage(),
    };

    try {
      await this.runInner(options, mode, stats, hooks);
    } catch (err) {
      if (isAbortError(err)) {
        this.send({ type: "run:cancelled" });
        return;
      }
      throw err;
    } finally {
      // Toujours cumulé, même sur annulation/erreur : les tokens déjà
      // consommés avant l'interruption comptent pour /cost.
      const claudeAfter = this.claude.getUsage();
      const glmAfter = this.glm.getUsage();
      this.sessionStats.durationMs += Date.now() - stats.startedAt;
      this.sessionStats.claudeTokens.inputTokens += claudeAfter.inputTokens - stats.claudeUsageBefore.inputTokens;
      this.sessionStats.claudeTokens.outputTokens += claudeAfter.outputTokens - stats.claudeUsageBefore.outputTokens;
      this.sessionStats.glmTokens.inputTokens += glmAfter.inputTokens - stats.glmUsageBefore.inputTokens;
      this.sessionStats.glmTokens.outputTokens += glmAfter.outputTokens - stats.glmUsageBefore.outputTokens;
    }
  }

  private async runInner(
    options: RunOptions,
    mode: RunMode,
    stats: { startedAt: number; claudeUsageBefore: TokenUsage; glmUsageBefore: TokenUsage },
    hooks?: OrchestratorHooks,
  ): Promise<void> {
    this.send({ type: "run:start", task: options.task, mode });
    this.send({
      type: "agent:status",
      agent: "claude",
      status: this.claudeAvailable ? "available" : "unavailable",
    });
    this.send({ type: "agent:status", agent: "glm", status: this.glmAvailable ? "available" : "unavailable" });
    this.send({
      type: "agent:status",
      agent: "ollama",
      status: !this.ollama ? "not-configured" : this.ollamaAvailable ? "available" : "unavailable",
    });

    const context = await this.buildContext(options);
    const plan = await this.generatePlan(options.task, context, options.signal);

    this.send({ type: "plan:generated", summary: plan.summary, steps: plan.steps });

    if (plan.steps.length === 0) {
      this.send({ type: "plan:empty" });
      return;
    }

    if (mode === "plan") {
      this.send({ type: "plan:stopped" });
      return;
    }

    let totalApplied = 0;
    let totalForced = 0;
    let totalUnreviewed = 0;
    let totalLocal = 0;

    for (const [i, step] of plan.steps.entries()) {
      options.signal?.throwIfAborted();
      const index = i + 1;
      const total = plan.steps.length;
      this.send({ type: "step:start", stepId: step.id, index, total, description: step.description, files: step.files });

      if (mode === "manual") {
        this.send({ type: "step:awaiting-confirmation", stepId: step.id, index, total });
        const proceed = await hooks!.confirmStep({ step, index, total });
        if (!proceed) {
          this.send({ type: "run:aborted", atStep: step.id });
          return;
        }
      }

      const baseline = await this.readBaseline(options.root, step.files);
      const outcome = await this.implementStepWithReview(step, baseline, options);

      if (!options.dryRun) {
        this.checkpoints.push({
          root: options.root,
          stepId: step.id,
          description: step.description,
          files: outcome.changes.map((c) => ({ path: c.path, previousContent: baseline.get(c.path) ?? null })),
        });
        for (const change of outcome.changes) {
          const abs = resolveInRoot(options.root, change.path);
          await writeFileEnsured(abs, change.content);
        }
      }

      totalApplied += outcome.changes.length;
      if (outcome.forcedByIterationLimit) totalForced += 1;
      if (outcome.reviewSkipped) totalUnreviewed += 1;
      if (outcome.localUsed) totalLocal += 1;

      this.send({
        type: "step:complete",
        stepId: step.id,
        index,
        total,
        changesCount: outcome.changes.length,
        dryRun: options.dryRun,
      });
    }

    if (options.testCommand && !options.dryRun) {
      await this.runTests(options);
    }

    const claudeUsageAfter = this.claude.getUsage();
    const glmUsageAfter = this.glm.getUsage();
    const runDurationMs = Date.now() - stats.startedAt;
    const runClaudeTokens = {
      input: claudeUsageAfter.inputTokens - stats.claudeUsageBefore.inputTokens,
      output: claudeUsageAfter.outputTokens - stats.claudeUsageBefore.outputTokens,
    };
    const runGlmTokens = {
      input: glmUsageAfter.inputTokens - stats.glmUsageBefore.inputTokens,
      output: glmUsageAfter.outputTokens - stats.glmUsageBefore.outputTokens,
    };

    this.send({
      type: "run:summary",
      totalSteps: plan.steps.length,
      totalApplied,
      totalForced,
      totalUnreviewed,
      totalLocal,
      durationMs: runDurationMs,
      claudeTokens: runClaudeTokens,
      glmTokens: runGlmTokens,
    });
  }

  /**
   * Génère le plan via Claude ; si Claude est indisponible (crédits
   * épuisés), bascule sur GLM. Si les deux échouent pour la même raison,
   * l'erreur est propagée.
   */
  private async generatePlan(task: string, context: ProjectContext, signal?: AbortSignal): Promise<ImplementationPlan> {
    if (this.claudeAvailable) {
      this.send({ type: "agent:activity", actor: "claude", phase: "plan", state: "start", text: "Analyse du projet et génération du plan d'implémentation..." });
      try {
        const plan = await this.claude.createPlan(task, context, signal);
        this.send({ type: "agent:activity", actor: "claude", phase: "plan", state: "success", text: "Plan généré par Claude." });
        return plan;
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (!isQuotaExhaustedError(err)) {
          this.send({ type: "agent:activity", actor: "claude", phase: "plan", state: "error", text: "Échec de la génération du plan." });
          throw err;
        }
        this.claudeAvailable = false;
        this.send({ type: "agent:status", agent: "claude", status: "unavailable", reason: "quota" });
        this.send({
          type: "agent:activity",
          actor: "claude",
          phase: "plan",
          state: "warn",
          text: "Claude indisponible (crédits/quota épuisés) — bascule sur GLM pour le plan et la suite du run. Aucune relecture indépendante ne sera possible tant que Claude reste indisponible.",
        });
      }
    }

    if (this.glmAvailable) {
      this.send({ type: "agent:activity", actor: "glm", phase: "plan", state: "start", text: "Génération du plan d'implémentation (Claude indisponible)..." });
      try {
        const plan = await this.glm.createPlan(task, context, signal);
        this.send({ type: "agent:activity", actor: "glm", phase: "plan", state: "success", text: "Plan généré par GLM." });
        return plan;
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (!isQuotaExhaustedError(err)) {
          this.send({ type: "agent:activity", actor: "glm", phase: "plan", state: "error", text: "Échec de la génération du plan." });
          throw err;
        }
        this.glmAvailable = false;
        this.send({ type: "agent:status", agent: "glm", status: "unavailable", reason: "quota" });
        this.send({ type: "agent:activity", actor: "glm", phase: "plan", state: "error", text: "GLM également indisponible (crédits/quota épuisés)." });
      }
    }

    const message = "Impossible de générer un plan : Claude et GLM sont tous les deux indisponibles (crédits/quota épuisés).";
    this.send({ type: "run:error", message });
    throw new Error(message);
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
    let localUsed = false;

    for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
      options.signal?.throwIfAborted();
      const currentFiles = step.files.map((path) => ({ path, content: baseline.get(path) ?? null }));
      const { changes, agent } = await this.implementStep(step, currentFiles, feedback, iteration, options.signal);
      lastChanges = changes;
      if (agent === "local") localUsed = true;

      const diffs = changes.map((c) => computeFileDiff(c.path, baseline.get(c.path) ?? null, c.content));
      this.send({ type: "step:diff", stepId: step.id, iteration, diffs });

      if (!this.claudeAvailable) {
        this.send({ type: "step:review-skipped", stepId: step.id, reason: "claude-unavailable" });
        return { changes, forcedByIterationLimit: false, reviewSkipped: true, localUsed };
      }

      this.send({ type: "agent:activity", actor: "claude", phase: "review", state: "start", text: "Relecture du code..." });
      let review;
      try {
        review = await this.claude.reviewChanges(step.description, step.instructions, diffs, options.signal);
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (!isQuotaExhaustedError(err)) {
          this.send({ type: "agent:activity", actor: "claude", phase: "review", state: "error", text: "Échec de la relecture." });
          throw err;
        }
        this.claudeAvailable = false;
        this.send({ type: "agent:status", agent: "claude", status: "unavailable", reason: "quota" });
        this.send({
          type: "agent:activity",
          actor: "claude",
          phase: "review",
          state: "warn",
          text: "Claude devenu indisponible (crédits/quota épuisés) pendant la relecture.",
        });
        this.send({ type: "step:review-skipped", stepId: step.id, reason: "claude-unavailable" });
        return { changes, forcedByIterationLimit: false, reviewSkipped: true, localUsed };
      }

      if (review.verdict === "approve") {
        this.send({
          type: "agent:activity",
          actor: "claude",
          phase: "review",
          state: "success",
          text: `Approuvé — ${review.summary}`,
        });
        this.send({
          type: "step:review-result",
          stepId: step.id,
          iteration,
          verdict: "approve",
          summary: review.summary,
          issues: review.issues,
        });
        return { changes, forcedByIterationLimit: false, reviewSkipped: false, localUsed };
      }

      this.send({
        type: "agent:activity",
        actor: "claude",
        phase: "review",
        state: "warn",
        text: `Changements demandés — ${review.summary}`,
      });
      this.send({
        type: "step:review-result",
        stepId: step.id,
        iteration,
        verdict: "request_changes",
        summary: review.summary,
        issues: review.issues,
      });

      if (iteration >= options.maxIterations) {
        this.send({ type: "step:forced", stepId: step.id, maxIterations: options.maxIterations });
        return { changes: lastChanges, forcedByIterationLimit: true, reviewSkipped: false, localUsed };
      }

      feedback = [review.summary, ...review.issues.map((i) => `- [${i.file}] ${i.comment}`)].join("\n");
    }

    // Inatteignable si maxIterations >= 1, gardé pour la sûreté du typage.
    return { changes: lastChanges, forcedByIterationLimit: true, reviewSkipped: false, localUsed };
  }

  /**
   * Implémente une étape. Ordre de préférence :
   * 1. Ollama (agent local), uniquement si l'étape est marquée 'trivial'
   *    par l'architecte — toute panne locale déclenche un repli silencieux
   *    sur GLM, sans marquer GLM indisponible.
   * 2. GLM (rôle nominal) ; si indisponible (crédits/quota épuisés),
   *    bascule sur Claude.
   * Si Claude et GLM échouent tous deux pour la même raison, l'erreur est
   * propagée.
   */
  private async implementStep(
    step: PlanStep,
    currentFiles: Array<{ path: string; content: string | null }>,
    feedback: string | undefined,
    iteration: number,
    signal?: AbortSignal,
  ): Promise<{ changes: FileChange[]; agent: ImplementAgent }> {
    const label = iteration === 1 ? "Implémentation..." : `Implémentation (correction ${iteration - 1})...`;

    if (this.ollama && this.ollamaAvailable && step.complexity === "trivial") {
      this.send({ type: "agent:activity", actor: "ollama", phase: "implement", state: "start", text: `${label} (étape triviale)` });
      try {
        const changes = await this.ollama.implementStep(step, currentFiles, feedback, signal);
        this.send({ type: "agent:activity", actor: "ollama", phase: "implement", state: "success", text: "Code généré localement (Ollama)." });
        return { changes, agent: "local" };
      } catch (err) {
        if (isAbortError(err)) throw err;
        this.ollamaAvailable = false;
        this.send({ type: "agent:status", agent: "ollama", status: "unavailable", reason: "runtime-error" });
        this.send({
          type: "agent:activity",
          actor: "ollama",
          phase: "implement",
          state: "warn",
          text: `Agent local en échec (${(err as Error).message}) — repli sur GLM pour le reste du run.`,
        });
      }
    }

    if (this.glmAvailable) {
      this.send({ type: "agent:activity", actor: "glm", phase: "implement", state: "start", text: label });
      try {
        const changes = await this.glm.implementStep(step, currentFiles, feedback, signal);
        this.send({ type: "agent:activity", actor: "glm", phase: "implement", state: "success", text: "Code généré par GLM." });
        return { changes, agent: "glm" };
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (!isQuotaExhaustedError(err)) {
          this.send({ type: "agent:activity", actor: "glm", phase: "implement", state: "error", text: "Échec de l'implémentation." });
          throw err;
        }
        this.glmAvailable = false;
        this.send({ type: "agent:status", agent: "glm", status: "unavailable", reason: "quota" });
        this.send({
          type: "agent:activity",
          actor: "glm",
          phase: "implement",
          state: "warn",
          text: "GLM indisponible (crédits/quota épuisés) — Claude implémente directement cette étape.",
        });
      }
    }

    if (this.claudeAvailable) {
      this.send({ type: "agent:activity", actor: "claude", phase: "implement", state: "start", text: `${label} (GLM indisponible)` });
      try {
        const changes = await this.claude.implementStep(step, currentFiles, feedback, signal);
        this.send({ type: "agent:activity", actor: "claude", phase: "implement", state: "success", text: "Code généré par Claude." });
        return { changes, agent: "claude" };
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (!isQuotaExhaustedError(err)) {
          this.send({ type: "agent:activity", actor: "claude", phase: "implement", state: "error", text: "Échec de l'implémentation." });
          throw err;
        }
        this.claudeAvailable = false;
        this.send({ type: "agent:status", agent: "claude", status: "unavailable", reason: "quota" });
        this.send({ type: "agent:activity", actor: "claude", phase: "implement", state: "error", text: "Claude également indisponible (crédits/quota épuisés)." });
      }
    }

    const message = "Impossible d'implémenter cette étape : Claude et GLM sont tous les deux indisponibles (crédits/quota épuisés).";
    this.send({ type: "run:error", message });
    throw new Error(message);
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

    const globPaths = options.filesGlob ? await resolveFilesGlob(options.root, options.filesGlob) : [];
    const mentionedPaths = extractMentionedFiles(options.task);
    const targetedPaths = [...new Set([...globPaths, ...mentionedPaths])];

    const targetedFiles = (
      await Promise.all(
        targetedPaths.map(async (path) => {
          try {
            const abs = resolveInRoot(options.root, path);
            const content = await readFileIfExists(abs);
            return content === null ? null : { path, content };
          } catch {
            // Mention `@chemin` invalide ou hors racine (ex: @../secret) : ignorée silencieusement,
            // comme un glob --files qui ne matche rien.
            return null;
          }
        }),
      )
    ).filter((f): f is { path: string; content: string } => f !== null);

    const memory = await readFileIfExists(resolveInRoot(options.root, MEMORY_FILENAME));

    return { root: options.root, fileTree, targetedFiles, memory: memory ?? undefined };
  }

  private async runTests(options: RunOptions): Promise<void> {
    this.send({ type: "agent:activity", actor: "system", phase: "test", state: "start", text: `Exécution des tests : ${options.testCommand}` });
    const result = await runCommand(options.testCommand as string, options.root);

    this.send({
      type: "agent:activity",
      actor: "system",
      phase: "test",
      state: result.exitCode === 0 ? "success" : "error",
      text:
        result.exitCode === 0
          ? "Tests OK."
          : `Tests en échec (code ${result.exitCode ?? "inconnu"}${result.timedOut ? ", timeout" : ""}).`,
    });
    this.send({
      type: "tests:result",
      command: options.testCommand as string,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
}
