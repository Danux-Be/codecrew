import type { PlanStep, ReviewResult } from "../clients/schemas.js";
import type { OrchestratorEvent } from "./events.js";

/**
 * Formatage textuel pur (aucune couleur, aucun import chalk/ora/Ink) partagé
 * entre le rendu console (ConsoleReporter) et le TUI interactif, pour que
 * le libellé exact ne diverge jamais entre les deux.
 */

export function formatPlanStepLine(step: PlanStep): string {
  return `  ${step.id}. ${step.description}  [${step.files.join(", ")}]`;
}

export function formatIssueLine(issue: ReviewResult["issues"][number]): string {
  return `  [${issue.file}] ${issue.comment}`;
}

export function formatStepCompleteText(e: Extract<OrchestratorEvent, { type: "step:complete" }>): string {
  return e.dryRun
    ? `Étape ${e.stepId} : ${e.changesCount} fichier(s) proposé(s) (mode dry-run, rien écrit sur disque).`
    : `Étape ${e.stepId} : ${e.changesCount} fichier(s) appliqué(s).`;
}

export function formatForcedText(e: Extract<OrchestratorEvent, { type: "step:forced" }>): string {
  return (
    `Nombre maximal d'itérations (${e.maxIterations}) atteint pour cette étape : ` +
    "application des dernières modifications malgré les réserves ci-dessus."
  );
}

export function formatReviewSkippedText(): string {
  return "Étape appliquée sans relecture indépendante (Claude indisponible).";
}

export function formatRunAbortedText(e: Extract<OrchestratorEvent, { type: "run:aborted" }>): string {
  return `Run interrompu : étape ${e.atStep} refusée par l'utilisateur (mode manuel).`;
}

export function formatPlanEmptyText(): string {
  return "Le plan ne contient aucune étape. Rien à faire.";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const min = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return `${min} min ${rest} s`;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function formatRunSummaryText(e: Extract<OrchestratorEvent, { type: "run:summary" }>): string {
  const notes: string[] = [];
  if (e.totalForced > 0) {
    notes.push(`${e.totalForced} étape(s) appliquée(s) malgré des réserves (limite d'itérations atteinte)`);
  }
  if (e.totalUnreviewed > 0) {
    notes.push(`${e.totalUnreviewed} étape(s) appliquée(s) sans relecture indépendante (Claude indisponible)`);
  }
  if (e.totalLocal > 0) {
    notes.push(`${e.totalLocal} étape(s) implémentée(s) localement (Ollama)`);
  }
  const base =
    `${e.totalSteps} étape(s) traitée(s), ${e.totalApplied} fichier(s) touché(s)` +
    (notes.length > 0 ? `, dont ${notes.join(", ")}.` : ".");

  const costParts: string[] = [`⏱ ${formatDuration(e.durationMs)}`];
  if (e.claudeTokens.input > 0 || e.claudeTokens.output > 0) {
    costParts.push(`Claude ${formatTokens(e.claudeTokens.input)} in / ${formatTokens(e.claudeTokens.output)} out`);
  }
  if (e.glmTokens.input > 0 || e.glmTokens.output > 0) {
    costParts.push(`GLM ${formatTokens(e.glmTokens.input)} in / ${formatTokens(e.glmTokens.output)} out`);
  }

  return `${base}\n${costParts.join(" · ")}`;
}

export function formatRunCancelledText(): string {
  return "Tâche annulée par l'utilisateur (Échap).";
}

export function formatUndoDoneText(e: Extract<OrchestratorEvent, { type: "undo:done" }>): string {
  return `Annulé — étape ${e.stepId} (${e.description}) : ${e.files.join(", ")} restauré(s).`;
}

export function formatUndoEmptyText(): string {
  return "Rien à annuler.";
}
