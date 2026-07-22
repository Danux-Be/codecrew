import path from "node:path";
import { useEffect, useState } from "react";
import { Text } from "ink";

import { buildClients } from "../cli/buildClients.js";
import type { ConfigManager } from "../config/ConfigManager.js";
import { Orchestrator } from "../orchestrator/Orchestrator.js";
import { Session } from "./Session.js";
import { loadLatestSession, loadSession, type SavedSession } from "./sessionPersistence.js";

export interface AppProps {
  configManager: ConfigManager;
  root: string;
  maxIterations: number;
  /** `true` pour reprendre la dernière session, ou un id précis (`--resume [id]`). */
  resumeId?: string | true;
}

/**
 * Point d'entrée du TUI : construit les clients (async, avec détection
 * Ollama) et charge une éventuelle session à reprendre avant de rendre
 * l'UI interactive proprement dite (`Session`).
 */
export function App({ configManager, root, maxIterations, resumeId }: AppProps) {
  const [orchestrator, setOrchestrator] = useState<Orchestrator | null>(null);
  const [resumedSession, setResumedSession] = useState<SavedSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sessionsDir = path.join(path.dirname(configManager.path), "sessions");
    (async () => {
      try {
        const cfg = configManager.getAll();
        const { claude, glm, ollama } = await buildClients(cfg, { effort: cfg.defaultEffort });
        setOrchestrator(new Orchestrator(claude, glm, ollama));

        if (resumeId !== undefined) {
          const session = resumeId === true ? await loadLatestSession(sessionsDir) : await loadSession(sessionsDir, resumeId);
          setResumedSession(session);
        }
      } catch (err) {
        setError((err as Error).message);
      }
    })();
    // Volontairement exécuté une seule fois au montage : configManager et resumeId sont figés pour la durée de la session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <Text color="red">✖ {error}</Text>;
  if (!orchestrator) return <Text dimColor>Initialisation de codecrew...</Text>;

  return (
    <Session
      orchestrator={orchestrator}
      configManager={configManager}
      root={root}
      maxIterations={maxIterations}
      resumedSession={resumedSession}
    />
  );
}
