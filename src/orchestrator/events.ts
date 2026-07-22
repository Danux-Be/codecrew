import type { PlanStep, ReviewResult } from "../clients/schemas.js";
import type { FileDiff } from "../clients/types.js";

export type AgentId = "claude" | "glm" | "ollama";
export type ActivityActor = AgentId | "system";
export type ActivityPhase = "plan" | "review" | "implement" | "test";
export type ActivityState = "start" | "success" | "warn" | "error";
export type AgentStatusState = "available" | "unavailable" | "not-configured";
export type RunMode = "auto" | "plan" | "manual";

/**
 * Événements structurés émis par l'Orchestrator, consommés indifféremment
 * par le rendu console (one-shot CLI, via ConsoleReporter) ou par le TUI
 * interactif (Ink) — l'Orchestrator ne connaît ni l'un ni l'autre.
 */
export type OrchestratorEvent =
  | { type: "run:start"; task: string; mode: RunMode }
  | { type: "agent:status"; agent: AgentId; status: AgentStatusState; reason?: "quota" | "runtime-error" }
  | { type: "agent:activity"; actor: ActivityActor; phase: ActivityPhase; state: ActivityState; text: string }
  | { type: "plan:generated"; summary: string; steps: PlanStep[] }
  | { type: "plan:empty" }
  | { type: "plan:stopped" }
  | { type: "step:start"; stepId: number; index: number; total: number; description: string; files: string[] }
  | { type: "step:awaiting-confirmation"; stepId: number; index: number; total: number }
  | { type: "step:diff"; stepId: number; iteration: number; diffs: FileDiff[] }
  | {
      type: "step:review-result";
      stepId: number;
      iteration: number;
      verdict: "approve" | "request_changes";
      summary: string;
      issues: ReviewResult["issues"];
    }
  | { type: "step:review-skipped"; stepId: number; reason: "claude-unavailable" }
  | { type: "step:forced"; stepId: number; maxIterations: number }
  | { type: "step:complete"; stepId: number; index: number; total: number; changesCount: number; dryRun: boolean }
  | { type: "tests:result"; command: string; exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }
  | {
      type: "run:summary";
      totalSteps: number;
      totalApplied: number;
      totalForced: number;
      totalUnreviewed: number;
      totalLocal: number;
      durationMs: number;
      claudeTokens: { input: number; output: number };
      glmTokens: { input: number; output: number };
    }
  | { type: "run:aborted"; atStep: number }
  | { type: "run:cancelled" }
  | { type: "run:error"; message: string }
  | { type: "undo:done"; stepId: number; description: string; files: string[] }
  | { type: "undo:empty" };
