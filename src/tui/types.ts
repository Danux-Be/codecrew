import type { ActivityActor, ActivityPhase, AgentId, AgentStatusState } from "../orchestrator/events.js";

export interface TranscriptLine {
  id: string;
  text: string;
  kind: "title" | "info" | "success" | "warn" | "error" | "diff-add" | "diff-del" | "diff-context" | "diff-header";
}

export interface CurrentActivity {
  actor: ActivityActor;
  phase: ActivityPhase;
  text: string;
}

export interface SessionState {
  agents: Record<AgentId, AgentStatusState>;
  transcript: TranscriptLine[];
  current: CurrentActivity | null;
}

export const initialSessionState: SessionState = {
  agents: { claude: "available", glm: "available", ollama: "not-configured" },
  transcript: [],
  current: null,
};
