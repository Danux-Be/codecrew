import { Box, Text } from "ink";
import SelectInput from "ink-select-input";

export interface PickerItem<V> {
  label: string;
  value: V;
}

/** Menu de sélection générique (flèches + entrée), utilisé par /model. */
export function Picker<V>({
  title,
  items,
  onSelect,
}: {
  title: string;
  items: Array<PickerItem<V>>;
  onSelect: (value: V) => void;
}) {
  return (
    <Box flexDirection="column">
      <Text>{title}</Text>
      <SelectInput items={items} onSelect={(item) => onSelect(item.value)} />
    </Box>
  );
}
