# codecrew

**Open-source CLI that makes two (or three) AIs collaborate — Claude and GLM, plus an optional local model — on the same local codebase**, in the spirit of [Claude Code](https://github.com/anthropics/claude-code), to maximize the quality of development, refactoring, and debugging work.

Claude plays the **architect and reviewer**; GLM plays the **implementer**; a local model (Ollama), if detected, opportunistically handles trivial mechanical steps to save Claude/GLM tokens. Each agent does what it's best at, and you watch them collaborate in real time in your terminal.

## Why codecrew?

- **Separation of concerns**: planning and review (edge cases, typing, robustness) go to a reasoning-oriented model (Claude); raw code authoring goes to a fast model (GLM).
- **Automatic quality loop**: every step is reviewed by Claude before being considered done; if there are objections, GLM revises, up to a configurable number of iterations.
- **Full transparency**: every exchange (plan, generated code, diff, review verdict) is printed to the terminal with clear visual attribution (Claude in blue, GLM in green, the local agent in magenta).
- **Resilient by design**: if either paid agent runs out of credit/quota mid-run, codecrew automatically falls back to the other rather than crashing (see [Resilience](#resilience-automatic-fallback) below).
- **Local and scriptable**: no data goes anywhere except the configured APIs; the CLI drops into any existing project.

## Roles

| Agent | Role | Responsibilities |
| --- | --- | --- |
| **Claude** | Architect & Reviewer | Analyzes the project, breaks the task down into a precise implementation plan (targeted files, unambiguous instructions), then reviews every diff produced by GLM and requests changes if needed. |
| **GLM** | Implementer | Writes the full content of files from the plan's instructions, and rewrites whatever's needed based on review feedback. |
| **Ollama (optional, local)** | Cheap implementer for trivial steps | Auto-detected on `localhost:11434`. Handles only the plan steps the architect flagged as `trivial` (boilerplate, simple config files, static text) — never planning or review. Falls back silently to GLM on any failure. |

## Prerequisites

- Node.js ≥ 20
- An [Anthropic](https://console.anthropic.com/) API key (Claude), with available credit
- A GLM API key exposing an **Anthropic-protocol-compatible** endpoint — typically the [Z.ai GLM Coding Plan](https://z.ai/manage-apikey/apikey-list) (`https://api.z.ai/api/anthropic`), with quota/credit available on that specific plan (distinct from any regular chat subscription)
- Optional: [Ollama](https://ollama.com/) running locally with at least one model installed, if you want the 3rd local agent

## Installation

```bash
git clone https://github.com/Danux-Be/codecrew.git
cd codecrew
npm install
npm run build
npm link   # makes the `codecrew` command available globally
```

## Configuration

```bash
codecrew config
```

Interactively asks for:
- your Anthropic API key (Claude)
- the Claude model to use (defaults to `claude-opus-4-8`)
- your GLM API key
- the base URL (defaults to `https://api.z.ai/api/anthropic`) and GLM model (e.g. `glm-4.6`, `glm-5.2`)
- the default effort level (Claude's thinking depth) and the max number of correction iterations per step
- whether to enable the local Ollama agent, its base URL, and (optionally) which model to use — leave the model blank to auto-detect the first one installed

> **Technical note:** `codecrew` speaks the Anthropic protocol (Messages API) with both paid agents — natively for Claude, and via its compatible endpoint for GLM (Z.ai's GLM Coding Plan, authenticated with a bearer token). If your GLM key comes from a provider exposing a classic OpenAI-compatible endpoint instead (e.g. `bigmodel.cn/api/paas/v4`), it won't work as-is with this version.

Keys are stored locally in the OS's standard config directory (never committed, never sent anywhere except the respective APIs).

```bash
codecrew config --show   # shows the current configuration (keys masked)
```

## Usage

### One-shot (scripts, CI)

```bash
codecrew "Add email validation to the signup form"
```

Example with explicit context, tests, and a run mode:

```bash
codecrew "Fix pagination on the /users API" \
  --files "src/api/**/*.ts" \
  --test "npm test" \
  --effort high \
  --mode manual
```

### Interactive session

Run `codecrew` with no arguments to launch a persistent, Claude-Code-style interactive session: a header showing the current mode and a live green/red/grey status bubble per agent, a scrolling transcript, and an input bar at the bottom where you can submit any number of tasks one after another without restarting the process.

```bash
codecrew
```

Inside the session:

| Key / command | Effect |
| --- | --- |
| `Shift+Tab` | Cycle the run mode: `auto` → `plan` → `manual` → `auto` |
| `Ctrl+Q` | Quit the session |
| `/config` | Show the current configuration (models, effort, iteration cap) |
| `/model` | Pick a model for Claude, GLM, or the local agent from a menu (Ollama's list is live-detected); persists to config and applies immediately, no restart needed |
| `/background` | Save the session's transcript and agent status to disk, then exit — resume later with `codecrew --resume` |
| `/exit` | Quit the session (same effect as `Ctrl+Q`) |

> **`/background` scope**: this saves and restores the visible transcript/context so you can pick a conversation back up — it does **not** keep a task actually running while you're disconnected. If a task is in progress, finish it (or let it fail over) before backgrounding.

### Run modes

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Fully autonomous — plans, implements every step with review/fallback, applies changes. |
| `plan` | Generates and shows the plan, then stops. No implementation, no review, nothing written. |
| `manual` | Pauses once per step, before that step's first implementation attempt, for a yes/no confirmation. Declining aborts the run. |

`--dry-run` is orthogonal to modes: it still implements and reviews every step (diffs shown) but never writes to disk — combine it with any mode.

### Options (one-shot command)

| Option | Description |
| --- | --- |
| `-f, --files <glob>` | Files to provide as explicit context (e.g. `"src/**/*.ts"`) |
| `-e, --effort <level>` | `low\|medium\|high\|xhigh\|max` — Claude's thinking depth |
| `-i, --max-iterations <n>` | Max GLM ↔ Claude round-trips per step |
| `-t, --test <command>` | Command to run after implementation (e.g. `"npm test"`) |
| `--dry-run` | Writes nothing to disk, only shows the plan and proposed diffs |
| `-r, --root <path>` | Project root (defaults to the current directory) |
| `--no-local` | Disables the local agent (Ollama) for this run, even if detected |
| `--local-model <name>` | Forces which Ollama model to use (otherwise auto-detected) |
| `-m, --mode <mode>` | Run mode: `auto` (default) \| `plan` \| `manual` — `manual` requires a real TTY |
| `--resume [id]` | Launches the interactive session resuming a saved one (latest if no id given) |

## Pipeline

```
User task
      │
      ▼
1. Local context (file tree + targeted files)
      │
      ▼
2. Claude ─── generates a structured plan (steps, files, instructions, complexity)
      │
      ▼
3. For each step:
      trivial? ──yes──► Ollama implements (local) ──┐
           │no                                       │
           ▼                                         │
      GLM implements ◄─────────────────────────────┘
           │
           ▼
      Claude reviews the actual diff ──► approved?
           ▲                                │ no
           └──────────── correction feedback ◄┘
           │ yes
           ▼
4. Files written to disk (unless --dry-run)
      │
      ▼
5. Optional test run (--test)
```

## Resilience (automatic fallback)

Claude and GLM speak the same protocol (Anthropic Messages API), so each can fill the other's role when needed. If one runs out of credit/quota mid-run, `codecrew` switches over automatically instead of aborting:

- **GLM unavailable** → Claude implements the step itself; review continues as normal (same quality, just slower/costlier on the Claude side).
- **Claude unavailable** → GLM generates the plan and implements, but **independent review is disabled** for the rest of the run — codecrew tells you clearly rather than faking a self-review with the same model (which would be worthless).
- **Both unavailable** → explicit failure, nothing more to do.

Detection relies on HTTP 429 responses and error messages explicitly mentioning insufficient credit/balance/quota — a genuine transient rate limit can also trigger a fallback (an accepted trade-off: better to switch agents unnecessarily than to crash the whole pipeline).

The local Ollama agent follows a separate, simpler rule: it's only ever tried for steps the architect explicitly marked `trivial`, and any failure (model not installed, service down, malformed response) makes it fall back to GLM silently for that step, without affecting Claude/GLM availability.

## Security

- Every file write is confined to the project root (`--root`): no path can escape it (`..`, absolute paths).
- API keys are never logged or shown in clear text (`config --show` masks them).
- **codecrew modifies files on disk.** Work on a clean Git checkout (or use `--dry-run`) so you can easily roll back.

## Status

v0.1 — functional, usable skeleton; a foundation meant to evolve (see ideas below).

### Roadmap ideas

- Support for additional tools (running linters, auto-fixing test failures)
- Partial patch/diff generation instead of the whole file on every iteration
- Support for other implementers (Qwen, DeepSeek, etc.) through a common interface
- True detached background execution (`/background` currently saves/restores the transcript, not an in-flight task)
- Slash-command access to `--files`/`--test` from within the interactive session (currently one-shot only)

## Contributing

Contributions are welcome: open an issue or a pull request on [the GitHub repo](https://github.com/Danux-Be/codecrew).

## License

[MIT](LICENSE)
