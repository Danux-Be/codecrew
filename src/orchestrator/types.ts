import type { Effort } from "../clients/ClaudeClient.js";
import type { RunMode } from "./events.js";

export interface RunOptions {
  /** Description de la tâche à réaliser, fournie par l'utilisateur. */
  task: string;
  /** Répertoire racine du projet (par défaut : cwd). */
  root: string;
  /** Glob optionnel pour cibler explicitement des fichiers existants comme contexte. */
  filesGlob?: string;
  /** Niveau d'effort pour Claude (plan + review). */
  effort?: Effort;
  /** Nombre max d'allers-retours GLM -> Claude par étape en cas de demande de changements. */
  maxIterations: number;
  /** Commande de test à exécuter après chaque étape validée (ex: "npm test"). */
  testCommand?: string;
  /** Si vrai, n'écrit rien sur disque : affiche seulement le plan et les diffs proposés. */
  dryRun: boolean;
  /**
   * "auto" (défaut) : comportement actuel, entièrement autonome.
   * "plan" : génère et affiche le plan puis s'arrête — aucune implémentation, aucune relecture.
   * "manual" : demande confirmation une fois par étape, avant sa première tentative d'implémentation.
   */
  mode?: RunMode;
  /** Permet d'annuler le run en cours (Échap dans le TUI) — abandonne dès le prochain point de contrôle. */
  signal?: AbortSignal;
}
