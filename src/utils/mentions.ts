const MENTION_PATTERN = /@([\w./-]+)/g;

/**
 * Extrait les chemins mentionnés dans une tâche via `@chemin/relatif` (ex:
 * "corrige le bug dans @src/api/users.ts"), pour les inclure explicitement
 * comme contexte — équivalent TUI de `--files` pour un fichier ciblé.
 * Ne valide pas l'existence des fichiers (fait par l'appelant).
 */
export function extractMentionedFiles(task: string): string[] {
  const matches = task.matchAll(MENTION_PATTERN);
  const paths = new Set<string>();
  for (const m of matches) {
    if (m[1]) paths.add(m[1]);
  }
  return [...paths];
}
