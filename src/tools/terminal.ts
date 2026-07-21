import { execa } from "execa";

export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Exécute une commande shell dans le répertoire du projet (tests, linters...).
 * Ne lève jamais d'exception sur un code de sortie non nul : le résultat
 * (succès ou échec) est retourné pour que l'orchestrateur/Claude puisse
 * décider de la suite (ex: relancer une correction).
 */
export async function runCommand(
  commandLine: string,
  cwd: string,
  timeoutMs = 5 * 60_000,
): Promise<CommandResult> {
  try {
    const result = await execa(commandLine, {
      cwd,
      shell: true,
      timeout: timeoutMs,
      reject: false,
      all: true,
    });
    return {
      command: commandLine,
      exitCode: result.exitCode ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: result.timedOut ?? false,
    };
  } catch (err) {
    return {
      command: commandLine,
      exitCode: null,
      stdout: "",
      stderr: (err as Error).message,
      timedOut: false,
    };
  }
}
