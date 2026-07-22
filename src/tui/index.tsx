import { render } from "ink";

import type { ConfigManager } from "../config/ConfigManager.js";
import { App } from "./App.js";

export interface InteractiveSessionOptions {
  configManager: ConfigManager;
  root: string;
  maxIterations: number;
  resumeId?: string | true;
}

/** Lance la session interactive (TUI Ink) et attend sa fermeture. */
export async function runInteractiveSession(options: InteractiveSessionOptions): Promise<void> {
  // Ouverture "pleine page" : nettoie l'écran visible et replace le curseur
  // en haut, sans purger le scrollback (contrairement à un vrai buffer
  // alterné façon vim/htop — non implémenté ici, voir le README).
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[H");
  }

  const { waitUntilExit } = render(<App {...options} />);
  await waitUntilExit();
}
