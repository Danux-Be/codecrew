import { Text } from "ink";

import type { AgentId, AgentStatusState } from "../orchestrator/events.js";

const LABELS: Record<AgentId, string> = { claude: "Claude", glm: "GLM", ollama: "Local" };

export function AgentBubble({ agent, status }: { agent: AgentId; status: AgentStatusState }) {
  const color = status === "available" ? "green" : status === "unavailable" ? "red" : "gray";
  const dot = status === "not-configured" ? "○" : "●";
  return (
    <Text color={color}>
      {dot} {LABELS[agent]}
    </Text>
  );
}
