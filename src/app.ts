import { Telegraf } from "telegraf";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = resolve(__dirname, "..", "sessions.json");

interface StartOptions {
  url: string;
  model?: string;
}

export async function startTelegram(options: StartOptions) {
  const { url, model } = options;
  console.log(`[Telegram] Starting Telegram bot connected to OpenCode at: ${url}`);
  if (model) {
    console.log(`[Telegram] Using model: ${model}`);
  }

  // Check if the bot token is provided
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "[Telegram] TELEGRAM_BOT_TOKEN is not defined in the environment variables"
    );
  }

  // Get the authorized user ID from environment variables
  const authorizedUserId = process.env.AUTHORIZED_TELEGRAM_USER_ID;
  if (!authorizedUserId) {
    console.warn(
      "[Telegram] AUTHORIZED_TELEGRAM_USER_ID is not defined in the environment variables. The bot will be accessible to everyone."
    );
  } else {
    console.log(`[Telegram] Bot is restricted to user ID: ${authorizedUserId}`);
  }

  // Initialize OpenCode client
  const client = createOpencodeClient({ baseUrl: url });

  // Verify connection to the OpenCode server and fetch available commands
  const opencodeCommands = new Set<string>();
  try {
    const sessions = await client.session.list();
    if (sessions.error) {
      throw new Error(`Server returned error: ${JSON.stringify(sessions.error)}`);
    }
    console.log(`[Telegram] Connected to OpenCode server at ${url}`);

    // Fetch available OpenCode commands
    const cmds = await client.command.list();
    if (cmds.data) {
      for (const cmd of cmds.data) {
        opencodeCommands.add(cmd.name);
      }
      console.log(
        `[Telegram] Available OpenCode commands: ${[...opencodeCommands].join(", ")}`
      );
    }
  } catch (err) {
    throw new Error(
      `[Telegram] Failed to connect to OpenCode server at ${url}. Make sure it's running (npm run serve). Error: ${err}`
    );
  }

  // Telegram-only commands that should not be forwarded to OpenCode
  const telegramCommands = new Set([
    "start", "help", "new", "sessions", "switch", "title", "delete",
  ]);

  // Map of chatId -> sessionId for the active session per chat
  const chatSessions = new Map<string, string>();
  // Set of all session IDs ever created/used by this bot (for filtering)
  const knownSessionIds = new Set<string>();

  /**
   * Save the chat-to-session mapping and known session IDs to disk.
   */
  function saveSessions() {
    try {
      const data = {
        active: Object.fromEntries(chatSessions),
        known: [...knownSessionIds],
      };
      writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("[Telegram] Failed to save sessions file:", err);
    }
  }

  /**
   * Load and restore sessions from disk, validating each against the server.
   * Falls back to matching by session title if a stored session is invalid.
   */
  async function restoreSessions() {
    // Load from file (supports both old flat format and new {active, known} format)
    let storedActive: Record<string, string> = {};
    let storedKnown: string[] = [];
    if (existsSync(SESSIONS_FILE)) {
      try {
        const raw = readFileSync(SESSIONS_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.active && typeof parsed.active === "object") {
          // New format: { active: {...}, known: [...] }
          storedActive = parsed.active;
          storedKnown = parsed.known || [];
        } else {
          // Old format: flat { chatId: sessionId }
          storedActive = parsed;
        }
        console.log(
          `[Telegram] Loaded ${Object.keys(storedActive).length} active session(s) and ${storedKnown.length} known session(s) from ${SESSIONS_FILE}`
        );
      } catch (err) {
        console.warn("[Telegram] Failed to parse sessions file:", err);
      }
    }

    // Fetch all server sessions once for validation and fallback matching
    let serverSessions: Array<{ id: string; title: string }> = [];
    try {
      const list = await client.session.list();
      if (list.data) {
        serverSessions = list.data;
      }
    } catch {
      console.warn("[Telegram] Could not fetch sessions from server for validation");
    }

    const validServerIds = new Set(serverSessions.map((s) => s.id));

    // Restore known session IDs (only those still on the server)
    for (const id of storedKnown) {
      if (validServerIds.has(id)) {
        knownSessionIds.add(id);
      }
    }

    for (const [chatId, sessionId] of Object.entries(storedActive)) {
      // Check if the stored session still exists on the server
      if (validServerIds.has(sessionId)) {
        chatSessions.set(chatId, sessionId);
        knownSessionIds.add(sessionId);
        console.log(
          `[Telegram] Restored session ${sessionId} for chat ${chatId}`
        );
        continue;
      }

      console.warn(
        `[Telegram] Stored session ${sessionId} for chat ${chatId} no longer exists on server`
      );

      // Fallback: find a session by title convention
      const titleMatch = serverSessions.find(
        (s) => s.title === `Telegram chat ${chatId}`
      );
      if (titleMatch) {
        chatSessions.set(chatId, titleMatch.id);
        knownSessionIds.add(titleMatch.id);
        console.log(
          `[Telegram] Recovered session ${titleMatch.id} for chat ${chatId} via title match`
        );
      }
    }

    // If we had no file but there are sessions on the server matching our title convention,
    // try to recover those too (handles case where file was deleted)
    if (Object.keys(storedActive).length === 0 && storedKnown.length === 0) {
      for (const session of serverSessions) {
        const match = session.title.match(/^Telegram chat (\d+)$/);
        if (match) {
          const chatId = match[1];
          if (!chatSessions.has(chatId)) {
            chatSessions.set(chatId, session.id);
            knownSessionIds.add(session.id);
            console.log(
              `[Telegram] Discovered session ${session.id} for chat ${chatId} via title match`
            );
          }
        }
      }
    }

    // Persist the validated state
    if (chatSessions.size > 0 || knownSessionIds.size > 0) {
      saveSessions();
    }
  }

  // Restore sessions from previous runs
  await restoreSessions();

  // Track which sessions were just created so we can auto-title them
  const newlyCreatedSessions = new Set<string>();

  /**
   * Get or create an OpenCode session for a given chat.
   */
  async function getOrCreateSession(chatId: string): Promise<string> {
    let sessionId = chatSessions.get(chatId);
    if (!sessionId) {
      const session = await client.session.create({
        body: { title: `Telegram chat ${chatId}` },
      });
      if (session.error || !session.data) {
        throw new Error(
          `Failed to create session: ${JSON.stringify(session.error)}`
        );
      }
      sessionId = session.data.id;
      chatSessions.set(chatId, sessionId);
      knownSessionIds.add(sessionId);
      newlyCreatedSessions.add(sessionId);
      saveSessions();
      console.log(
        `[Telegram] Created new session ${sessionId} for chat ${chatId}`
      );
    } else {
      console.log(
        `[Telegram] Using existing session ${sessionId} for chat ${chatId}`
      );
    }
    return sessionId;
  }

  /**
   * Auto-title a session based on the user's first message.
   */
  async function autoTitleSession(sessionId: string, userText: string) {
    if (!newlyCreatedSessions.has(sessionId)) return;
    newlyCreatedSessions.delete(sessionId);

    const title = truncate(userText.replace(/\n/g, " "), 100);
    try {
      await client.session.update({
        path: { id: sessionId },
        body: { title },
      });
      console.log(`[Telegram] Auto-titled session ${sessionId}: "${title}"`);
    } catch (err) {
      console.warn("[Telegram] Failed to auto-title session:", err);
    }
  }

  /**
   * Extract text from response parts and send to Telegram chat.
   */
  async function sendResponseToChat(
    chatId: number,
    parts: Array<{ type: string; text?: string; [key: string]: unknown }>,
    processingMsgId: number
  ) {
    let responseText = "";
    for (const part of parts) {
      if (part.type === "text" && part.text) {
        responseText += part.text;
      }
    }

    if (!responseText) {
      responseText = "The agent returned an empty response.";
    }

    // Delete the "processing" message
    try {
      await bot.telegram.deleteMessage(chatId, processingMsgId);
    } catch {
      // Ignore if we can't delete it
    }

    // Send the response, splitting if needed (Telegram has a 4096 char limit)
    const chunks = splitMessage(responseText, 4096);
    for (const chunk of chunks) {
      try {
        await bot.telegram.sendMessage(chatId, chunk, {
          parse_mode: "Markdown",
        });
      } catch {
        try {
          await bot.telegram.sendMessage(chatId, chunk);
        } catch (fallbackErr) {
          console.error("[Telegram] Fallback error:", fallbackErr);
        }
      }
    }
  }

  /**
   * Handle session errors - clear invalid sessions.
   */
  async function handleSessionError(chatId: string) {
    const sessionId = chatSessions.get(chatId);
    if (sessionId) {
      try {
        const check = await client.session.get({
          path: { id: sessionId },
        });
        if (check.error) {
          chatSessions.delete(chatId);
          saveSessions();
          console.log(`[Telegram] Cleared invalid session for chat ${chatId}`);
        }
      } catch {
        chatSessions.delete(chatId);
        saveSessions();
        console.log(`[Telegram] Cleared invalid session for chat ${chatId}`);
      }
    }
  }

  // Initialize Telegram bot
  const bot = new Telegraf(token);

  // Middleware to check if the user is authorized
  bot.use((ctx, next) => {
    if (!authorizedUserId) {
      return next();
    }

    const userId = ctx.from?.id.toString();
    if (userId === authorizedUserId) {
      return next();
    } else {
      console.log(
        `[Telegram] Unauthorized access attempt from user ID: ${userId}`
      );
      ctx.reply("Sorry, this bot is private and can only be used by its owner.");
      return;
    }
  });

  // Handle /start command
  bot.start((ctx) => {
    let msg =
      "Hello! I'm your OpenCode bot. Send me a message and I'll forward it to the OpenCode agent.\n\n" +
      "Bot commands:\n" +
      "/new - Start a new conversation\n" +
      "/sessions - List your sessions\n" +
      "/switch <number> - Switch to a different session\n" +
      "/title <text> - Rename the current session\n" +
      "/delete <number> - Delete a session\n" +
      "/help - Show this help message\n";

    if (opencodeCommands.size > 0) {
      msg +=
        "\nOpenCode commands are also available:\n" +
        [...opencodeCommands].map((c) => `/${c}`).join(", ");
    }

    ctx.reply(msg);
  });

  // Handle /help command
  bot.help((ctx) => {
    let msg =
      "Send me any message and I'll process it using OpenCode.\n\n" +
      "Bot commands:\n" +
      "/new - Start a new conversation\n" +
      "/sessions - List your sessions\n" +
      "/switch <number> - Switch to a different session\n" +
      "/title <text> - Rename the current session\n" +
      "/delete <number> - Delete a session\n" +
      "/help - Show this help message\n";

    if (opencodeCommands.size > 0) {
      msg +=
        "\nOpenCode commands:\n" +
        [...opencodeCommands].map((c) => `/${c}`).join(", ");
    }

    ctx.reply(msg);
  });

  // Handle /new command - create a fresh session
  bot.command("new", (ctx) => {
    const chatId = ctx.chat.id.toString();
    chatSessions.delete(chatId);
    saveSessions();
    console.log(`[Telegram] Session cleared for chat ${chatId}`);
    ctx.reply(
      "Conversation reset. Your next message will start a new session."
    );
  });

  /**
   * Get the list of known sessions, sorted by most recently updated.
   */
  async function getKnownSessions() {
    const list = await client.session.list();
    if (!list.data || list.data.length === 0) return [];
    return list.data
      .filter((s) => knownSessionIds.has(s.id))
      .sort((a, b) => b.time.updated - a.time.updated);
  }

  /**
   * Resolve a user argument to a session. Accepts either a numeric index
   * (1-based, as shown by /sessions) or a session ID / prefix.
   */
  function resolveSession(
    sessions: Awaited<ReturnType<typeof getKnownSessions>>,
    arg: string
  ) {
    // Try numeric index first
    const num = parseInt(arg, 10);
    if (!isNaN(num) && String(num) === arg && num >= 1 && num <= sessions.length) {
      return sessions[num - 1];
    }
    // Fall back to ID / prefix match
    return sessions.find((s) => s.id === arg || s.id.startsWith(arg));
  }

  // Handle /sessions command - list Telegram bot sessions only
  bot.command("sessions", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const activeSessionId = chatSessions.get(chatId);

    try {
      const sessions = await getKnownSessions();

      if (sessions.length === 0) {
        await ctx.reply("No sessions found.");
        return;
      }

      let msg = "Your sessions:\n\n";
      sessions.forEach((session, i) => {
        const isActive = session.id === activeSessionId;
        const age = formatAge(session.time.updated);
        const marker = isActive ? " [active]" : "";
        msg += `${i + 1}. ${session.title} - ${age}${marker}\n`;
      });

      msg += `\nUse /switch <number> to switch sessions.`;
      msg += `\nUse /delete <number> to delete a session.`;

      await ctx.reply(msg);
    } catch (err) {
      console.error("[Telegram] Error listing sessions:", err);
      await ctx.reply("Failed to list sessions.");
    }
  });

  // Handle /switch <number> command - switch to a different session
  bot.command("switch", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const args = ctx.message.text.replace(/^\/switch\s*/, "").trim();

    if (!args) {
      await ctx.reply(
        "Usage: /switch <number>\n\nUse /sessions to see available sessions."
      );
      return;
    }

    try {
      const sessions = await getKnownSessions();
      const match = resolveSession(sessions, args);

      if (!match) {
        await ctx.reply(
          `No session found matching "${args}".\n\nUse /sessions to see available sessions.`
        );
        return;
      }

      chatSessions.set(chatId, match.id);
      saveSessions();
      console.log(
        `[Telegram] Switched chat ${chatId} to session ${match.id}`
      );

      await ctx.reply(`Switched to session: ${match.title}`);
    } catch (err) {
      console.error("[Telegram] Error switching session:", err);
      await ctx.reply("Failed to switch session.");
    }
  });

  // Handle /title <text> command - rename the current session
  bot.command("title", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const newTitle = ctx.message.text.replace(/^\/title\s*/, "").trim();

    if (!newTitle) {
      await ctx.reply("Usage: /title <new title>");
      return;
    }

    const sessionId = chatSessions.get(chatId);
    if (!sessionId) {
      await ctx.reply(
        "No active session. Send a message first to create one."
      );
      return;
    }

    try {
      const result = await client.session.update({
        path: { id: sessionId },
        body: { title: newTitle },
      });

      if (result.error) {
        throw new Error(JSON.stringify(result.error));
      }

      console.log(
        `[Telegram] Renamed session ${sessionId} to "${newTitle}"`
      );
      await ctx.reply(`Session renamed to: ${newTitle}`);
    } catch (err) {
      console.error("[Telegram] Error renaming session:", err);
      await ctx.reply("Failed to rename session.");
    }
  });

  // Handle /delete <number> command - delete a session
  bot.command("delete", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const args = ctx.message.text.replace(/^\/delete\s*/, "").trim();

    if (!args) {
      await ctx.reply(
        "Usage: /delete <number>\n\nUse /sessions to see available sessions."
      );
      return;
    }

    try {
      const sessions = await getKnownSessions();
      const match = resolveSession(sessions, args);

      if (!match) {
        await ctx.reply(
          `No session found matching "${args}".\n\nUse /sessions to see available sessions.`
        );
        return;
      }

      // Don't allow deleting the active session without switching first
      const activeSessionId = chatSessions.get(chatId);
      if (match.id === activeSessionId) {
        await ctx.reply(
          "Cannot delete the active session. Use /new or /switch first, then delete it."
        );
        return;
      }

      // Delete from the server
      const result = await client.session.delete({
        path: { id: match.id },
      });

      if (result.error) {
        throw new Error(JSON.stringify(result.error));
      }

      // Remove from known sessions
      knownSessionIds.delete(match.id);
      saveSessions();

      console.log(`[Telegram] Deleted session ${match.id}`);
      await ctx.reply(`Deleted session: ${match.title}`);
    } catch (err) {
      console.error("[Telegram] Error deleting session:", err);
      await ctx.reply("Failed to delete session.");
    }
  });

  // Catch-all for unregistered / commands - forward to OpenCode
  bot.on("text", async (ctx) => {
    const userText = ctx.message.text;
    const chatId = ctx.chat.id.toString();
    const userId = ctx.message.from.id.toString();

    // Check if this is a / command that should be forwarded to OpenCode
    const commandMatch = userText.match(/^\/(\w+)(?:\s+(.*))?$/s);
    if (commandMatch) {
      const commandName = commandMatch[1];
      const commandArgs = commandMatch[2]?.trim() || "";

      // Skip Telegram-only commands (already handled above)
      if (telegramCommands.has(commandName)) {
        return;
      }

      // Check if it's a known OpenCode command
      if (!opencodeCommands.has(commandName)) {
        const available = [...opencodeCommands].map((c) => `/${c}`).join(", ");
        await ctx.reply(
          `Unknown command: /${commandName}\n\n` +
            `Available OpenCode commands: ${available || "none"}\n` +
            `Bot commands: /new, /help`
        );
        return;
      }

      console.log(
        `[Telegram] Received command from ${userId}: /${commandName} ${commandArgs}`
      );

      try {
        const processingMsg = await ctx.reply("Processing your command...");
        const sessionId = await getOrCreateSession(chatId);

        const result = await client.session.command({
          path: { id: sessionId },
          body: {
            command: commandName,
            arguments: commandArgs,
          },
        });

        if (result.error) {
          throw new Error(
            `Command failed: ${JSON.stringify(result.error)}`
          );
        }

        const parts = (result.data?.parts || []) as Array<{
          type: string;
          text?: string;
          [key: string]: unknown;
        }>;
        await sendResponseToChat(ctx.chat.id, parts, processingMsg.message_id);
      } catch (err) {
        console.error("[Telegram] Error executing command:", err);
        await handleSessionError(chatId);
        await ctx.reply(
          "Sorry, there was an error executing the command. Try again or use /new to start a fresh session."
        );
      }
      return;
    }

    // Regular text message - forward as a prompt
    console.log(`[Telegram] Received message from ${userId}: ${userText}`);

    try {
      const processingMsg = await ctx.reply("Processing your request...");
      const sessionId = await getOrCreateSession(chatId);

      // Auto-title if this is the first message in a new session
      await autoTitleSession(sessionId, userText);

      // Build the prompt body
      const promptBody: {
        parts: Array<{ type: "text"; text: string }>;
        model?: { providerID: string; modelID: string };
      } = {
        parts: [{ type: "text", text: userText }],
      };
      if (model) {
        const [providerID, ...modelParts] = model.split("/");
        const modelID = modelParts.join("/");
        promptBody.model = { providerID, modelID };
      }

      const result = await client.session.prompt({
        path: { id: sessionId },
        body: promptBody,
      });

      if (result.error) {
        throw new Error(`Prompt failed: ${JSON.stringify(result.error)}`);
      }

      const parts = (result.data?.parts || []) as Array<{
        type: string;
        text?: string;
        [key: string]: unknown;
      }>;
      await sendResponseToChat(ctx.chat.id, parts, processingMsg.message_id);
    } catch (err) {
      console.error("[Telegram] Error processing message:", err);
      await handleSessionError(chatId);
      await ctx.reply(
        "Sorry, there was an error processing your request. Try again or use /new to start a fresh session."
      );
    }
  });

  try {
    // Start the bot
    await bot.launch();
    console.log("[Telegram] Bot is running");

    // Enable graceful stop
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
  } catch (error) {
    console.error("Unable to start the Telegram bot:", error);
    throw error;
  }
}

/**
 * Format a Unix timestamp (seconds) into a human-readable relative time.
 */
function formatAge(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} days ago`;
  return `${Math.floor(diff / 604800)} weeks ago`;
}

/**
 * Truncate text to a maximum length, appending "..." if truncated.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}

/**
 * Split a message into chunks that fit within Telegram's message size limit.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline boundary
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Fall back to splitting at a space
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Hard split if no good boundary found
      splitIndex = maxLength;
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }

  return chunks;
}
