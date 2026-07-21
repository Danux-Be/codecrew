import Anthropic from "@anthropic-ai/sdk";

import { extractFirstText } from "./anthropicCompat.js";
import type { FileChange } from "./types.js";
import type { PlanStep } from "./schemas.js";

export interface GLMClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const FILE_BLOCK_RE = /```file:(\S+)\r?\n([\s\S]*?)```/g;

/**
 * Client pour GLM en tant qu'implémenteur. GLM (Zhipu/Z.ai) expose un
 * endpoint compatible avec le protocole Anthropic (ex: le GLM Coding Plan
 * via `https://api.z.ai/api/anthropic`) — on réutilise donc le SDK Anthropic
 * lui-même, avec une authentification par jeton porteur (`authToken`) plutôt
 * que par `x-api-key`, et le modèle GLM passé directement dans `model`.
 *
 * GLM reçoit des instructions précises (issues du plan de Claude,
 * éventuellement enrichies de feedback de relecture) et retourne le contenu
 * complet des fichiers à écrire, dans un format balisé simple à parser.
 */
export class GLMClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: GLMClientOptions) {
    this.client = new Anthropic({ authToken: opts.apiKey, baseURL: opts.baseUrl });
    this.model = opts.model;
  }

  async implementStep(
    step: PlanStep,
    currentFiles: Array<{ path: string; content: string | null }>,
    feedback?: string,
  ): Promise<FileChange[]> {
    const system = [
      "Tu es un développeur qui implémente du code rapidement et correctement,",
      "à partir d'instructions précises fournies par un architecte logiciel.",
      "Réponds UNIQUEMENT avec le contenu complet des fichiers à créer ou modifier,",
      "un bloc par fichier, sous EXACTEMENT ce format (rien avant, rien après) :",
      "```file:chemin/relatif/du/fichier.ext",
      "<contenu intégral du fichier>",
      "```",
      "Toujours donner le contenu ENTIER du fichier (pas un extrait, pas un diff).",
      "N'ajoute aucune explication, aucun texte en dehors de ces blocs.",
    ].join("\n");

    const filesContext = currentFiles
      .map(({ path, content }) =>
        content === null
          ? `### ${path}\n(fichier n'existe pas encore — à créer)`
          : `### ${path} (contenu actuel)\n\`\`\`\n${content}\n\`\`\``,
      )
      .join("\n\n");

    const userParts = [
      `## Étape\n${step.description}`,
      `## Instructions\n${step.instructions}`,
      `## Fichiers concernés\n${step.files.join(", ")}`,
      filesContext,
    ];

    if (feedback) {
      userParts.push(
        `## Retour de relecture à corriger impérativement\n${feedback}\n\nRéécris le(s) fichier(s) concerné(s) en tenant compte de ce retour.`,
      );
    }

    let raw: string;
    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content: userParts.join("\n\n") }],
      });
      const message = await stream.finalMessage();
      raw = extractFirstText(message);
    } catch (err) {
      throw new Error(`Erreur lors de l'appel à GLM : ${(err as Error).message}`);
    }

    const changes = this.parseFileBlocks(raw);
    if (changes.length === 0) {
      throw new Error(
        "GLM n'a retourné aucun bloc de fichier reconnaissable (format attendu : ```file:chemin ... ```).",
      );
    }
    return changes;
  }

  private parseFileBlocks(raw: string): FileChange[] {
    const changes: FileChange[] = [];
    for (const match of raw.matchAll(FILE_BLOCK_RE)) {
      const path = match[1]?.trim();
      const content = match[2];
      if (path && content !== undefined) {
        changes.push({ path, content });
      }
    }
    return changes;
  }
}
