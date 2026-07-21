import type { FileChange } from "./types.js";
import type { PlanStep } from "./schemas.js";

export interface GLMClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface GLMChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface GLMChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string; code?: string };
}

const FILE_BLOCK_RE = /```file:(\S+)\r?\n([\s\S]*?)```/g;

/**
 * Client pour l'API GLM (Zhipu), compatible avec le format
 * OpenAI /chat/completions. GLM joue le rôle d'implémenteur : il reçoit
 * des instructions précises (issues du plan de Claude, éventuellement
 * enrichies de feedback de relecture) et retourne le contenu complet
 * des fichiers à écrire, dans un format balisé simple à parser.
 */
export class GLMClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: GLMClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
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

    const messages: GLMChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: userParts.join("\n\n") },
    ];

    const raw = await this.chat(messages);
    const changes = this.parseFileBlocks(raw);

    if (changes.length === 0) {
      throw new Error(
        "GLM n'a retourné aucun bloc de fichier reconnaissable (format attendu : ```file:chemin ... ```).",
      );
    }
    return changes;
  }

  private async chat(messages: GLMChatMessage[]): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
        }),
      });
    } catch (err) {
      throw new Error(`Impossible de joindre l'API GLM (${url}) : ${(err as Error).message}`);
    }

    const bodyText = await res.text();
    let body: GLMChatCompletionResponse;
    try {
      body = JSON.parse(bodyText) as GLMChatCompletionResponse;
    } catch {
      throw new Error(`Réponse GLM non-JSON (HTTP ${res.status}) : ${bodyText.slice(0, 500)}`);
    }

    if (!res.ok) {
      const msg = body.error?.message ?? bodyText.slice(0, 500);
      throw new Error(`Erreur API GLM (HTTP ${res.status}) : ${msg}`);
    }

    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Réponse GLM vide ou de forme inattendue.");
    }
    return content;
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
