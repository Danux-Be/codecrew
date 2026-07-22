import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TranscriptLine } from "./types.js";

function formatLine(line: TranscriptLine): string {
  if (line.kind === "title") return `\n## ${line.text}\n`;
  return line.text;
}

/**
 * Exporte le transcript affiché en Markdown (commande `/export`), pour
 * archivage ou partage — indépendant de `/background` qui sauvegarde un
 * JSON structuré destiné à être repris par codecrew lui-même (`--resume`).
 */
export async function exportTranscript(exportsDir: string, transcript: TranscriptLine[]): Promise<string> {
  await mkdir(exportsDir, { recursive: true });
  const filename = `transcript-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  const filePath = path.join(exportsDir, filename);

  const body = transcript.map(formatLine).join("\n");
  const content = `# Transcript codecrew — ${new Date().toISOString()}\n\n${body}\n`;
  await writeFile(filePath, content, "utf8");
  return filePath;
}
