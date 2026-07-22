import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export function InputBar({
  value,
  onChange,
  onSubmit,
  running,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  running: boolean;
}) {
  return (
    <Box>
      <Text color={running ? "yellow" : "cyan"}>{"> "}</Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={
          running ? "tâche en attente, ou /config /model /background /exit" : "tâche, ou /config /model /background /exit"
        }
      />
    </Box>
  );
}
