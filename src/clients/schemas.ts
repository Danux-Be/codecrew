import { z } from "zod";

/**
 * Schémas Zod pour les sorties structurées de Claude (architecte/reviewer).
 * Utilisés à la fois pour la validation runtime (via output_config.format)
 * et pour le typage TypeScript (z.infer).
 */

export const PlanStepSchema = z.object({
  id: z.number().int().describe("Identifiant séquentiel de l'étape, à partir de 1"),
  description: z.string().describe("Description courte et actionnable de l'étape"),
  files: z
    .array(z.string())
    .describe("Chemins relatifs des fichiers à créer ou modifier pour cette étape"),
  instructions: z
    .string()
    .describe(
      "Instructions précises et sans ambiguïté pour l'implémenteur : ce qu'il doit écrire, dans quel(s) fichier(s), en respectant quels contrats/signatures.",
    ),
});

export const ImplementationPlanSchema = z.object({
  summary: z.string().describe("Résumé en une ou deux phrases de l'approche retenue"),
  steps: z.array(PlanStepSchema).describe("Étapes ordonnées du plan d'implémentation"),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type ImplementationPlan = z.infer<typeof ImplementationPlanSchema>;

export const ReviewResultSchema = z.object({
  verdict: z
    .enum(["approve", "request_changes"])
    .describe("'approve' si le code est correct et robuste, 'request_changes' sinon"),
  summary: z.string().describe("Synthèse de la relecture, en une ou deux phrases"),
  issues: z
    .array(
      z.object({
        file: z.string().describe("Chemin relatif du fichier concerné"),
        comment: z
          .string()
          .describe("Problème précis identifié (edge case, typage, robustesse, bug) et correction attendue"),
      }),
    )
    .describe("Liste des problèmes trouvés ; vide si verdict = 'approve'"),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;
