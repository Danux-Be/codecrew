import type { PlanStep } from "../clients/schemas.js";

export interface StepConfirmationRequest {
  step: PlanStep;
  index: number;
  total: number;
}

/**
 * Points d'accroche fournis par l'appelant (CLI one-shot ou TUI Ink) pour
 * les décisions qui nécessitent une réponse utilisateur bloquante — ce que
 * le flux d'événements (fire-and-forget) ne peut pas exprimer.
 */
export interface OrchestratorHooks {
  /**
   * Appelé une seule fois par étape en mode "manual", avant la première
   * tentative d'implémentation de cette étape (jamais re-demandé pendant
   * la boucle de correction interne). Résoudre `true` pour continuer,
   * `false` pour interrompre le run.
   */
  confirmStep(request: StepConfirmationRequest): Promise<boolean>;
}
