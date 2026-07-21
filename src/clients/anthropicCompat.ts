import type Anthropic from "@anthropic-ai/sdk";

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
