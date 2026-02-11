# OpenCode Telegram Bot

A Telegram bot that forwards messages to an [OpenCode](https://opencode.ai) agent and returns the responses. Each chat gets a persistent session, so the agent remembers conversation context across messages.

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
| `/usage` | Show token and cost usage for this session |
| `/help` | Show available commands |

### Verbose Mode

By default, the bot only shows the assistant's final text response. Use `/verbose` to toggle verbose mode (or `/verbose on|off` to set it explicitly), which also displays:

- **Thinking/reasoning** -- shown as plain text with a 🧠 prefix, truncated to 500 characters
- **Tool calls** -- shown as a compact one-line summary (e.g. `> read -- src/app.ts`)

Verbose mode is per-chat and persists across bot restarts. Use `/verbose` again to turn it off.

Example with verbose mode on:

```
🧠 Thinking: Let me analyze the authentication flow and check for potential issues...

⚙️ grep -- pattern: "authenticate" in src/
⚙️ read -- src/auth/handler.ts

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

You:  /switch def6
Bot:  Switched to session: Auth refactoring (def67890)

You:  What were we working on?
Bot:  [agent responds with context from the auth refactoring session]

You:  /delete abc1
Bot:  Deleted session: Fix the broken tests (abc12345)
```

The `/sessions` list only shows sessions created by the Telegram bot, not sessions from other OpenCode clients (like the TUI). You cannot delete the currently active session -- use `/new` or `/switch` first.

## Session Persistence

Sessions survive bot restarts. The bot saves the chat-to-session mapping to `sessions.json` in the project root. On startup, it:

1. Loads the mapping from `sessions.json`
2. Validates each session still exists on the OpenCode server
3. If a stored session is gone, falls back to finding a matching session by title (`Telegram chat <chatId>`)
4. If the file is missing entirely, scans all server sessions for ones matching the title convention

This means you can restart the bot (or even delete `sessions.json`) and it will reconnect to existing sessions automatically.

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
