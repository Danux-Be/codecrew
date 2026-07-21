import { createTwoFilesPatch } from "diff";
import type { FileDiff } from "../clients/types.js";

/** Calcule un diff unifié entre l'ancien et le nouveau contenu d'un fichier. */
export function computeFileDiff(path: string, before: string | null, after: string): FileDiff {
  const isNew = before === null;
  const unified = createTwoFilesPatch(
    isNew ? "/dev/null" : `a/${path}`,
    `b/${path}`,
    before ?? "",
    after,
    undefined,
    undefined,
    { context: 3 },
  );
  return { path, before: before ?? "", after, unified, isNew };
}
