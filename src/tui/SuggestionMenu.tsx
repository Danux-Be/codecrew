import { Box, Text } from "ink";

/**
 * Menu d'autocomplétion affiché au-dessus de la barre de saisie : commandes
 * `/` ou fichiers `@mention`, navigable avec les flèches et Tab pour
 * compléter (voir Session.tsx, qui possède la logique de sélection).
 */
export function SuggestionMenu({ items, activeIndex }: { items: string[]; activeIndex: number }) {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {items.map((item, i) => (
        <Text key={item} color={i === activeIndex ? "black" : "gray"} backgroundColor={i === activeIndex ? "cyan" : undefined}>
          {item}
        </Text>
      ))}
    </Box>
  );
}
