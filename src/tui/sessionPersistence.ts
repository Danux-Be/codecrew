import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentId, AgentStatusState, RunMode } from "../orchestrator/events.js";
import type { TranscriptLine } from "./types.js";

export interface SavedSession {
  id: string;
  savedAt: string;
  mode: RunMode;
  agents: Record<AgentId, AgentStatusState>;
  transcript: TranscriptLine[];
}

/**
 * Persistance légère de session (`/background` + `--resume`) : sauvegarde
 * et restaure le transcript, les statuts d'agents et le mode courant d'une
 * session interactive. Ne relance PAS une tâche qui était en cours — c'est
 * une reprise de contexte visuel, pas une exécution réellement détachée en
 * arrière-plan (voir la limitation documentée dans le README).
 */
export async function saveSession(
  sessionsDir: string,
  session: { mode: RunMode; agents: Record<AgentId, AgentStatusState>; transcript: TranscriptLine[] },
): Promise<string> {
  await mkdir(sessionsDir, { recursive: true });
  const id = String(Date.now());
  const record: SavedSession = { id, savedAt: new Date().toISOString(), ...session };
  await writeFile(path.join(sessionsDir, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
  return id;
}

export async function loadSession(sessionsDir: string, id: string): Promise<SavedSession | null> {
  try {
    const raw = await readFile(path.join(sessionsDir, `${id}.json`), "utf8");
    return JSON.parse(raw) as SavedSession;
  } catch {
    return null;
  }
}

export async function loadLatestSession(sessionsDir: string): Promise<SavedSession | null> {
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return null;
  }
  const ids = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  const latest = ids.at(-1);
  return latest ? loadSession(sessionsDir, latest) : null;
}
