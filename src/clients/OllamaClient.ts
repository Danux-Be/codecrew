import { parseFileBlocks } from "./parsing.js";
import { buildImplementUserPrompt, IMPLEMENT_SYSTEM_PROMPT } from "./prompts.js";
import type { PlanStep } from "./schemas.js";
import type { FileChange } from "./types.js";

export interface OllamaClientOptions {
  baseUrl: string;
  model: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string };
  error?: string;
}

/** Résultat de la détection d'une instance Ollama locale. */
export interface OllamaDetection {
  available: boolean;
  models: string[];
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Détecte la présence d'une instance Ollama locale en interrogeant
 * `/api/tags`. Échoue silencieusement (available: false) si Ollama n'est
 * pas lancé, injoignable, ou trop lent à répondre — la détection ne doit
 * jamais bloquer ni faire échouer codecrew.
 */
export async function detectOllama(baseUrl: string, timeoutMs = 1500): Promise<OllamaDetection> {
  try {
    const res = await fetchWithTimeout(`${baseUrl.replace(/\/+$/, "")}/api/tags`, {}, timeoutMs);
    if (!res.ok) return { available: false, models: [] };
    const body = (await res.json()) as OllamaTagsResponse;
    return { available: true, models: (body.models ?? []).map((m) => m.name) };
  } catch {
    return { available: false, models: [] };
  }
}

/**
 * Client pour un 3ème agent local (Ollama), utilisé de façon opportuniste
 * pour les étapes du plan marquées 'trivial' par l'architecte (Claude ou
 * GLM), afin d'économiser des tokens Claude/GLM sur les tâches purement
 * mécaniques. Best-effort : toute erreur doit être interceptée par
 * l'appelant (Orchestrator) et déclencher un repli sur GLM/Claude, jamais
 * faire échouer le run.
 */
export class OllamaClient {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: OllamaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
  }

  async implementStep(
    step: PlanStep,
    currentFiles: Array<{ path: string; content: string | null }>,
    feedback?: string,
    signal?: AbortSignal,
  ): Promise<FileChange[]> {
    const user = buildImplementUserPrompt(step, currentFiles, feedback);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: IMPLEMENT_SYSTEM_PROMPT },
            { role: "user", content: user },
          ],
          stream: false,
        }),
        signal,
      });
    } catch (err) {
      throw new Error(`Impossible de joindre Ollama (${this.baseUrl}) : ${(err as Error).message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Erreur API Ollama (HTTP ${res.status}) : ${text.slice(0, 500)}`);
    }

    const body = (await res.json()) as OllamaChatResponse;
    if (body.error) {
      throw new Error(`Erreur Ollama : ${body.error}`);
    }
    const raw = body.message?.content;
    if (!raw) {
      throw new Error("Réponse Ollama vide ou de forme inattendue.");
    }

    const changes = parseFileBlocks(raw);
    if (changes.length === 0) {
      throw new Error(
        "Ollama n'a retourné aucun bloc de fichier reconnaissable (format attendu : ```file:chemin ... ```).",
      );
    }
    return changes;
  }
}
