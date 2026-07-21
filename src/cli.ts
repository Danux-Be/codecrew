import { Command } from "commander";
import prompts from "prompts";
import { resolve } from "node:path";

import { ConfigManager } from "./config/ConfigManager.js";
import { ClaudeClient, type Effort } from "./clients/ClaudeClient.js";
import { GLMClient } from "./clients/GLMClient.js";
import { Orchestrator } from "./orchestrator/Orchestrator.js";
import { logger } from "./ui/logger.js";

const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

function isEffort(value: string): value is Effort {
  return (EFFORT_VALUES as readonly string[]).includes(value);
}

export async function main(argv: string[]): Promise<void> {
  const config = new ConfigManager();
  const program = new Command();

  program
    .name("codecrew")
    .description(
      "Fait collaborer Claude (architecte/reviewer) et GLM (implémenteur) sur un projet de code local.",
    )
    .version("0.1.0");

  program
    .command("config")
    .description("Configurer les clés API et les préférences de codecrew")
    .option("--show", "Afficher la configuration actuelle (clés masquées)")
    .action(async (opts: { show?: boolean }) => {
      if (opts.show) {
        const cfg = config.getAll();
        logger.title("Configuration actuelle");
        console.log(`Fichier          : ${config.path}`);
        console.log(`Anthropic API key: ${ConfigManager.mask(cfg.anthropicApiKey)}`);
        console.log(`Modèle Claude    : ${cfg.claudeModel}`);
        console.log(`GLM API key      : ${ConfigManager.mask(cfg.glmApiKey)}`);
        console.log(`GLM base URL     : ${cfg.glmBaseUrl}`);
        console.log(`Modèle GLM       : ${cfg.glmModel}`);
        console.log(`Effort par défaut: ${cfg.defaultEffort}`);
        console.log(`Itérations max   : ${cfg.maxReviewIterations}`);
        return;
      }
      await runConfigWizard(config);
    });

  program
    .argument("[task...]", "Description de la tâche à réaliser")
    .option("-f, --files <glob>", "Glob des fichiers à fournir comme contexte explicite")
    .option(
      "-e, --effort <level>",
      "Niveau d'effort pour Claude (low|medium|high|xhigh|max)",
    )
    .option("-i, --max-iterations <n>", "Nombre max d'allers-retours GLM/Claude par étape", (v) => parseInt(v, 10))
    .option("-t, --test <command>", "Commande à exécuter après implémentation (ex: \"npm test\")")
    .option("--dry-run", "N'écrit rien sur disque, affiche seulement le plan et les diffs proposés")
    .option("-r, --root <path>", "Répertoire racine du projet (par défaut : répertoire courant)")
    .action(async (taskParts: string[], opts) => {
      const task = taskParts.join(" ").trim();
      if (!task) {
        program.help();
        return;
      }

      if (!config.isConfigured()) {
        logger.warn("codecrew n'est pas encore configuré (clés API manquantes).");
        await runConfigWizard(config);
      }

      const cfg = config.getAll();
      if (!cfg.anthropicApiKey || !cfg.glmApiKey) {
        logger.error("Configuration incomplète : impossible de continuer sans les deux clés API.");
        process.exitCode = 1;
        return;
      }

      const effort = typeof opts.effort === "string" && isEffort(opts.effort) ? opts.effort : cfg.defaultEffort;
      const maxIterations =
        typeof opts.maxIterations === "number" && Number.isFinite(opts.maxIterations) && opts.maxIterations > 0
          ? opts.maxIterations
          : cfg.maxReviewIterations;
      const root = resolve(typeof opts.root === "string" ? opts.root : process.cwd());

      const claude = new ClaudeClient({ apiKey: cfg.anthropicApiKey, model: cfg.claudeModel, effort });
      const glm = new GLMClient({ apiKey: cfg.glmApiKey, baseUrl: cfg.glmBaseUrl, model: cfg.glmModel });
      const orchestrator = new Orchestrator(claude, glm);

      try {
        await orchestrator.run({
          task,
          root,
          filesGlob: typeof opts.files === "string" ? opts.files : undefined,
          effort,
          maxIterations,
          testCommand: typeof opts.test === "string" ? opts.test : undefined,
          dryRun: Boolean(opts.dryRun),
        });
      } catch (err) {
        logger.stopSpinner();
        logger.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  await program.parseAsync(argv);
}

async function runConfigWizard(config: ConfigManager): Promise<void> {
  const current = config.getAll();
  logger.title("Configuration de codecrew");

  const answers = await prompts(
    [
      {
        type: "password",
        name: "anthropicApiKey",
        message: "Clé API Anthropic (Claude)",
        initial: current.anthropicApiKey ?? "",
      },
      {
        type: "text",
        name: "claudeModel",
        message: "Modèle Claude",
        initial: current.claudeModel,
      },
      {
        type: "password",
        name: "glmApiKey",
        message: "Clé API GLM (Z.ai / Zhipu, compatible protocole Anthropic)",
        initial: current.glmApiKey ?? "",
      },
      {
        type: "text",
        name: "glmBaseUrl",
        message: "URL de base de l'API GLM (endpoint compatible Anthropic)",
        initial: current.glmBaseUrl,
      },
      {
        type: "text",
        name: "glmModel",
        message: "Modèle GLM",
        initial: current.glmModel,
      },
      {
        type: "select",
        name: "defaultEffort",
        message: "Niveau d'effort par défaut pour Claude",
        choices: EFFORT_VALUES.map((v) => ({ title: v, value: v })),
        initial: EFFORT_VALUES.indexOf(current.defaultEffort),
      },
      {
        type: "number",
        name: "maxReviewIterations",
        message: "Nombre max d'itérations de correction par étape",
        initial: current.maxReviewIterations,
        min: 1,
        max: 10,
      },
    ],
    { onCancel: () => process.exit(1) },
  );

  if (answers.anthropicApiKey) config.set("anthropicApiKey", answers.anthropicApiKey);
  if (answers.claudeModel) config.set("claudeModel", answers.claudeModel);
  if (answers.glmApiKey) config.set("glmApiKey", answers.glmApiKey);
  if (answers.glmBaseUrl) config.set("glmBaseUrl", answers.glmBaseUrl);
  if (answers.glmModel) config.set("glmModel", answers.glmModel);
  if (answers.defaultEffort) config.set("defaultEffort", answers.defaultEffort);
  if (answers.maxReviewIterations) config.set("maxReviewIterations", answers.maxReviewIterations);

  logger.success(`Configuration enregistrée dans ${config.path}`);
}
