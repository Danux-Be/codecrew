import { Text, useInput } from "ink";

import type { PlanStep } from "../clients/schemas.js";

export function ConfirmPrompt({
  step,
  index,
  total,
  onAnswer,
}: {
  step: PlanStep;
  index: number;
  total: number;
  onAnswer: (proceed: boolean) => void;
}) {
  useInput((input, key) => {
    if (input === "y" || key.return) onAnswer(true);
    else if (input === "n" || key.escape) onAnswer(false);
  });

  return (
    <Text>
      Implémenter l'étape {index}/{total} — {step.description} ? <Text dimColor>[y/N]</Text>
    </Text>
  );
}
