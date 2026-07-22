import Anthropic from "@anthropic-ai/sdk";

/**
 * Extrait le premier bloc de texte d'une réponse Anthropic (ou compatible
 * Anthropic, ex: GLM Coding Plan via api.z.ai/api/anthropic). Partagé entre
 * ClaudeClient et GLMClient puisque les deux parlent désormais le même
 * protocole de messages.
 */
export function extractFirstText(message: Anthropic.Message): string {
  if (message.stop_reason === "refusal") {
    throw new Error("Le modèle a refusé de répondre à cette requête (stop_reason: refusal).");
  }
  const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) {
    throw new Error("Le modèle n'a retourné aucun contenu textuel exploitable.");
  }
  return textBlock.text;
}

const QUOTA_KEYWORDS = /credit|balance|quota|insufficient|resource package|recharge|too low/i;

/**
 * Détecte si une erreur reflète un solde/quota épuisé côté fournisseur
 * (plutôt qu'une erreur de requête, d'auth ou réseau), pour déclencher le
 * repli automatique sur l'autre agent (Claude <-> GLM). Heuristique :
 * - HTTP 429 (rate limit / solde insuffisant, observé chez Anthropic et GLM/Z.ai)
 * - HTTP 400 dont le message mentionne explicitement crédit/solde/quota
 * - tout message d'erreur (y compris ré-encapsulé) contenant ces mots-clés
 * Ce n'est pas infaillible (un vrai rate-limit transitoire déclenchera aussi
 * le repli), mais c'est un compromis raisonnable : mieux vaut basculer sur
 * l'autre agent à tort que planter tout le pipeline.
 */
export function isQuotaExhaustedError(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 429) return true;
    if (err.status === 400 && QUOTA_KEYWORDS.test(err.message)) return true;
  }
  if (err instanceof Error && QUOTA_KEYWORDS.test(err.message)) return true;
  return false;
}

/**
 * Détecte une annulation volontaire (Échap dans le TUI) via `AbortSignal`,
 * pour la distinguer d'un vrai échec réseau/API et éviter de la traiter
 * comme un motif de repli Claude <-> GLM.
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}
