import prompts from "prompts";

import type { StepConfirmationRequest } from "../orchestrator/hooks.js";

/**
 * Confirmation d'étape (mode manuel) pour le CLI one-shot, via un prompt
 * oui/non dans un vrai terminal interactif. Annuler (Ctrl+C/Esc) est
 * interprété comme un refus, pas comme un arrêt brutal du processus.
 */
export function createCliConfirmStep(): (request: StepConfirmationRequest) => Promise<boolean> {
  return async ({ step, index, total }: StepConfirmationRequest) => {
    const answer = await prompts({
      type: "confirm",
      name: "go",
      message: `Implémenter l'étape ${index}/${total} — ${step.description} ?`,
      initial: true,
    });
    return answer.go === true;
  };
}
