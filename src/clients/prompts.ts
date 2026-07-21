import type { PlanStep } from "./schemas.js";
import type { FileDiff, ProjectContext } from "./types.js";

const MAX_TREE_ENTRIES = 400;
const MAX_FILE_CHARS = 20_000;

/**
 * Prompts partagés entre ClaudeClient et GLMClient. Les deux modèles
 * parlant le même protocole (Anthropic Messages API), ils peuvent chacun
 * remplir n'importe lequel des rôles (plan, implémentation, relecture)
 * en cas d'indisponibilité de l'autre — d'où l'intérêt de centraliser
 * la formulation exacte ici plutôt que de la dupliquer par client.
 */

export const PLAN_SYSTEM_PROMPT = [
  "Tu es un architecte logiciel senior et rigoureux.",
  "Ta mission : analyser le projet local et découper la tâche demandée par l'utilisateur",
  "en un plan d'implémentation précis, composé d'étapes ordonnées et actionnables.",
  "Chaque étape doit cibler des fichiers précis (chemins relatifs à la racine du projet)",
  "et contenir des instructions non ambiguës à destination d'un développeur qui écrira le code",
  "(signatures de fonctions attendues, contrats, conventions du projet existant à respecter).",
  "Ne découpe pas plus finement que nécessaire : une étape par fichier ou par groupe de fichiers",
  "fortement liés suffit généralement. Base-toi strictement sur le contexte fourni.",
  "",
  "Pour chaque étape, indique aussi 'complexity' : 'trivial' UNIQUEMENT si l'étape est purement",
  "mécanique et sans risque (fichier de config simple, boilerplate, constantes, texte statique,",
  ".gitignore, etc.) — ce type d'étape peut être confié à un petit modèle local peu fiable.",
  "Utilise 'standard' pour tout ce qui demande un minimum de logique, de jugement ou de contexte",
  "métier. Sois conservateur : en cas de doute, choisis 'standard'.",
  "",
  "Réponds STRICTEMENT avec un unique objet JSON valide, sans texte avant/après, sans balises",
  "markdown, respectant exactement cette forme :",
  '{"summary": string, "steps": [{"id": number, "description": string, "files": string[], "instructions": string, "complexity": "trivial"|"standard"}]}',
].join("\n");

export function buildPlanUserPrompt(task: string, context: ProjectContext): string {
  const tree = context.fileTree.slice(0, MAX_TREE_ENTRIES);
  const truncatedTree =
    context.fileTree.length > MAX_TREE_ENTRIES
      ? `${tree.join("\n")}\n... (${context.fileTree.length - MAX_TREE_ENTRIES} fichiers supplémentaires non affichés)`
      : tree.join("\n");

  const filesSection = context.targetedFiles
    .map(({ path, content }) => {
      const truncated =
        content.length > MAX_FILE_CHARS
          ? `${content.slice(0, MAX_FILE_CHARS)}\n... (tronqué, ${content.length - MAX_FILE_CHARS} caractères supplémentaires)`
          : content;
      return `### ${path}\n\`\`\`\n${truncated}\n\`\`\``;
    })
    .join("\n\n");

  return [
    `## Tâche demandée\n${task}`,
    `## Racine du projet\n${context.root}`,
    `## Arborescence (extrait)\n\`\`\`\n${truncatedTree || "(vide)"}\n\`\`\``,
    filesSection ? `## Contenu des fichiers ciblés\n${filesSection}` : "## Aucun fichier explicitement ciblé",
  ].join("\n\n");
}

export const REVIEW_SYSTEM_PROMPT = [
  "Tu es un reviewer de code senior, exigeant sur la robustesse.",
  "On te soumet le diff produit par un développeur pour une étape donnée d'un plan.",
  "Vérifie en priorité : les edge cases non gérés, le typage, la gestion d'erreurs pertinente",
  "(sans sur-ingénierie), la cohérence avec les instructions de l'étape, et les bugs évidents.",
  "Si tout est correct et raisonnablement robuste, verdict = 'approve'.",
  "Sinon, verdict = 'request_changes' avec des commentaires précis et actionnables",
  "(quoi corriger, dans quel fichier) — pas de remarques vagues.",
  "Ne demande pas de changements cosmétiques ou de refactoring hors périmètre de l'étape.",
  "",
  "Réponds STRICTEMENT avec un unique objet JSON valide, sans texte avant/après, sans balises",
  "markdown, respectant exactement cette forme :",
  '{"verdict": "approve"|"request_changes", "summary": string, "issues": [{"file": string, "comment": string}]}',
].join("\n");

export function buildReviewUserPrompt(
  stepDescription: string,
  stepInstructions: string,
  diffs: FileDiff[],
): string {
  const diffsText = diffs
    .map((d) => `### ${d.path}${d.isNew ? " (nouveau fichier)" : ""}\n\`\`\`diff\n${d.unified}\n\`\`\``)
    .join("\n\n");

  return [
    `## Étape à relire\n${stepDescription}`,
    `## Instructions données à l'implémenteur\n${stepInstructions}`,
    `## Diff produit\n${diffsText || "(aucun changement détecté)"}`,
  ].join("\n\n");
}

export const IMPLEMENT_SYSTEM_PROMPT = [
  "Tu es un développeur qui implémente du code rapidement et correctement,",
  "à partir d'instructions précises fournies par un architecte logiciel.",
  "Réponds UNIQUEMENT avec le contenu complet des fichiers à créer ou modifier,",
  "un bloc par fichier, sous EXACTEMENT ce format (rien avant, rien après) :",
  "```file:chemin/relatif/du/fichier.ext",
  "<contenu intégral du fichier>",
  "```",
  "Toujours donner le contenu ENTIER du fichier (pas un extrait, pas un diff).",
  "N'ajoute aucune explication, aucun texte en dehors de ces blocs.",
].join("\n");

export function buildImplementUserPrompt(
  step: PlanStep,
  currentFiles: Array<{ path: string; content: string | null }>,
  feedback?: string,
): string {
  const filesContext = currentFiles
    .map(({ path, content }) =>
      content === null
        ? `### ${path}\n(fichier n'existe pas encore — à créer)`
        : `### ${path} (contenu actuel)\n\`\`\`\n${content}\n\`\`\``,
    )
    .join("\n\n");

  const parts = [
    `## Étape\n${step.description}`,
    `## Instructions\n${step.instructions}`,
    `## Fichiers concernés\n${step.files.join(", ")}`,
    filesContext,
  ];

  if (feedback) {
    parts.push(
      `## Retour de relecture à corriger impérativement\n${feedback}\n\nRéécris le(s) fichier(s) concerné(s) en tenant compte de ce retour.`,
    );
  }

  return parts.join("\n\n");
}
