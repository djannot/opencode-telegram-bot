# OpenCode Telegram Bot

A Telegram bot that forwards messages to an [OpenCode](https://opencode.ai) agent and returns the responses. Each chat gets a persistent session, so the agent remembers conversation context across messages.

## 🎥 Demo

https://github.com/user-attachments/assets/e071f536-7036-4e9c-a5fb-c77414626825

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [OpenCode](https://opencode.ai/docs/) installed and configured with at least one provider
- A Telegram bot token (see below)

## Creating a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts:
   - Choose a display name for your bot (e.g. "My OpenCode Bot").
   - Choose a username. It must end in `bot` (e.g. `my_opencode_bot`).
3. BotFather will reply with your **bot token**. It looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`. Copy it.
4. Optionally, send `/setdescription` to BotFather to set a description for your bot.

To find your **Telegram user ID** (for restricting access):

1. Search for [@userinfobot](https://t.me/userinfobot) on Telegram.
2. Send it any message. It will reply with your user ID.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file in the project root:

   ```env
   TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather
   AUTHORIZED_TELEGRAM_USER_ID=your-telegram-user-id
   ```

   `AUTHORIZED_TELEGRAM_USER_ID` is optional. If set, only that user can interact with the bot. If omitted, the bot is open to everyone.

## Usage

You need two processes running: the OpenCode server and the Telegram bot.

**Terminal 1** -- Start the OpenCode server:

```bash
opencode serve
```

This runs `opencode serve` on port 4096. You can pass additional flags:

```bash
opencode serve --port 8080
```

**Terminal 2** -- Start the Telegram bot:

The quickest way is with `npx` (no install required):

```bash
npx opencode-telegram-bot
```

Or install it globally:

```bash
npm install -g opencode-telegram-bot
opencode-telegram-bot
```

The bot connects to `http://localhost:4096` by default.

### Options

| Flag | Description | Default |
|---|---|---|
| `--url <url>` | OpenCode server URL | `http://localhost:4096` |
| `--model <model>` | Model to use (provider/model format) | Server default |

Examples:

```bash
# Connect to a custom server URL
npx opencode-telegram-bot --url http://192.168.1.100:4096

# Use a specific model
npx opencode-telegram-bot --model anthropic/claude-sonnet-4-20250514
```

## Commands

### Bot Commands

These are handled directly by the Telegram bot:

| Command | Description |
|---|---|
| `/start` | Welcome message |
| `/new` | Start a new conversation |
| `/sessions` | List sessions with inline buttons |
| `/title <text>` | Rename the current session |
| `/export` | Export the current session as a markdown file |
| `/export full` | Export with all details (thinking, costs, steps) |
| `/verbose` | Toggle verbose mode (show thinking and tool calls in chat) |
| `/verbose on\|off` | Explicitly enable/disable verbose mode |
| `/model` | Show current model and usage hints |
| `/model <keyword>` | Search models by keyword |
| `/model default` | Reset to the default model |
| `/agent` | Show current agent and switch (plan, build, ...) |
| `/agent <name>` | Switch directly to a named agent |
| `/usage` | Show token and cost usage for this session |
| `/help` | Show available commands |

### Interactive Questions

When the OpenCode agent asks a question (e.g. to clarify intent or pick from options), the bot forwards it to Telegram as **inline keyboard buttons**. Tap an option to answer, or tap **Dismiss** to reject the question.

If the bot restarts while a question is pending, it automatically re-sends the question buttons on startup so the session is not left stuck.

```
Agent: Which area do you want to focus on?
       [Code review]  [Bug fix]  [New feature]  [Dismiss]

You:   [tap "Bug fix"]
Bot:   Answered: Bug fix
```

### Permission Requests

When the OpenCode agent needs permission to perform an action (e.g. edit a file, run a bash command, access an external directory), the bot forwards the request to Telegram with inline buttons:

```
Bot:   Permission: edit
       `src/app.ts`
       [Allow once]  [Always allow]
       [Reject]

You:   [tap "Allow once"]
Bot:   Allowed (once): edit
```

- **Allow once** -- approve this single request
- **Always allow** -- approve and create a permanent allow rule in OpenCode's config
- **Reject** -- deny the request

If the bot restarts while a permission request is pending, it automatically re-sends the buttons on startup. Orphan permission requests (from sessions the bot doesn't know about) are automatically rejected to unblock the session.

The bot also registers these commands in Telegram's command menu (the `/` button), plus any OpenCode server commands discovered at startup.

### Verbose Mode

By default, the bot only shows the assistant's final text response. Use `/verbose` to toggle verbose mode (or `/verbose on|off` to set it explicitly), which also displays:

- **Thinking/reasoning** -- shown as plain text with a 🧠 prefix, truncated to 500 characters
- **Tool calls** -- shown as a compact one-line summary (e.g. `⚙️ read -- src/app.ts`)
- **Delegations** -- shown when work is delegated to a subagent (e.g. `🧩 Delegated: Find relevant docs`)
- **Subagent details** -- reasoning/tool calls from subagents when available, plus a short `ℹ️ Subagent responded` notice

Verbose mode is per-chat and persists across bot restarts. Use `/verbose` again to turn it off.

Example with verbose mode on:

```
🧠 Thinking: Let me analyze the authentication flow and check for potential issues...

⚙️ grep -- pattern: "authenticate" in src/
⚙️ read -- src/auth/handler.ts

🧩 Delegated: Search auth docs
🧠 Thinking (agent: subagent): Scanning docs for auth references...
⚙️ read -- README.md (agent: subagent)
ℹ️ Subagent responded

Here's what I found in the auth module...
```

### Model Switching

Use `/model` to search and switch models without typing long names:

```
You:  /model sonnet
Bot:  Models matching "sonnet":
      Tap a model to select.

You:  [tap "claude-sonnet-4-5 (google-vertex-anthropic)"]
Bot:  Switched to claude-sonnet-4-5 (google-vertex-anthropic)

```

Other commands:

- `/model` shows the current model and usage hints
- `/model default` resets to the server default

### Agent Switching

OpenCode supports multiple agents: **build** (default, full edit access), **plan** (read-only analysis), and others. Use `/agent` to see and switch between them:

```
You:  /agent
Bot:  Current agent: build

      Available agents:
      - build (active) -- The default agent
      - plan -- Plan mode. Disallows all edit tools.
      - general -- General-purpose agent
      - explore -- Codebase explorer

      [build]  [plan]  [general]  [explore]

You:  [tap "plan"]
      (button message is deleted)
Bot:  Agent: plan | Model: claude-opus-4 | Verbose: off     [pinned]
```

### Pinned Status Message

A pinned message at the top of the chat shows the current agent, model, and verbose mode. It updates automatically when any of these change — via `/agent`, `/model`, or `/verbose`. The pinned message is the only confirmation; no separate reply is sent.

Agent, model, and verbose selections are per-chat and persist across bot restarts.

## Usage

Use `/usage` to see the current session's token counts and estimated cost:

```
Session usage:
- Assistant responses: 4
- Tokens: 1200 total (input 600, output 500, reasoning 100)
- Cache: read 1200, write 80
- Cost: $0.0123
```

### Session Export

The `/export` command builds a markdown file from the current session and saves it to the directory where OpenCode is running. The file is also sent back to you as a Telegram document.

Two modes are available:

- **`/export`** -- Default. Includes user messages, assistant text, and tool calls (name, input, output).
- **`/export full`** (also accepts `detailed` or `all`) -- Includes everything from the default mode plus reasoning/thinking blocks, step boundaries with token counts, costs, subtasks, retries, and compaction markers.

The exported file is named `session-<id>.md` (or `session-<id>-detailed.md` for the full export).

### OpenCode Commands

Any `/` command that isn't a bot command is automatically forwarded to the OpenCode server via its command system. The bot fetches the list of available commands on startup and validates them.

The exact list depends on your OpenCode configuration. Common commands include `/init` and `/review`. Send `/help` to the bot to see the full list.

If you type an unknown command, the bot will reply with the list of available commands.

### Regular Messages

Any other text message is forwarded to the OpenCode agent as a prompt. Follow-up messages go into the same session, so the agent has full conversation context. Use `/new` when you want a fresh conversation.

### Files and Images

You can send files or images to the bot. They are forwarded to OpenCode as file parts (with optional caption text). Text-based files (including markdown) are sent as text instead of file parts for better model compatibility. Supported types:

- Photos sent via Telegram
- Documents (PDFs, images, etc.)

## Session Management

Sessions are never deleted automatically. You can have multiple sessions and switch between them.

When you send your first message, a new session is created and automatically titled with that message text. You can rename it anytime with `/title`.

Example workflow:

```
You:  Help me refactor the auth module
Bot:  [agent response]
You:  /title Auth refactoring
Bot:  Session renamed to: Auth refactoring

You:  /new
Bot:  Conversation reset.

You:  Fix the broken tests
Bot:  [agent response about tests - new session auto-titled "Fix the broken tests"]

You:  /sessions
Bot:  Your sessions:
      Current session: Fix the broken tests
      Tap a session to switch or delete.

You:  What were we working on?
Bot:  [agent responds with context from the auth refactoring session]

You:  [tap "Auth refactoring"]
Bot:  Switched to session: Auth refactoring
```

The `/sessions` list shows sessions created by the Telegram bot. At the bottom of the list, a **"Show all sessions"** button lets you discover sessions created by other OpenCode clients (like the TUI via `opencode attach`). Tapping an external session adopts it and switches to it. You cannot delete the currently active session -- use `/new` first.

## Session Persistence

Sessions survive bot restarts. The bot saves the chat-to-session mapping to `sessions.json` in the project root. On startup, it:

1. Loads the mapping from `sessions.json`
2. Validates each session still exists on the OpenCode server
3. If a stored session is gone, falls back to finding a matching session by title (`Telegram chat <chatId>`)
4. If the file is missing entirely, scans all server sessions for ones matching the title convention

This means you can restart the bot (or even delete `sessions.json`) and it will reconnect to existing sessions automatically.

## Resilience

The bot is designed to survive restarts and failures:

- **Drop pending updates** -- On startup, stale Telegram updates are discarded so old button clicks and messages from a previous run are not replayed.
- **Pending question recovery** -- If the bot restarts while the agent is waiting for a question answer, the question is re-sent to Telegram on startup so the session can be unblocked.
- **Pending permission recovery** -- If the bot restarts while the agent is waiting for a permission approval, the permission request is re-sent to Telegram. Orphan requests (from unknown sessions) are automatically rejected.
- **Global error handler** -- Unhandled errors in Telegram update handlers are logged instead of crashing the process.
- **Handler timeout** -- Telegraf's handler timeout is set to 10 minutes (up from 90 seconds) to accommodate long-running LLM responses.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from BotFather |
| `AUTHORIZED_TELEGRAM_USER_ID` | No | Restrict the bot to a single Telegram user |

## Building

To bundle the bot into a single file for deployment:

```bash
npm run build
```

This outputs to `dist/index.js` using [@vercel/ncc](https://github.com/vercel/ncc).
