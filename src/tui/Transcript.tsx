import { Box, Text } from "ink";

import type { TranscriptLine } from "./types.js";

const COLORS: Partial<Record<TranscriptLine["kind"], string>> = {
  info: "gray",
  success: "green",
  warn: "yellow",
  error: "red",
  "diff-add": "green",
  "diff-del": "red",
  "diff-context": "gray",
};

/**
 * Une ligne du transcript. Rendue à l'intérieur de l'unique `<Static>` de
 * Session (Ink ne suit qu'un seul nœud static par arbre — voir Session.tsx).
 */
export function TranscriptLineRow({ line }: { line: TranscriptLine }) {
  return (
    <Box>
      <Text color={COLORS[line.kind]} bold={line.kind === "title" || line.kind === "diff-header"}>
        {line.text}
      </Text>
    </Box>
  );
}
