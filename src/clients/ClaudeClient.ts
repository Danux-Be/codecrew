import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

import {
  ImplementationPlanSchema,
  ReviewResultSchema,
  type ImplementationPlan,
  type ReviewResult,
} from "./schemas.js";
import type { FileDiff, ProjectContext } from "./types.js";

const MAX_TREE_ENTRIES = 400;
const MAX_FILE_CHARS = 20_000;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Correspondance effort -> budget de réflexion (extended thinking).
 * "low" désactive la réflexion étendue ; les autres niveaux augmentent
 * le budget de tokens alloué au raisonnement avant la réponse finale.
 */
const THINKING_BUDGETS: Record<Effort, number | null> = {
  low: null,
  medium: 3000,
  high: 6000,
  xhigh: 12000,
  max: 20000,
};

export interface ClaudeClientOptions {
  apiKey: string;
  model: string;
  effort?: Effort;
}

/**
 * Client Claude : rôle d'architecte (découpage de la tâche en plan précis)
 * et de reviewer (relecture du code produit par GLM — edge cases, typage,
 * robustesse). Le modèle est instruit de répondre en JSON strict ; la
 * réponse est ensuite validée avec Zod côté client.
 */
export class ClaudeClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: Effort;

  constructor(opts: ClaudeClientOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.effort = opts.effort ?? "high";
  }

  async createPlan(task: string, context: ProjectContext): Promise<ImplementationPlan> {
    const system = [
      "Tu es un architecte logiciel senior et rigoureux.",
      "Ta mission : analyser le projet local et découper la tâche demandée par l'utilisateur",
      "en un plan d'implémentation précis, composé d'étapes ordonnées et actionnables.",
      "Chaque étape doit cibler des fichiers précis (chemins relatifs à la racine du projet)",
      "et contenir des instructions non ambiguës à destination d'un développeur qui écrira le code",
      "(signatures de fonctions attendues, contrats, conventions du projet existant à respecter).",
      "Ne découpe pas plus finement que nécessaire : une étape par fichier ou par groupe de fichiers",
      "fortement liés suffit généralement. Base-toi strictement sur le contexte fourni.",
      "",
      "Réponds STRICTEMENT avec un unique objet JSON valide, sans texte avant/après, sans balises",
      "markdown, respectant exactement cette forme :",
      '{"summary": string, "steps": [{"id": number, "description": string, "files": string[], "instructions": string}]}',
    ].join("\n");

    const user = this.renderContextPrompt(task, context);
    const text = await this.request(system, user, 16000);
    return this.parseJson(text, ImplementationPlanSchema, "plan d'implémentation");
  }

  async reviewChanges(
    stepDescription: string,
    stepInstructions: string,
    diffs: FileDiff[],
  ): Promise<ReviewResult> {
    const system = [
      "Tu es un reviewer de code senior, exigeant sur la robustesse.",
      "On te soumet le diff produit par un développeur pour une étape donnée d'un plan.",
      "Vérifie en priorité : les edge cases non gérés, le typage, la gestion d'erreurs pertinente",
      "(sans sur-ingénierie), la cohérence avec les instructions de l'étape, et les bugs évidents.",
      "Si tout est correct et raisonnablement robuste, verdict = 'approve'.",
      "Sinon, verdict = 'request_changes' avec des commentaires précis et actionnables",
      "(quoi corriger, dans quel fichier) — pas de remarques vagues.",
      "Ne demande pas de changements cosmétiques ou de refactoring hors périmètre de l'étape.",
      "",
      "Réponds STRICTEMENT avec un unique objet JSON valide, sans texte avant/après, sans balises",
      "markdown, respectant exactement cette forme :",
      '{"verdict": "approve"|"request_changes", "summary": string, "issues": [{"file": string, "comment": string}]}',
    ].join("\n");

    const diffsText = diffs
      .map((d) => `### ${d.path}${d.isNew ? " (nouveau fichier)" : ""}\n\`\`\`diff\n${d.unified}\n\`\`\``)
      .join("\n\n");

    const user = [
      `## Étape à relire\n${stepDescription}`,
      `## Instructions données à l'implémenteur\n${stepInstructions}`,
      `## Diff produit\n${diffsText || "(aucun changement détecté)"}`,
    ].join("\n\n");

    const text = await this.request(system, user, 8000);
    return this.parseJson(text, ReviewResultSchema, "résultat de relecture");
  }

  private async request(system: string, user: string, maxTokens: number): Promise<string> {
    const budget = THINKING_BUDGETS[this.effort];
    const effectiveMaxTokens = budget ? Math.max(maxTokens, budget + 4000) : maxTokens;

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: effectiveMaxTokens,
      ...(budget ? { thinking: { type: "enabled" as const, budget_tokens: budget } } : {}),
      system,
      messages: [{ role: "user", content: user }],
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      throw new Error("Claude a refusé de répondre à cette requête (stop_reason: refusal).");
    }

    const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) {
      throw new Error("Claude n'a retourné aucun contenu textuel exploitable.");
    }
    return textBlock.text;
  }

  private parseJson<T>(raw: string, schema: z.ZodType<T>, label: string): T {
    const candidate = extractJsonObject(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      throw new Error(
        `Réponse de Claude illisible en JSON pour le ${label} : ${(err as Error).message}\n---\n${raw.slice(0, 800)}`,
      );
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `JSON reçu de Claude invalide pour le ${label} : ${result.error.message}\n---\n${raw.slice(0, 800)}`,
      );
    }
    return result.data;
  }

  private renderContextPrompt(task: string, context: ProjectContext): string {
    const tree = context.fileTree.slice(0, MAX_TREE_ENTRIES);
    const truncatedTree =
      context.fileTree.length > MAX_TREE_ENTRIES
        ? `${tree.join("\n")}\n... (${context.fileTree.length - MAX_TREE_ENTRIES} fichiers supplémentaires non affichés)`
        : tree.join("\n");

    const filesSection = context.targetedFiles
      .map(({ path, content }) => {
        const truncated =
          content.length > MAX_FILE_CHARS
            ? `${content.slice(0, MAX_FILE_CHARS)}\n... (tronqué, ${content.length - MAX_FILE_CHARS} caractères supplémentaires)`
            : content;
        return `### ${path}\n\`\`\`\n${truncated}\n\`\`\``;
      })
      .join("\n\n");

    return [
      `## Tâche demandée\n${task}`,
      `## Racine du projet\n${context.root}`,
      `## Arborescence (extrait)\n\`\`\`\n${truncatedTree || "(vide)"}\n\`\`\``,
      filesSection ? `## Contenu des fichiers ciblés\n${filesSection}` : "## Aucun fichier explicitement ciblé",
    ].join("\n\n");
  }
}

/**
 * Extrait un objet JSON d'une réponse modèle qui peut être entourée de
 * texte ou de balises markdown malgré les instructions de format strict.
 */
function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();

  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}
