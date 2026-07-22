import { Box, Text } from "ink";

import type { AgentId, AgentStatusState, RunMode } from "../orchestrator/events.js";
import { AgentBubble } from "./AgentBubble.js";

const AGENT_ORDER: AgentId[] = ["claude", "glm", "ollama"];

export function Header({ mode, agents }: { mode: RunMode; agents: Record<AgentId, AgentStatusState> }) {
  return (
    <Box width="100%" justifyContent="space-between" borderStyle="round" paddingX={1}>
      <Text bold>
        codecrew — mode: {mode.toUpperCase()} <Text dimColor>(shift+tab pour changer · ctrl+q pour quitter)</Text>
      </Text>
      <Box gap={1}>
        {AGENT_ORDER.map((agent) => (
          <AgentBubble key={agent} agent={agent} status={agents[agent]} />
        ))}
      </Box>
    </Box>
  );
}
