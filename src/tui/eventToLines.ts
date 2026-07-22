import {
  formatForcedText,
  formatIssueLine,
  formatPlanEmptyText,
  formatPlanStepLine,
  formatReviewSkippedText,
  formatRunAbortedText,
  formatRunSummaryText,
  formatStepCompleteText,
} from "../orchestrator/eventFormatting.js";
import type { OrchestratorEvent } from "../orchestrator/events.js";
import type { TranscriptLine } from "./types.js";

let nextId = 0;

function line(text: string, kind: TranscriptLine["kind"]): TranscriptLine {
  return { id: String(nextId++), text, kind };
}

function classifyDiffLine(l: string): TranscriptLine["kind"] {
  if (l.startsWith("+") && !l.startsWith("+++")) return "diff-add";
  if (l.startsWith("-") && !l.startsWith("---")) return "diff-del";
  return "diff-context";
}

/**
 * Convertit un événement "settled" (plan, étape terminée, diff, résumé...)
 * en lignes de transcript affichables. Les événements d'activité en cours
 * ("agent:activity" à l'état "start") ne produisent pas de ligne ici — ils
 * pilotent l'indicateur "current" géré par le reducer (useOrchestratorEvents).
 */
export function eventToLines(e: OrchestratorEvent): TranscriptLine[] {
  switch (e.type) {
    case "plan:generated":
      return [
        line("Plan d'implémentation", "title"),
        line(e.summary, "info"),
        ...e.steps.map((s) => line(formatPlanStepLine(s), "info")),
      ];
    case "plan:empty":
      return [line(formatPlanEmptyText(), "warn")];
    case "step:start":
      return [line(`Étape ${e.index}/${e.total} — ${e.description}`, "title")];
    case "step:diff":
      return e.diffs.flatMap((d) => [
        line(`--- diff: ${d.path} ---`, "diff-header"),
        ...d.unified.split("\n").map((l) => line(l, classifyDiffLine(l))),
      ]);
    case "step:review-result":
      return e.verdict === "request_changes" ? e.issues.map((i) => line(formatIssueLine(i), "warn")) : [];
    case "step:review-skipped":
      return [line(formatReviewSkippedText(), "warn")];
    case "step:forced":
      return [line(formatForcedText(e), "warn")];
    case "step:complete":
      return [line(formatStepCompleteText(e), "success")];
    case "run:summary":
      return [line("Résumé", "title"), line(formatRunSummaryText(e), "success")];
    case "run:aborted":
      return [line(formatRunAbortedText(e), "warn")];
    case "run:error":
      return [line(e.message, "error")];
    case "agent:activity":
      return e.state === "start"
        ? []
        : [line(e.text, e.state === "success" ? "success" : e.state === "warn" ? "warn" : "error")];
    case "tests:result":
      return e.stdout ? e.stdout.split("\n").map((l) => line(l, "info")) : [];
    default:
      return [];
  }
}
