import type { z } from "zod";
import type { FileChange } from "./types.js";

const FILE_BLOCK_RE = /```file:(\S+)\r?\n([\s\S]*?)```/g;

/**
 * Extrait un objet JSON d'une réponse modèle qui peut être entourée de
 * texte ou de balises markdown malgré les instructions de format strict.
 */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();

  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

/** Parse et valide (Zod) un objet JSON produit par un modèle, avec message d'erreur exploitable. */
export function parseJsonWithSchema<T>(raw: string, schema: z.ZodType<T>, label: string): T {
  const candidate = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new Error(
      `Réponse illisible en JSON pour le ${label} : ${(err as Error).message}\n---\n${raw.slice(0, 800)}`,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`JSON reçu invalide pour le ${label} : ${result.error.message}\n---\n${raw.slice(0, 800)}`);
  }
  return result.data;
}

/** Extrait les blocs ```file:chemin ... ``` d'une réponse modèle en changements de fichiers. */
export function parseFileBlocks(raw: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const match of raw.matchAll(FILE_BLOCK_RE)) {
    const path = match[1]?.trim();
    const content = match[2];
    if (path && content !== undefined) {
      changes.push({ path, content });
    }
  }
  return changes;
}
