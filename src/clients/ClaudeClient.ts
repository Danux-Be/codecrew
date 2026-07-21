import Anthropic from "@anthropic-ai/sdk";

import { extractFirstText } from "./anthropicCompat.js";
import { parseFileBlocks, parseJsonWithSchema } from "./parsing.js";
import {
  buildImplementUserPrompt,
  buildPlanUserPrompt,
  buildReviewUserPrompt,
  IMPLEMENT_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
} from "./prompts.js";
import { ImplementationPlanSchema, ReviewResultSchema, type ImplementationPlan, type ReviewResult } from "./schemas.js";
import type { PlanStep } from "./schemas.js";
import type { FileChange, FileDiff, ProjectContext } from "./types.js";

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
 * Client Claude : rôle nominal d'architecte (plan) et de reviewer
 * (relecture — edge cases, typage, robustesse). Expose aussi
 * `implementStep`, utilisé uniquement en repli lorsque GLM est
 * indisponible (crédits épuisés), pour que codecrew reste fonctionnel
 * avec un seul agent.
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
    const text = await this.request(PLAN_SYSTEM_PROMPT, buildPlanUserPrompt(task, context), 16000);
    return parseJsonWithSchema(text, ImplementationPlanSchema, "plan d'implémentation");
  }

  async reviewChanges(stepDescription: string, stepInstructions: string, diffs: FileDiff[]): Promise<ReviewResult> {
    const text = await this.request(
      REVIEW_SYSTEM_PROMPT,
      buildReviewUserPrompt(stepDescription, stepInstructions, diffs),
      8000,
    );
    return parseJsonWithSchema(text, ReviewResultSchema, "résultat de relecture");
  }

  /** Implémentation directe par Claude, utilisée en repli si GLM est indisponible. */
  async implementStep(
    step: PlanStep,
    currentFiles: Array<{ path: string; content: string | null }>,
    feedback?: string,
  ): Promise<FileChange[]> {
    const text = await this.request(
      IMPLEMENT_SYSTEM_PROMPT,
      buildImplementUserPrompt(step, currentFiles, feedback),
      16000,
    );
    const changes = parseFileBlocks(text);
    if (changes.length === 0) {
      throw new Error(
        "Claude n'a retourné aucun bloc de fichier reconnaissable (format attendu : ```file:chemin ... ```).",
      );
    }
    return changes;
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
    return extractFirstText(message);
  }
}
