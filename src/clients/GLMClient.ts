import Anthropic from "@anthropic-ai/sdk";

import { extractFirstText } from "./anthropicCompat.js";
import { parseFileBlocks, parseJsonWithSchema } from "./parsing.js";
import {
  buildImplementUserPrompt,
  buildPlanUserPrompt,
  IMPLEMENT_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
} from "./prompts.js";
import { ImplementationPlanSchema, type ImplementationPlan } from "./schemas.js";
import type { PlanStep } from "./schemas.js";
import type { FileChange, ProjectContext } from "./types.js";

export interface GLMClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * Client pour GLM en tant qu'implémenteur (rôle nominal). GLM (Zhipu/Z.ai)
 * expose un endpoint compatible avec le protocole Anthropic (ex: le GLM
 * Coding Plan via `https://api.z.ai/api/anthropic`) — on réutilise donc le
 * SDK Anthropic lui-même, avec une authentification par jeton porteur
 * (`authToken`) plutôt que par `x-api-key`, et le modèle GLM passé
 * directement dans `model`.
 *
 * Expose aussi `createPlan`, utilisé uniquement en repli lorsque Claude est
 * indisponible (crédits épuisés), pour que codecrew reste fonctionnel avec
 * un seul agent. Dans ce mode dégradé, aucune relecture indépendante n'est
 * possible (elle nécessite Claude) : l'orchestrateur en informe l'utilisateur
 * plutôt que de simuler une auto-relecture par le même modèle.
 */
export class GLMClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: GLMClientOptions) {
    this.client = new Anthropic({ authToken: opts.apiKey, baseURL: opts.baseUrl });
    this.model = opts.model;
  }

  async createPlan(task: string, context: ProjectContext): Promise<ImplementationPlan> {
    const text = await this.request(PLAN_SYSTEM_PROMPT, buildPlanUserPrompt(task, context));
    return parseJsonWithSchema(text, ImplementationPlanSchema, "plan d'implémentation");
  }

  async implementStep(
    step: PlanStep,
    currentFiles: Array<{ path: string; content: string | null }>,
    feedback?: string,
  ): Promise<FileChange[]> {
    const text = await this.request(IMPLEMENT_SYSTEM_PROMPT, buildImplementUserPrompt(step, currentFiles, feedback));
    const changes = parseFileBlocks(text);
    if (changes.length === 0) {
      throw new Error(
        "GLM n'a retourné aucun bloc de fichier reconnaissable (format attendu : ```file:chemin ... ```).",
      );
    }
    return changes;
  }

  private async request(system: string, user: string): Promise<string> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: user }],
    });
    const message = await stream.finalMessage();
    return extractFirstText(message);
  }
}
