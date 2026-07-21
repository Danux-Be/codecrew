import Conf from "conf";

export interface CodecrewConfig {
  anthropicApiKey?: string;
  claudeModel: string;
  glmApiKey?: string;
  /** Endpoint compatible protocole Anthropic (ex: GLM Coding Plan via api.z.ai/api/anthropic). */
  glmBaseUrl: string;
  glmModel: string;
  defaultEffort: "low" | "medium" | "high" | "xhigh" | "max";
  maxReviewIterations: number;
  /** Active la détection/l'utilisation d'un 3ème agent local (Ollama) si présent. */
  ollamaEnabled: boolean;
  ollamaBaseUrl: string;
  /** Modèle Ollama à utiliser ; vide = auto-détection du premier modèle installé. */
  ollamaModel: string;
}

const DEFAULTS: CodecrewConfig = {
  claudeModel: "claude-opus-4-8",
  glmBaseUrl: "https://api.z.ai/api/anthropic",
  glmModel: "glm-4.6",
  defaultEffort: "high",
  maxReviewIterations: 2,
  ollamaEnabled: true,
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "",
};

/**
 * Gestionnaire de configuration persistante (clés API, modèles, réglages).
 * Stocke un JSON dans le dossier de config standard de l'OS
 * (ex: ~/.config/codecrew-nodejs/config.json sous Linux) via `conf`.
 */
export class ConfigManager {
  private readonly store: Conf<CodecrewConfig>;

  constructor() {
    this.store = new Conf<CodecrewConfig>({
      projectName: "codecrew",
      defaults: DEFAULTS,
    });
  }

  get path(): string {
    return this.store.path;
  }

  getAll(): CodecrewConfig {
    return {
      anthropicApiKey: this.store.get("anthropicApiKey"),
      claudeModel: this.store.get("claudeModel"),
      glmApiKey: this.store.get("glmApiKey"),
      glmBaseUrl: this.store.get("glmBaseUrl"),
      glmModel: this.store.get("glmModel"),
      defaultEffort: this.store.get("defaultEffort"),
      maxReviewIterations: this.store.get("maxReviewIterations"),
      ollamaEnabled: this.store.get("ollamaEnabled"),
      ollamaBaseUrl: this.store.get("ollamaBaseUrl"),
      ollamaModel: this.store.get("ollamaModel"),
    };
  }

  set<K extends keyof CodecrewConfig>(key: K, value: CodecrewConfig[K]): void {
    this.store.set(key, value);
  }

  isConfigured(): boolean {
    const cfg = this.getAll();
    return Boolean(cfg.anthropicApiKey && cfg.glmApiKey);
  }

  /** Masque une clé API pour affichage (ex: "sk-ant-...xyz1"). */
  static mask(key: string | undefined): string {
    if (!key) return "(non configurée)";
    if (key.length <= 8) return "*".repeat(key.length);
    return `${key.slice(0, 6)}${"*".repeat(Math.max(4, key.length - 10))}${key.slice(-4)}`;
  }
}
