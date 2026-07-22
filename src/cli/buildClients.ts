import { ClaudeClient, type Effort } from "../clients/ClaudeClient.js";
import { GLMClient } from "../clients/GLMClient.js";
import { detectOllama, OllamaClient } from "../clients/OllamaClient.js";
import type { CodecrewConfig } from "../config/ConfigManager.js";
import { logger } from "../ui/logger.js";

export interface BuildClientsOptions {
  effort: Effort;
  /** Passe `false` pour désactiver l'agent local pour cet appel (ex: --no-local). */
  localEnabled?: boolean;
  /** Force le modèle Ollama à utiliser (sinon config puis auto-détection). */
  localModel?: string;
}

export interface BuiltClients {
  claude: ClaudeClient;
  glm: GLMClient;
  ollama?: OllamaClient;
}

/**
 * Construit les clients Claude/GLM (toujours) et Ollama (si activé et
 * détecté) à partir de la configuration persistée. Partagé entre le CLI
 * one-shot et la session interactive : un seul endroit sait construire et
 * détecter les agents.
 */
export async function buildClients(cfg: CodecrewConfig, options: BuildClientsOptions): Promise<BuiltClients> {
  if (!cfg.anthropicApiKey || !cfg.glmApiKey) {
    throw new Error("Configuration incomplète : impossible de continuer sans les deux clés API.");
  }

  const claude = new ClaudeClient({ apiKey: cfg.anthropicApiKey, model: cfg.claudeModel, effort: options.effort });
  const glm = new GLMClient({ apiKey: cfg.glmApiKey, baseUrl: cfg.glmBaseUrl, model: cfg.glmModel });

  let ollama: OllamaClient | undefined;
  if (cfg.ollamaEnabled && options.localEnabled !== false) {
    const detection = await detectOllama(cfg.ollamaBaseUrl);
    const model = options.localModel || cfg.ollamaModel || detection.models[0];
    if (detection.available && model) {
      ollama = new OllamaClient({ baseUrl: cfg.ollamaBaseUrl, model });
      logger.info(`Agent local détecté : Ollama (${model}) — utilisé pour les étapes triviales du plan.`);
    } else if (detection.available) {
      logger.info("Ollama détecté mais aucun modèle installé — agent local désactivé pour ce run.");
    }
  }

  return { claude, glm, ollama };
}
