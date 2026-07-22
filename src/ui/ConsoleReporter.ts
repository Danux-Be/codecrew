import type { Ora } from "ora";

import type { OrchestratorEvent } from "../orchestrator/events.js";
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
import type { Orchestrator } from "../orchestrator/Orchestrator.js";
import { logger } from "./logger.js";

/**
 * Adaptateur console : s'abonne au flux d'événements de l'Orchestrator et
 * reproduit exactement le rendu (titres, spinners, diffs colorés) que
 * l'Orchestrator produisait auparavant en appelant `logger.*` directement.
 * Utilisé par le CLI one-shot ; le TUI Ink consomme le même flux d'événements
 * indépendamment, via son propre rendu.
 */
export class ConsoleReporter {
  private currentSpinner: Ora | null = null;

  attach(orchestrator: Orchestrator): void {
    orchestrator.on("event", (e: OrchestratorEvent) => this.handle(e));
  }

  private handle(e: OrchestratorEvent): void {
    switch (e.type) {
      case "agent:activity":
        this.handleActivity(e);
        break;
      case "plan:generated":
        logger.title("Plan d'implémentation");
        logger.info(e.summary);
        for (const step of e.steps) {
          logger.info(formatPlanStepLine(step));
        }
        break;
      case "plan:empty":
        logger.warn(formatPlanEmptyText());
        break;
      case "step:start":
        logger.title(`Étape ${e.index}/${e.total} — ${e.description}`);
        break;
      case "step:diff":
        for (const diff of e.diffs) {
          logger.info(`--- diff: ${diff.path} ---`);
          logger.diff(diff.unified);
        }
        break;
      case "step:review-result":
        if (e.verdict === "request_changes") {
          for (const issue of e.issues) {
            logger.warn(formatIssueLine(issue));
          }
        }
        break;
      case "step:review-skipped":
        logger.warn(formatReviewSkippedText());
        break;
      case "step:forced":
        logger.warn(formatForcedText(e));
        break;
      case "step:complete":
        logger.success(formatStepCompleteText(e));
        break;
      case "tests:result":
        logger.info(e.stdout);
        if (e.stderr) logger.info(e.stderr);
        break;
      case "run:summary":
        logger.title("Résumé");
        logger.success(formatRunSummaryText(e));
        break;
      case "run:aborted":
        logger.warn(formatRunAbortedText(e));
        break;
      // "run:start", "agent:status", "step:awaiting-confirmation", "plan:stopped", "run:error" :
      // rien à afficher côté console au-delà de ce que gèrent déjà les autres événements
      // (le prompt de confirmation manuel et l'affichage d'erreur sont gérés ailleurs, voir cli.ts).
      default:
        break;
    }
  }

  private handleActivity(e: Extract<OrchestratorEvent, { type: "agent:activity" }>): void {
    const actor = e.actor === "ollama" ? "local" : e.actor;

    if (e.state === "start") {
      this.currentSpinner = logger.spinner(actor, e.text);
      return;
    }

    if (!this.currentSpinner) {
      if (e.state === "success") logger.success(e.text);
      else if (e.state === "warn") logger.warn(e.text);
      else logger.error(e.text);
      return;
    }

    if (e.state === "success") this.currentSpinner.succeed(e.text);
    else if (e.state === "warn") this.currentSpinner.warn(e.text);
    else this.currentSpinner.fail(e.text);
    this.currentSpinner = null;
  }
}
