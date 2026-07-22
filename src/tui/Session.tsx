import path from "node:path";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, measureElement, Text, useApp, useInput, type DOMElement } from "ink";

import { ClaudeClient } from "../clients/ClaudeClient.js";
import { GLMClient } from "../clients/GLMClient.js";
import { detectOllama, OllamaClient } from "../clients/OllamaClient.js";
import type { PlanStep } from "../clients/schemas.js";
import type { ConfigManager } from "../config/ConfigManager.js";
import type { Orchestrator } from "../orchestrator/Orchestrator.js";
import { formatDuration, formatTokens } from "../orchestrator/eventFormatting.js";
import type { AgentId, RunMode } from "../orchestrator/events.js";
import { listProjectTree } from "../tools/fileSystem.js";
import { ConfirmPrompt } from "./ConfirmPrompt.js";
import { runDoctorChecks } from "./doctor.js";
import { exportTranscript } from "./exportTranscript.js";
import { Header } from "./Header.js";
import { InputBar } from "./InputBar.js";
import { Picker, type PickerItem } from "./Picker.js";
import { saveSession, type SavedSession } from "./sessionPersistence.js";
import { Spinner } from "./Spinner.js";
import { SuggestionMenu } from "./SuggestionMenu.js";
import { TranscriptLineRow } from "./Transcript.js";
import { useOrchestratorEvents } from "./useOrchestratorEvents.js";
import { useTerminalSize } from "./useTerminalSize.js";
import { Welcome } from "./Welcome.js";

const MODES: RunMode[] = ["auto", "plan", "manual"];
const CLAUDE_MODEL_CHOICES = ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"];
const GLM_MODEL_CHOICES = ["glm-4.6", "glm-4.7", "glm-5.2"];

const COMMANDS: Array<{ cmd: string; description: string }> = [
  { cmd: "/config", description: "Affiche la configuration actuelle" },
  { cmd: "/model", description: "Change le modèle d'un agent (Claude, GLM, Ollama)" },
  { cmd: "/clear", description: "Vide le transcript affiché (garde les statuts d'agents)" },
  { cmd: "/undo", description: "Annule la dernière étape appliquée (rappelable plusieurs fois)" },
  { cmd: "/cost", description: "Coût cumulé de la session (durée, tokens Claude/GLM)" },
  { cmd: "/doctor", description: "Diagnostique la configuration (clés API, GLM, Ollama)" },
  { cmd: "/export", description: "Exporte le transcript affiché en Markdown" },
  { cmd: "/background", description: "Sauvegarde la session et quitte (reprise avec --resume)" },
  { cmd: "/help", description: "Liste ces commandes" },
  { cmd: "/exit", description: "Quitte la session" },
];

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
 * saisie — soit une tâche (avec `@fichier` pour cibler du contexte,
 * "\" + Entrée pour une nouvelle ligne), soit une commande `/config`,
 * `/model`, `/clear`, `/undo`, `/cost`, `/doctor`, `/export`,
 * `/background`, `/help`, `/exit`. Échap annule la tâche en cours.
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
  const exportsDir = useMemo(() => path.join(path.dirname(configManager.path), "exports"), [configManager]);
  const { rows } = useTerminalSize();

  const abortControllerRef = useRef<AbortController | null>(null);

  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  useEffect(() => {
    listProjectTree(root)
      .then(setProjectFiles)
      .catch(() => {});
  }, [root]);

  const canShowSuggestions = ui.kind === "task" && !confirmation && !running;

  const commandSuggestions = useMemo(
    () => (canShowSuggestions && input.startsWith("/") ? COMMANDS.filter((c) => c.cmd.startsWith(input.toLowerCase())) : []),
    [canShowSuggestions, input],
  );

  const mentionQuery = useMemo(() => {
    if (!canShowSuggestions || input.startsWith("/")) return null;
    const m = /@([^\s]*)$/.exec(input);
    return m ? m[1]! : null;
  }, [canShowSuggestions, input]);

  const mentionSuggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return projectFiles.filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
  }, [mentionQuery, projectFiles]);

  const [menuIndex, setMenuIndex] = useState(0);
  useEffect(() => setMenuIndex(0), [input]);
  const activeSuggestions = commandSuggestions.length > 0 ? commandSuggestions.map((c) => c.cmd) : mentionSuggestions;
  const activeIndex = activeSuggestions.length > 0 ? menuIndex % activeSuggestions.length : 0;

  // Ink n'a pas de vrai scroll : on ne montre que la fin du transcript qui
  // tient dans l'espace mesuré (pas de <Static> ici — mélanger du contenu
  // statique avec une zone live de hauteur fixe fait planter le rendu d'Ink
  // dès que static+live dépasse la hauteur du terminal en un seul commit).
  const transcriptAreaRef = useRef<DOMElement>(null);
  const [visibleCount, setVisibleCount] = useState(0);
  useLayoutEffect(() => {
    if (!transcriptAreaRef.current) return;
    const { height } = measureElement(transcriptAreaRef.current);
    setVisibleCount((prev) => (prev === height ? prev : height));
  });
  const visibleTranscript = useMemo(
    () => (visibleCount > 0 ? state.transcript.slice(-visibleCount) : []),
    [state.transcript, visibleCount],
  );

  useInput((char, key) => {
    if (ui.kind === "task" && !confirmation && key.tab && key.shift) {
      setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]!);
      return;
    }
    if (char === "q" && key.ctrl) {
      exit();
      return;
    }
    if (key.escape && running) {
      abortControllerRef.current?.abort();
      return;
    }
    if (activeSuggestions.length > 0) {
      if (key.downArrow) {
        setMenuIndex((i) => (i + 1) % activeSuggestions.length);
        return;
      }
      if (key.upArrow) {
        setMenuIndex((i) => (i - 1 + activeSuggestions.length) % activeSuggestions.length);
        return;
      }
      if (key.tab && !key.shift) {
        const picked = activeSuggestions[activeIndex]!;
        setInput(commandSuggestions.length > 0 ? `${picked} ` : input.replace(/@[^\s]*$/, `@${picked} `));
        return;
      }
    }
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
    if (cmd === "/clear") {
      state.clear();
      setNotice(null);
      return;
    }
    if (cmd === "/help") {
      setNotice(COMMANDS.map((c) => `${c.cmd.padEnd(12)} ${c.description}`).join("\n"));
      return;
    }
    if (cmd === "/export") {
      const filePath = await exportTranscript(exportsDir, state.transcript);
      setNotice(`Transcript exporté : ${filePath}`);
      return;
    }
    if (cmd === "/undo") {
      if (running) {
        setNotice("Attendez la fin de la tâche en cours avant d'annuler une étape.");
        return;
      }
      await orchestrator.undoLast();
      return;
    }
    if (cmd === "/cost") {
      const stats = orchestrator.getSessionStats();
      setNotice(
        [
          `Durée cumulée : ${formatDuration(stats.durationMs)}`,
          `Claude : ${formatTokens(stats.claudeTokens.inputTokens)} in / ${formatTokens(stats.claudeTokens.outputTokens)} out`,
          `GLM    : ${formatTokens(stats.glmTokens.inputTokens)} in / ${formatTokens(stats.glmTokens.outputTokens)} out`,
        ].join("\n"),
      );
      return;
    }
    if (cmd === "/doctor") {
      setNotice("Diagnostic en cours...");
      const lines = await runDoctorChecks(configManager.getAll());
      setNotice(lines.join("\n"));
      return;
    }
    setNotice(`Commande inconnue : ${raw}. Tapez /help pour la liste des commandes.`);
  }

  /**
   * Exécute une tâche, puis enchaîne automatiquement sur la suivante en
   * file d'attente (si l'utilisateur en a soumis pendant l'exécution) —
   * pas d'exécution concurrente ni d'interjection dans le run en cours,
   * seulement un enchaînement séquentiel.
   */
  async function runTask(task: string): Promise<void> {
    setRunning(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      await orchestrator.run(
        { task, root, maxIterations, dryRun: false, mode, signal: controller.signal },
        mode === "manual"
          ? { confirmStep: (request) => new Promise<boolean>((resolve) => setConfirmation({ ...request, resolve })) }
          : undefined,
      );
    } catch {
      // déjà rendu via un événement run:error / une ligne "error" du transcript
    } finally {
      abortControllerRef.current = null;
      setRunning(false);
    }

    const next = queueRef.current.shift();
    setQueueCount(queueRef.current.length);
    if (next !== undefined) {
      await runTask(next);
    }
  }

  async function handleSubmit(value: string): Promise<void> {
    // Convention shell classique : "\" en fin de ligne + Entrée = nouvelle
    // ligne plutôt que validation (Shift+Entrée n'est pas détectable de
    // façon fiable dans un terminal — beaucoup ne le distinguent pas
    // d'un Entrée simple, et ink-text-input valide sur tout retour clavier).
    if (value.endsWith("\\")) {
      setInput(`${value.slice(0, -1)}\n`);
      return;
    }

    const trimmed = value.trim();
    if (!trimmed) return;
    setInput("");

    if (trimmed.startsWith("/")) {
      const isExactCommand = COMMANDS.some((c) => c.cmd === trimmed.toLowerCase());
      const finalCmd =
        !isExactCommand && commandSuggestions.length > 0
          ? commandSuggestions[Math.min(menuIndex, commandSuggestions.length - 1)]!.cmd
          : trimmed;
      await handleCommand(finalCmd);
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
      <Box flexDirection="column" flexGrow={1}>
        <Welcome cfg={configManager.getAll()} root={root} agents={state.agents} />
        <Box ref={transcriptAreaRef} flexDirection="column" flexGrow={1}>
          {visibleTranscript.map((line) => (
            <TranscriptLineRow key={line.id} line={line} />
          ))}
        </Box>
      </Box>
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
        <Box flexDirection="column">
          {commandSuggestions.length > 0 && (
            <SuggestionMenu
              items={commandSuggestions.map((c) => `${c.cmd}  ${c.description}`)}
              activeIndex={activeIndex}
            />
          )}
          {commandSuggestions.length === 0 && mentionSuggestions.length > 0 && (
            <SuggestionMenu items={mentionSuggestions.map((f) => `@${f}`)} activeIndex={activeIndex} />
          )}
          <InputBar value={input} onChange={setInput} onSubmit={handleSubmit} running={running} />
        </Box>
      )}
      <Header mode={mode} agents={state.agents} />
    </Box>
  );
}
