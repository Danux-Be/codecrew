/** Contexte projet local transmis aux deux modèles. */
export interface ProjectContext {
  /** Répertoire racine du projet. */
  root: string;
  /** Arborescence de fichiers (chemins relatifs), tronquée si trop grande. */
  fileTree: string[];
  /** Fichiers explicitement ciblés par l'utilisateur, avec leur contenu actuel. */
  targetedFiles: Array<{ path: string; content: string }>;
  /** Contenu de CODECREW.md à la racine du projet, s'il existe (conventions, contraintes persistantes). */
  memory?: string;
}

/** Un changement de fichier proposé par l'implémenteur (GLM). */
export interface FileChange {
  path: string;
  content: string;
}

/** Diff calculé entre l'ancien et le nouveau contenu d'un fichier. */
export interface FileDiff {
  path: string;
  before: string;
  after: string;
  unified: string;
  isNew: boolean;
}
