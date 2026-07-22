import os from "node:os";
import { Box, Text } from "ink";

import type { CodecrewConfig } from "../config/ConfigManager.js";
import type { AgentId, AgentStatusState } from "../orchestrator/events.js";

// Généré une fois via `figlet.textSync("CodeCrew", { font: "Small" })` — figé en
// dur car le chargement de police de figlet au runtime casse en ESM compilé
// (résolution de chemin relative brisée selon le module chargé par Node).
const BANNER = [
  "   ___         _      ___                ",
  "  / __|___  __| |___ / __|_ _ _____ __ __",
  " | (__/ _ \\/ _` / -_) (__| '_/ -_) V  V /",
  "  \\___\\___/\\__,_\\___|\\___|_| \\___|\\_/\\_/ ",
].join("\n");

const AGENT_LABELS: Record<AgentId, string> = { claude: "Claude", glm: "GLM", ollama: "Ollama (local)" };

function statusDot(status: AgentStatusState): { symbol: string; color: string } {
  if (status === "available") return { symbol: "●", color: "green" };
  if (status === "unavailable") return { symbol: "●", color: "red" };
  return { symbol: "○", color: "gray" };
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
}

function AgentLine({ agent, status, model }: { agent: AgentId; status: AgentStatusState; model: string }) {
  const dot = statusDot(status);
  return (
    <Text>
      <Text color={dot.color}>{dot.symbol}</Text> {AGENT_LABELS[agent]}: <Text bold>{model}</Text>
    </Text>
  );
}

export function Welcome({
  cfg,
  root,
  agents,
}: {
  cfg: CodecrewConfig;
  root: string;
  agents: Record<AgentId, AgentStatusState>;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={2} paddingY={1} marginBottom={1}>
      <Text color="magenta" bold>
        {BANNER}
      </Text>
      <Text dimColor>Deux (ou trois) IA qui collaborent sur ton code, en direct dans ce terminal.</Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold underline>
          Machine
        </Text>
        <Text>
          {os.platform()} {os.release()} · {os.arch()} · {os.cpus().length} cœurs · {formatGiB(os.totalmem())} RAM ·
          Node {process.version}
        </Text>
        <Text dimColor>Projet : {root}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold underline>
          Agents
        </Text>
        <AgentLine agent="claude" status={agents.claude} model={`${cfg.claudeModel} (effort ${cfg.defaultEffort})`} />
        <AgentLine agent="glm" status={agents.glm} model={cfg.glmModel} />
        <AgentLine
          agent="ollama"
          status={agents.ollama}
          model={cfg.ollamaEnabled ? cfg.ollamaModel || "auto-détection" : "désactivé"}
        />
      </Box>
    </Box>
  );
}
