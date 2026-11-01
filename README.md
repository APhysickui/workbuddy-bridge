# WorkBuddy Bridge

[English](README.md) · [简体中文](README.zh-CN.md)

Use WorkBuddy models in **Codex CLI, Pi, Claude Code, Kimi Code, and local API clients** through the authenticated official CodeBuddy CLI. Model names carry a **（workbuddy）** suffix. Pi and Claude default to **DeepSeek V4.1 Flash**; the Kimi launcher defaults to **Kimi K3**. The catalog contains 19 entries covering DeepSeek, GLM, Kimi, MiniMax, Hunyuan, and official automatic tiers.

This local bridge uses the CLI's normal login, without extracting desktop tokens.

**Experimental.** Protocol, process, and isolated-client tests are available; real-account end-to-end behavior must be verified in your environment. Client tools use CodeBuddy's native MCP function handoff by default. Publicly exposed thinking deltas stream live; final text and tool calls are sent after validation. See [compatibility](docs/compatibility.md), [models and limits](docs/models.md), and [configuration](docs/configuration.md).

## Prerequisites

Requires Node.js **22.9+**, an installed official CodeBuddy CLI that can answer normally, and the Codex / Pi / Claude / Kimi clients you want to use. The project has no npm dependencies; Claude passthrough to an existing provider additionally requires system `curl`.

The WorkBuddy desktop app does not need to stay open for model calls. Pi's WorkBuddy extension launches the CLI directly. Codex, Kimi, and Claude integrations need the local bridge service in the background; startup hooks check and start it automatically.

```sh
cd workbuddy-bridge
npm run init
```

Initialization creates a random local key and mock configuration, preserving an existing `.env`. After installing and logging in to the official CodeBuddy CLI, edit `.env`:

```dotenv
BRIDGE_BACKEND=workbuddy
CODEBUDDY_BIN=/absolute/path/to/codebuddy
```

Use `command -v codebuddy` to locate the entry point. `CODEBUDDY_BIN` must point to the official CLI's JavaScript file, which the bridge launches with Node. Other options are listed in `.env.example`. Run `npm run doctor` to check paths and configuration without making a model request.

## Codex CLI

Use WorkBuddy models and client-side tools in Codex:

```sh
npm run bridge:restart    # Load protocol 8 if an older bridge is running
npm run codex
npm run codex -- --model kimi-k3-1 --cwd /path/to/project
npm run codex:check       # Real short reply + random-file read; consumes credits
```

Launcher options apply only to that process, preserving global Codex configuration and login. Supported Responses features include text, exposed thinking, function tools, namespaces, and the `apply_patch` text tool. Codex executes tools under its own sandbox and approval rules. The currently validated client version is Codex CLI 0.163.0; verify real-model workflows in a normal terminal. See the [Codex integration guide](docs/codex.md).

## Pi

Run from the project directory:

```sh
npm run pi
```

Use `/model` to select a **（workbuddy）** entry from provider **`workbuddy-cli`**. The extension invokes the official CLI inside the Pi process, without an HTTP service or additional API key. On first use, follow Pi's normal project-extension trust flow.

To run plain `pi` from any directory, inspect and apply the global integration:

```sh
npm run pi:unify
npm run pi:unify -- --apply
pi
```

The script backs up and updates `~/.pi/agent`, removes the old local WorkBuddy provider, and registers this project's extension. Other providers and the default model are preserved; a default pointing to the old WorkBuddy setup migrates to V4.1 Flash. Register the extension again if the project moves. After model updates, use `/reload` or restart Pi.

## Claude Code

First make sure `~/.claude/settings.json` contains a working URL and authentication for the existing provider. Then enable passthrough in `.env`:

```dotenv
BRIDGE_CLAUDE_PASSTHROUGH=1
```

Run in the project directory:

```sh
npm run claude:install
npm run bridge:restart
claude
```

Enter `/model` and select an entry ending in **（workbuddy）**, or launch explicitly:

```sh
claude --model claude-workbuddy-deepseek-v4.1-flash
```

Another example is `/model claude-workbuddy-glm-5.3-flash`. Claude model discovery filters ordinary non-Claude IDs, so its menu uses `claude-workbuddy-` aliases that the bridge maps to official model IDs. Pi and OpenAI clients use the original IDs.

Installation enables gateway model discovery and a startup hook in this project's `.claude/settings.local.json`, preserving the original Claude menu and default tier. WorkBuddy selections go through the official CLI; other models pass through to the original provider. Existing authentication is read at runtime and is not copied into the project. On first launch or after an update, run `bridge:restart` so the service is ready before model discovery.

**Project settings apply only in this directory and its descendants.** Follow Claude's normal project-trust flow on first use. Remove the integration with `npm run claude:uninstall`. `npm run claude` is a separate isolated debugging launcher; for regular use, follow the steps above and run `claude` directly.

## Kimi Code

After installing official Kimi Code, run from the project directory:

```sh
npm run kimi
```

To start from another directory or choose a model:

```sh
npm --prefix /absolute/path/to/workbuddy-bridge run kimi -- --cwd "$PWD" --model kimi-k3-1
```

The launcher checks and starts the bridge, then verifies a real short reply with the selected model. A failed preflight stops with a specific error instead of opening an unusable session. **Preflight consumes credits.** It opens a new session by default using `.runtime/kimi-profile`, rather than automatically resuming sessions from the original Kimi account. Pass `--continue` to continue a session in this profile.

Kimi uses the Anthropic text and client-tool interface. Context and output limits come from the model catalog; Kimi K3 defaults to a 300,000-token context and a 32,000-token maximum output. Thinking exposed by the CLI can be displayed; images are not supported. Auxiliary models use the WorkBuddy entry selected at launch. Use `/model` to choose another model in the same profile.

The isolated launcher does not modify `~/.kimi-code` configuration or sessions. To use plain `kimi`, install into the configuration it actually reads:

```sh
npm run kimi:install               # Inspect migration; no model request
npm run kimi:install -- --apply    # Back up and update regular Kimi configuration
kimi
```

Installation replaces only known local WorkBuddy providers and their models, preserving other providers and user hooks. If the original default was WorkBuddy, thinking and auxiliary-model settings are also corrected. WorkBuddy uses the Anthropic interface on this project's port, with budgets from the catalog. A startup hook checks and starts the bridge for new sessions. The local bridge key is written into private user configuration, not the repository. Exit and reopen an old client to avoid retaining a session's previous 64K settings.

If an old Pi session still selects `workbuddy / deepseek-v4-flash` at port 8799, loading the extension redirects that process to the official CLI and explicitly migrates it to `workbuddy-cli / deepseek-v4.1-flash`. Cancel retries and run `/reload`; when choosing manually, select a **（workbuddy）** entry under `[workbuddy-cli]`. Only verified old local addresses belonging to this project are intercepted. Other providers and global `models.json` are not rewritten. To clean up permanently, exit Pi and run `npm run pi:unify -- --apply` in a normal terminal; originals are backed up.

If Pi reports malformed tool JSON or Kimi still connects to the old port, run `npm run local:repair` in a normal terminal. It backs up and migrates regular Kimi configuration, restarts the bridge, and verifies real text replies and temporary random-file reads in Pi and Kimi. It consumes credits and prints `LOCAL_REPAIR_OK` only when every check passes. `npm run local:repair -- --plan` previews the plan.

If the first three checks pass and only Kimi file reading fails, continue with `npm run local:repair -- --kimi-tools-only`. Kimi 2.1.1 does not allow `--prompt` together with `--yolo`, `--auto`, or `--plan`; project checks use prompt mode's own non-interactive permissions.

If a task says it will read files and then stops, or repeatedly reports `bounded recovery turns`, update and run `npm run bridge:restart`; use `/reload` in Pi. Default `BRIDGE_TOOL_TRANSPORT=native` provides real MCP tool definitions and parameter schemas to the upstream, receives native function requests, and hands them to Kimi / Pi / Claude. The MCP proxy returns handoff notifications and does not execute files or shell commands. The bridge validates tool names, parameters, and tool selection. The old `prompt` transport remains only for compatibility; tool instructions and extra recovery turns alone did not fix the stalled behavior.

After a generation, the upstream hands back tool requests. Only complete, valid native calls allow that specific turn boundary to count as a handoff; genuine errors remain errors. An explicit promise to act without a tool call receives at most one recovery attempt within the original timeout. After changing integration methods, validate in a new session to avoid history from repeated stalled attempts.

Use `npm run agent:check -- --model kimi-k3-1` to verify task continuation. It requires the real model to read two temporary random files in sequence and return a marker found only in the second, without a “continue” prompt. It consumes credits and validates the model/bridge adapter tool sequence; the client UI and original long-running session still require observation.

See the [Kimi guide](docs/kimi.md) for details and old 8799 / 64K configuration issues. `npm run kimi:check` validates real text and file reading with the isolated launcher. Configuration parsing and fixtures do not prove real-account calls work; run the online checks in your own environment.

## Thinking display and review

The bridge preserves public `thinking` blocks from the official CLI and streams deltas to Pi / Kimi / Claude Anthropic clients. Final answers and tool calls are sent after JSON and parameter validation. If the CLI provides only a final thinking snapshot, it appears at completion. When a model or request exposes no thinking, only the answer is shown. The bridge does not invent reasoning from the answer or read private debug metadata.

After updating Pi, use `/reload` or restart. `Ctrl+T` expands or collapses thinking. It is retained in Pi session history and can be exported with `/export review.html`; tool records and file diffs remain the client's responsibility. The CLI's default effort is `low`. Pi's selected reasoning level and Anthropic `output_config.effort` are forwarded; other requests use `.env`'s `BRIDGE_REASONING_EFFORT`. Native token budgets and forced thinking-disable options do not guarantee equivalent behavior.

After updating Kimi / Claude, run `npm run bridge:restart` to load the protocol. For regular Kimi, also run `npm run kimi:install -- --apply` to back up and enable thinking display, then restart old sessions. The isolated Kimi launcher generates a new profile automatically. OpenAI Chat Completions returns `reasoning_content` after completion rather than streaming it.

## Other API clients

```sh
npm start
```

Set the OpenAI base URL to `http://127.0.0.1:18765/v1` or the Anthropic base URL to `http://127.0.0.1:18765`. Use `.env`'s `BRIDGE_API_KEY` as the API key. The service supports text subsets of `/v1/chat/completions`, `/v1/responses`, and `/v1/messages`; see the [compatibility table](docs/compatibility.md). HTTP listens only on the loopback interface.

## Verification and maintenance

```sh
npm run check          # Syntax and model-catalog checks; no upstream call
npm test               # Protocol, process, migration, and optional client tests
npm run models         # Models and default context/output limits
npm run doctor         # Path/configuration diagnostics; no model call
npm run bridge:restart # Update and start the background HTTP service
npm run bridge:stop    # Authenticated HTTP-service shutdown
```

Real-account validation:

```sh
npm run integration:check
```

This checks WorkBuddy tool round trips and real Claude/Pi text replies and temporary random-file reads. It makes real model calls and may consume credits. A working official CLI does not by itself prove bridge end-to-end success. Isolated client checks are skipped when a local client is absent; CI requires no account.

WorkBuddy uses credits. A zero dollar rate in Pi is an unknown-price placeholder, **not a claim that usage is free**. Shared credits, model access, and prices follow the [official pricing information](https://www.codebuddy.cn/docs/workbuddy/Pricing) and your account records. The model list is an official-catalog snapshot dated 2026-10-06 and does not guarantee every account can call every model. Images, audio, and the full native session protocol are not supported; history is still submitted as a JSON conversation prompt. Thinking depends on actual CLI output. Failures do not automatically switch providers.

Do not commit `.env`, local Claude settings, runtime logs, or private debug records. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and [LICENSE](LICENSE) for the MIT license.

## Buddy daily check-in credits (experimental)

With WorkBuddy logged in in the background, you can try claiming daily check-in credits through the app's own local channel, subject to official campaign rules. Run `npm run credits:install` in a normal macOS terminal: it first verifies a real check-in, then installs a daily 09:05 job with hourly catch-up checks. Query only with `npm run credits:status`; remove with `npm run credits:uninstall`. The development environment restricts local socket access, so actual credit collection has not yet been verified. Device verification stops the process rather than being bypassed. See the [check-in script guide](tools/daily-checkin/README.md).
