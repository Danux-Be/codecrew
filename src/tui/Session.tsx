import path from "node:path";
import { useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import { ClaudeClient } from "../clients/ClaudeClient.js";
import { GLMClient } from "../clients/GLMClient.js";
import { detectOllama, OllamaClient } from "../clients/OllamaClient.js";
import type { PlanStep } from "../clients/schemas.js";
import type { ConfigManager } from "../config/ConfigManager.js";
import type { Orchestrator } from "../orchestrator/Orchestrator.js";
import type { AgentId, RunMode } from "../orchestrator/events.js";
import { ConfirmPrompt } from "./ConfirmPrompt.js";
import { Header } from "./Header.js";
import { InputBar } from "./InputBar.js";
import { Picker, type PickerItem } from "./Picker.js";
import { saveSession, type SavedSession } from "./sessionPersistence.js";
import { Spinner } from "./Spinner.js";
import { Transcript } from "./Transcript.js";
import { useOrchestratorEvents } from "./useOrchestratorEvents.js";
import { useTerminalSize } from "./useTerminalSize.js";

const MODES: RunMode[] = ["auto", "plan", "manual"];
const CLAUDE_MODEL_CHOICES = ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"];
const GLM_MODEL_CHOICES = ["glm-4.6", "glm-4.7", "glm-5.2"];

type UiState =
  | { kind: "task" }
  | { kind: "model-agent" }
  | { kind: "model-choice"; agent: AgentId; choices: Array<PickerItem<string>> };

export interface SessionProps {
  orchestrator: Orchestrator;
  configManager: ConfigManager;
  root: string;
  maxIterations: number;
  resumedSession: SavedSession | null;
}

/**
 * L'UI interactive elle-même (une fois l'Orchestrator prêt) : en-tête
 * (mode + bulles d'agents), transcript, activité en cours, et zone de
 * saisie — soit une tâche, soit une commande `/config`, `/model`,
 * `/background`, `/exit`.
 */
export function Session({ orchestrator, configManager, root, maxIterations, resumedSession }: SessionProps) {
  const { exit } = useApp();
  const state = useOrchestratorEvents(
    orchestrator,
    resumedSession
      ? { agents: resumedSession.agents, transcript: resumedSession.transcript, current: null }
      : undefined,
  );

  const [mode, setMode] = useState<RunMode>(resumedSession?.mode ?? "auto");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const queueRef = useRef<string[]>([]);
  const [ui, setUi] = useState<UiState>({ kind: "task" });
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    step: PlanStep;
    index: number;
    total: number;
    resolve: (v: boolean) => void;
  } | null>(null);

  const sessionsDir = useMemo(() => path.join(path.dirname(configManager.path), "sessions"), [configManager]);
  const { rows } = useTerminalSize();

  useInput((char, key) => {
    if (ui.kind === "task" && !confirmation && key.tab && key.shift) {
      setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]!);
    }
    if (char === "q" && key.ctrl) exit();
  });

  function handleModelSelected(agent: AgentId, model: string): void {
    const cfg = configManager.getAll();
    if (agent === "claude") {
      configManager.set("claudeModel", model);
      orchestrator.setClaudeClient(new ClaudeClient({ apiKey: cfg.anthropicApiKey!, model, effort: cfg.defaultEffort }));
    } else if (agent === "glm") {
      configManager.set("glmModel", model);
      orchestrator.setGlmClient(new GLMClient({ apiKey: cfg.glmApiKey!, baseUrl: cfg.glmBaseUrl, model }));
    } else {
      configManager.set("ollamaModel", model);
      orchestrator.setOllamaClient(new OllamaClient({ baseUrl: cfg.ollamaBaseUrl, model }));
    }
    setNotice(`Modèle ${agent} mis à jour : ${model}`);
    setUi({ kind: "task" });
  }

  async function handleAgentSelected(agent: AgentId): Promise<void> {
    if (agent === "ollama") {
      const cfg = configManager.getAll();
      const detection = await detectOllama(cfg.ollamaBaseUrl);
      if (detection.models.length === 0) {
        setNotice("Aucun modèle Ollama détecté sur " + cfg.ollamaBaseUrl + ".");
        setUi({ kind: "task" });
        return;
      }
      setUi({ kind: "model-choice", agent, choices: detection.models.map((m) => ({ label: m, value: m })) });
      return;
    }
    const choices = (agent === "claude" ? CLAUDE_MODEL_CHOICES : GLM_MODEL_CHOICES).map((m) => ({ label: m, value: m }));
    setUi({ kind: "model-choice", agent, choices });
  }

  async function handleCommand(raw: string): Promise<void> {
    const cmd = raw.trim().toLowerCase();
    if (cmd === "/config") {
      const cfg = configManager.getAll();
      setNotice(
        [
          `Claude : ${cfg.claudeModel} (effort ${cfg.defaultEffort})`,
          `GLM    : ${cfg.glmModel} (${cfg.glmBaseUrl})`,
          `Ollama : ${cfg.ollamaEnabled ? cfg.ollamaModel || "auto-détection" : "désactivé"}`,
          `Itérations max : ${cfg.maxReviewIterations}`,
          "Utilisez /model pour changer un modèle. Pour les clés API, lancez `codecrew config` dans un autre terminal.",
        ].join("\n"),
      );
      return;
    }
    if (cmd === "/model") {
      setUi({ kind: "model-agent" });
      return;
    }
    if (cmd === "/background") {
      if (running) {
        setNotice("Attendez la fin de la tâche en cours avant de mettre la session en arrière-plan.");
        return;
      }
      const id = await saveSession(sessionsDir, { mode, agents: state.agents, transcript: state.transcript });
      console.log(`\nSession sauvegardée (${id}). Reprenez avec : codecrew --resume ${id}`);
      exit();
      return;
    }
    if (cmd === "/exit") {
      if (running) {
        setNotice("Attendez la fin de la tâche en cours avant de quitter.");
        return;
      }
      exit();
      return;
    }
    setNotice(`Commande inconnue : ${raw}. Essayez /config, /model, /background ou /exit.`);
  }

  /**
   * Exécute une tâche, puis enchaîne automatiquement sur la suivante en
   * file d'attente (si l'utilisateur en a soumis pendant l'exécution) —
   * pas d'exécution concurrente ni d'interjection dans le run en cours,
   * seulement un enchaînement séquentiel.
   */
  async function runTask(task: string): Promise<void> {
    setRunning(true);
    try {
      await orchestrator.run(
        { task, root, maxIterations, dryRun: false, mode },
        mode === "manual"
          ? { confirmStep: (request) => new Promise<boolean>((resolve) => setConfirmation({ ...request, resolve })) }
          : undefined,
      );
    } catch {
      // déjà rendu via un événement run:error / une ligne "error" du transcript
    } finally {
      setRunning(false);
    }

    const next = queueRef.current.shift();
    setQueueCount(queueRef.current.length);
    if (next !== undefined) {
      await runTask(next);
    }
  }

  async function handleSubmit(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    setInput("");

    if (trimmed.startsWith("/")) {
      await handleCommand(trimmed);
      return;
    }

    if (running) {
      queueRef.current.push(trimmed);
      setQueueCount(queueRef.current.length);
      setNotice(`Tâche mise en file d'attente (${queueRef.current.length} en attente) : ${trimmed}`);
      return;
    }

    setNotice(null);
    await runTask(trimmed);
  }

  function onConfirmAnswer(proceed: boolean): void {
    confirmation?.resolve(proceed);
    setConfirmation(null);
  }

  return (
    <Box flexDirection="column" width="100%" height={rows}>
      <Header mode={mode} agents={state.agents} />
      <Transcript lines={state.transcript} />
      <Box flexGrow={1} />
      {state.current && (
        <Box>
          <Spinner />
          <Text> {state.current.text}</Text>
        </Box>
      )}
      {notice && (
        <Box marginTop={1}>
          <Text dimColor>{notice}</Text>
        </Box>
      )}
      {queueCount > 0 && (
        <Box>
          <Text dimColor>
            {queueCount} tâche{queueCount > 1 ? "s" : ""} en attente
          </Text>
        </Box>
      )}
      {confirmation ? (
        <ConfirmPrompt
          step={confirmation.step}
          index={confirmation.index}
          total={confirmation.total}
          onAnswer={onConfirmAnswer}
        />
      ) : ui.kind === "model-agent" ? (
        <Picker
          title="Quel agent ?"
          items={[
            { label: "Claude", value: "claude" as AgentId },
            { label: "GLM", value: "glm" as AgentId },
            { label: "Ollama (local)", value: "ollama" as AgentId },
          ]}
          onSelect={handleAgentSelected}
        />
      ) : ui.kind === "model-choice" ? (
        <Picker
          title={`Modèle pour ${ui.agent}`}
          items={ui.choices}
          onSelect={(model) => handleModelSelected(ui.agent, model)}
        />
      ) : (
        <InputBar value={input} onChange={setInput} onSubmit={handleSubmit} running={running} />
      )}
    </Box>
  );
}
