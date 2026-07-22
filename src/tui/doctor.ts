import { detectOllama } from "../clients/OllamaClient.js";
import type { CodecrewConfig } from "../config/ConfigManager.js";

async function isReachable(url: string, timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // N'importe quelle réponse HTTP (même 401/404) prouve que l'hôte est
    // joignable — seule une erreur réseau/timeout signale un vrai problème.
    await fetch(url, { method: "GET", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Diagnostic de configuration (commande `/doctor`) : clés API présentes,
 * endpoint GLM joignable, Ollama détecté, version Node — pour déboguer une
 * configuration cassée sans avoir à relire manuellement chaque réglage.
 */
export async function runDoctorChecks(cfg: CodecrewConfig): Promise<string[]> {
  const lines: string[] = [];

  lines.push(`Node        : ${process.version}`);

  lines.push(`Claude      : ${cfg.anthropicApiKey ? `clé présente (modèle ${cfg.claudeModel})` : "✖ clé API manquante"}`);

  if (cfg.glmApiKey) {
    const reachable = await isReachable(cfg.glmBaseUrl);
    lines.push(
      `GLM         : clé présente (modèle ${cfg.glmModel}) — endpoint ${cfg.glmBaseUrl} ${reachable ? "joignable" : "✖ injoignable"}`,
    );
  } else {
    lines.push("GLM         : ✖ clé API manquante");
  }

  if (cfg.ollamaEnabled) {
    const detection = await detectOllama(cfg.ollamaBaseUrl);
    lines.push(
      detection.available
        ? `Ollama      : détecté sur ${cfg.ollamaBaseUrl} (${detection.models.length} modèle(s)${cfg.ollamaModel ? `, configuré: ${cfg.ollamaModel}` : ""})`
        : `Ollama      : activé mais introuvable sur ${cfg.ollamaBaseUrl}`,
    );
  } else {
    lines.push("Ollama      : désactivé");
  }

  return lines;
}
