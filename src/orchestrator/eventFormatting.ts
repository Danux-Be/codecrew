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
  return (
    `${e.totalSteps} étape(s) traitée(s), ${e.totalApplied} fichier(s) touché(s)` +
    (notes.length > 0 ? `, dont ${notes.join(", ")}.` : ".")
  );
}
