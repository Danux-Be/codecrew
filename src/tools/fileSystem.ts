import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import fg from "fast-glob";

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.lock",
];

/**
 * Résout un chemin relatif fourni par un modèle en un chemin absolu,
 * en garantissant qu'il reste bien à l'intérieur de la racine du projet.
 * Rejette toute tentative d'évasion (`..`, chemin absolu externe).
 */
export function resolveInRoot(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`Chemin absolu refusé : ${relativePath}`);
  }
  const resolved = resolve(root, relativePath);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Chemin en dehors du projet refusé : ${relativePath}`);
  }
  return resolved;
}

/** Lit un fichier texte s'il existe, sinon retourne `null`. */
export async function readFileIfExists(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Écrit un fichier texte, en créant les dossiers parents si besoin. */
export async function writeFileEnsured(absPath: string, content: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, content, "utf8");
}

/** Supprime un fichier s'il existe (utilisé par /undo pour annuler une création). */
export async function deleteFileIfExists(absPath: string): Promise<void> {
  await rm(absPath, { force: true });
}

/** Liste l'arborescence du projet (chemins relatifs), pour donner du contexte à Claude. */
export async function listProjectTree(root: string, maxEntries = 2000): Promise<string[]> {
  const entries = await fg("**/*", {
    cwd: root,
    ignore: DEFAULT_IGNORE,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
  });
  entries.sort();
  return entries.slice(0, maxEntries);
}

/** Résout un glob (fourni par l'utilisateur via --files) en chemins relatifs existants. */
export async function resolveFilesGlob(root: string, pattern: string): Promise<string[]> {
  const entries = await fg(pattern, {
    cwd: root,
    ignore: DEFAULT_IGNORE,
    onlyFiles: true,
    dot: false,
  });
  entries.sort();
  return entries;
}
