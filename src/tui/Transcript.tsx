import { Box, Static, Text } from "ink";

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

export function Transcript({ lines }: { lines: TranscriptLine[] }) {
  return (
    <Static items={lines}>
      {(l) => (
        <Box key={l.id}>
          <Text color={COLORS[l.kind]} bold={l.kind === "title" || l.kind === "diff-header"}>
            {l.text}
          </Text>
        </Box>
      )}
    </Static>
  );
}
