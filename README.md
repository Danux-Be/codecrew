# codecrew

**CLI open-source qui fait collaborer deux IA — Claude et GLM — sur un même projet de code local**, dans la lignée de [Claude Code](https://github.com/anthropics/claude-code), pour maximiser la qualité du développement, du refactoring et du debugging.

Claude joue l'**architecte et le reviewer** ; GLM joue l'**implémenteur**. Chacun fait ce qu'il fait le mieux, et l'utilisateur voit les deux IA échanger en temps réel dans son terminal.

## Pourquoi codecrew ?

- **Séparation des responsabilités** : la planification et la relecture (édge cases, typage, robustesse) sont confiées à un modèle orienté raisonnement (Claude) ; l'écriture de code brut à un modèle rapide (GLM).
- **Boucle de qualité automatique** : chaque étape est relue par Claude avant d'être considérée comme terminée ; en cas de réserve, GLM corrige, dans la limite d'un nombre d'itérations configurable.
- **Transparence totale** : chaque échange (plan, code généré, diff, verdict de relecture) est affiché dans le terminal avec une identification visuelle claire (Claude en bleu, GLM en vert).
- **Local et scriptable** : aucune donnée ne transite ailleurs que vers les deux API configurées ; le CLI s'intègre dans n'importe quel projet existant.

## Rôles

| Agent | Rôle | Responsabilités |
| --- | --- | --- |
| **Claude** | Architecte & Reviewer | Analyse le projet, découpe la tâche en plan d'implémentation précis (fichiers ciblés, instructions non ambiguës), puis relit chaque diff produit par GLM et demande des corrections si nécessaire. |
| **GLM** | Implémenteur | Écrit le contenu complet des fichiers à partir des instructions du plan, et réécrit ce qui est nécessaire suite au feedback de relecture. |

## Prérequis

- Node.js ≥ 20
- Une clé API [Anthropic](https://console.anthropic.com/) (Claude), avec du crédit disponible
- Une clé API GLM exposant un endpoint **compatible protocole Anthropic** — typiquement le [GLM Coding Plan de Z.ai](https://z.ai/manage-apikey/apikey-list) (`https://api.z.ai/api/anthropic`), avec quota/crédit disponible sur ce plan spécifiquement (distinct de tout abonnement chat classique)

## Installation

```bash
git clone https://github.com/Danux-Be/codecrew.git
cd codecrew
npm install
npm run build
npm link   # rend la commande `codecrew` disponible globalement
```

## Configuration

```bash
codecrew config
```

Demande interactivement :
- la clé API Anthropic (Claude)
- le modèle Claude à utiliser (par défaut `claude-opus-4-8`)
- la clé API GLM
- l'URL de base (par défaut `https://api.z.ai/api/anthropic`) et le modèle GLM (ex: `glm-4.6`, `glm-5.2`)
- le niveau d'effort par défaut (profondeur de réflexion de Claude) et le nombre max d'itérations de correction par étape

> **Note technique :** `codecrew` parle le protocole Anthropic (Messages API) avec les deux modèles — Claude nativement, et GLM via son endpoint compatible (le GLM Coding Plan de Z.ai, authentifié par jeton porteur). Si ta clé GLM provient d'un autre fournisseur exposant un endpoint compatible OpenAI classique (ex: `bigmodel.cn/api/paas/v4`), elle ne fonctionnera pas telle quelle avec cette version.

Les clés sont stockées localement dans le dossier de configuration standard de l'OS (jamais commitées, jamais envoyées ailleurs qu'aux API respectives).

```bash
codecrew config --show   # affiche la configuration actuelle (clés masquées)
```

## Utilisation

```bash
codecrew "Ajoute une validation d'email au formulaire d'inscription"
```

Exemple avec contexte explicite et tests :

```bash
codecrew "Corrige la pagination de l'API /users" \
  --files "src/api/**/*.ts" \
  --test "npm test" \
  --effort high
```

### Options

| Option | Description |
| --- | --- |
| `-f, --files <glob>` | Fichiers à fournir explicitement comme contexte (ex: `"src/**/*.ts"`) |
| `-e, --effort <level>` | `low\|medium\|high\|xhigh\|max` — profondeur de réflexion de Claude |
| `-i, --max-iterations <n>` | Nombre max d'allers-retours GLM ↔ Claude par étape |
| `-t, --test <command>` | Commande à exécuter après implémentation (ex: `"npm test"`) |
| `--dry-run` | N'écrit rien sur disque, affiche seulement le plan et les diffs proposés |
| `-r, --root <path>` | Racine du projet (défaut : répertoire courant) |

## Pipeline

```
Tâche utilisateur
      │
      ▼
1. Contexte local (arborescence + fichiers ciblés)
      │
      ▼
2. Claude ─── génère un plan structuré (étapes, fichiers, instructions)
      │
      ▼
3. Pour chaque étape :
      GLM implémente ──► Claude relit le diff réel ──► approuvé ?
           ▲                                              │ non
           └──────────── feedback de correction ◄─────────┘
      │ oui
      ▼
4. Écriture des fichiers sur disque (sauf --dry-run)
      │
      ▼
5. Exécution optionnelle des tests (--test)
```

## Résilience (repli automatique)

Claude et GLM parlent le même protocole (Anthropic Messages API), donc chacun peut au besoin remplir le rôle de l'autre. Si l'un des deux tombe à court de crédit/quota en cours de route, `codecrew` bascule automatiquement plutôt que d'interrompre le run :

- **GLM indisponible** → Claude implémente lui-même l'étape ; la relecture continue normalement (qualité inchangée, juste plus lent/coûteux côté Claude).
- **Claude indisponible** → GLM génère le plan et implémente, mais **la relecture indépendante est désactivée** pour le reste du run — `codecrew` te le signale clairement plutôt que de simuler une auto-relecture par le même modèle (qui n'aurait aucune valeur).
- **Les deux indisponibles** → échec explicite, rien d'autre à faire.

La détection se base sur les erreurs HTTP 429 et les messages mentionnant explicitement un crédit/solde/quota insuffisant — un vrai rate-limit transitoire peut donc aussi déclencher un repli (compromis assumé : mieux vaut basculer à tort que planter tout le pipeline).

## Sécurité

- Toute écriture de fichier est confinée à la racine du projet (`--root`) : aucun chemin ne peut s'en échapper (`..`, chemins absolus).
- Les clés API ne sont jamais journalisées ni affichées en clair (`config --show` les masque).
- **codecrew modifie des fichiers sur disque.** Travaillez sur un dépôt Git propre (ou utilisez `--dry-run`) afin de pouvoir revenir en arrière facilement.

## Statut

v0.1 — squelette fonctionnel et utilisable, base d'une architecture destinée à évoluer (voir les idées ci-dessous).

### Pistes d'évolution

- Support d'outils supplémentaires (exécution de linters, auto-fix des échecs de tests)
- Génération de patchs/diffs partiels plutôt que le fichier entier à chaque itération
- Support d'autres implémenteurs (Qwen, DeepSeek, etc.) via une interface commune
- Historique de session et reprise d'une tâche interrompue

## Contribuer

Les contributions sont bienvenues : ouvrez une issue ou une pull request sur [le dépôt GitHub](https://github.com/Danux-Be/codecrew).

## Licence

[MIT](LICENSE)
