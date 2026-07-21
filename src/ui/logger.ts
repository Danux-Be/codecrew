import chalk from "chalk";
import ora, { type Ora } from "ora";

/**
 * Petite couche d'affichage terminal. Distingue visuellement les
 * interventions de Claude (bleu, rôle architecte/reviewer) et de GLM
 * (vert, rôle implémenteur) pour que l'utilisateur suive l'échange
 * entre les deux IA sans se perdre.
 */

const claudeTag = chalk.bgBlue.black.bold(" CLAUDE ");
const glmTag = chalk.bgGreen.black.bold("  GLM   ");
const systemTag = chalk.bgGray.white.bold(" SYSTEM ");

let activeSpinner: Ora | null = null;

function stopActiveSpinner(): void {
  if (activeSpinner) {
    activeSpinner.stop();
    activeSpinner = null;
  }
}

export const logger = {
  title(text: string): void {
    stopActiveSpinner();
    console.log("\n" + chalk.bold.underline(text));
  },

  system(text: string): void {
    stopActiveSpinner();
    console.log(`${systemTag} ${chalk.gray(text)}`);
  },

  claude(text: string): void {
    stopActiveSpinner();
    console.log(`${claudeTag} ${chalk.blueBright(text)}`);
  },

  glm(text: string): void {
    stopActiveSpinner();
    console.log(`${glmTag} ${chalk.greenBright(text)}`);
  },

  info(text: string): void {
    stopActiveSpinner();
    console.log(chalk.dim(text));
  },

  success(text: string): void {
    stopActiveSpinner();
    console.log(chalk.green.bold("✔ ") + text);
  },

  warn(text: string): void {
    stopActiveSpinner();
    console.log(chalk.yellow.bold("⚠ ") + chalk.yellow(text));
  },

  error(text: string): void {
    stopActiveSpinner();
    console.error(chalk.red.bold("✖ ") + chalk.red(text));
  },

  /** Démarre un spinner attribué à un des deux agents (ou au système). */
  spinner(actor: "claude" | "glm" | "system", text: string): Ora {
    stopActiveSpinner();
    const tag = actor === "claude" ? claudeTag : actor === "glm" ? glmTag : systemTag;
    const color = actor === "claude" ? chalk.blueBright : actor === "glm" ? chalk.greenBright : chalk.gray;
    activeSpinner = ora({ text: `${tag} ${color(text)}` }).start();
    return activeSpinner;
  },

  stopSpinner(): void {
    stopActiveSpinner();
  },

  /** Affiche un diff unifié coloré (+ vert, - rouge, contexte gris). */
  diff(unifiedDiff: string): void {
    stopActiveSpinner();
    const lines = unifiedDiff.split("\n");
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        console.log(chalk.green(line));
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        console.log(chalk.red(line));
      } else if (line.startsWith("@@")) {
        console.log(chalk.cyan(line));
      } else if (line.startsWith("+++") || line.startsWith("---")) {
        console.log(chalk.bold(line));
      } else {
        console.log(chalk.dim(line));
      }
    }
  },
};
