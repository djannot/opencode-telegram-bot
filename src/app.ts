import { Telegraf } from "telegraf";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = resolve(__dirname, "..", "sessions.json");

interface OpencodeClientLike {
  session: {
    list: (options?: any) => Promise<any>;
    create: (options: any) => Promise<any>;
    update: (options: any) => Promise<any>;
    delete: (options: any) => Promise<any>;
    get: (options: any) => Promise<any>;
    messages: (options: any) => Promise<any>;
    command: (options: any) => Promise<any>;
    promptAsync: (options: any) => Promise<any>;
  };
  command: {
    list: (options?: any) => Promise<any>;
  };
  provider: {
    list: (options?: any) => Promise<any>;
  };
  path: {
    get: (options?: any) => Promise<any>;
  };
  event: {
    subscribe: (options?: any) => Promise<any>;
  };
}

interface StartOptions {
  url: string;
  model?: string;
  launch?: boolean;
  client?: OpencodeClientLike;
  botFactory?: (token: string) => TelegramBot;
  sessionsFilePath?: string;
}

interface TelegramBot {
  use: (fn: (ctx: any, next: () => Promise<void>) => Promise<void> | void) => void;
  start: (fn: (ctx: any) => void | Promise<void>) => void;
  help: (fn: (ctx: any) => void | Promise<void>) => void;
  command: (command: string, fn: (ctx: any) => void | Promise<void>) => void;
  on: (event: string, fn: (ctx: any) => void | Promise<void>) => void;
  launch: () => Promise<void>;
  stop: (reason?: string) => void;
  telegram: {
    sendMessage: (chatId: number, text: string, options?: Record<string, unknown>) => Promise<void>;
    deleteMessage: (chatId: number, messageId: number) => Promise<void>;
    sendDocument: (chatId: number, file: { source: Buffer; filename: string }) => Promise<void>;
  };
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

  const sessionsFile = options.sessionsFilePath || SESSIONS_FILE;

  // Initialize OpenCode client
  const client = options.client || createOpencodeClient({ baseUrl: url });

  // Verify connection to the OpenCode server and fetch available commands
  const opencodeCommands = new Set<string>();
  let projectDirectory = "";
  try {
    const sessions = await client.session.list();
    if (sessions.error) {
      throw new Error(`Server returned error: ${JSON.stringify(sessions.error)}`);
    }
    console.log(`[Telegram] Connected to OpenCode server at ${url}`);

    // Fetch the project directory (needed for SSE event subscription)
    const pathResult = await client.path.get();
    if (pathResult.data?.directory) {
      projectDirectory = pathResult.data.directory;
      console.log(`[Telegram] Project directory: ${projectDirectory}`);
    }

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
    "start", "help", "new", "sessions", "switch", "title", "delete", "export", "verbose", "model", "usage",
  ]);

  // Map of chatId -> sessionId for the active session per chat
  const chatSessions = new Map<string, string>();
  // Set of all session IDs ever created/used by this bot (for filtering)
  const knownSessionIds = new Set<string>();
  // Set of chatIds with verbose mode enabled
  const chatVerboseMode = new Set<string>();
  // Map of chatId -> model override (provider/model)
  const chatModelOverride = new Map<string, string>();
  // Map of chatId -> last search results (in-memory only)
  const chatModelSearchResults = new Map<
    string,
    Array<{ providerID: string; modelID: string; displayName: string }>
  >();

  /**
   * Save the chat-to-session mapping and known session IDs to disk.
   */
  function saveSessions() {
    try {
      const data = {
        active: Object.fromEntries(chatSessions),
        known: [...knownSessionIds],
        verbose: [...chatVerboseMode],
        models: Object.fromEntries(chatModelOverride),
      };
      writeFileSync(sessionsFile, JSON.stringify(data, null, 2));
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
    let storedVerbose: string[] = [];
    let storedModels: Record<string, string> = {};
    if (existsSync(sessionsFile)) {
      try {
        const raw = readFileSync(sessionsFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.active && typeof parsed.active === "object") {
          // New format: { active: {...}, known: [...], verbose: [...] }
          storedActive = parsed.active;
          storedKnown = parsed.known || [];
          storedVerbose = parsed.verbose || [];
          storedModels = parsed.models || {};
        } else {
          // Old format: flat { chatId: sessionId }
          storedActive = parsed;
        }
        console.log(
          `[Telegram] Loaded ${Object.keys(storedActive).length} active session(s) and ${storedKnown.length} known session(s) from ${sessionsFile}`
        );
      } catch (err) {
        console.warn("[Telegram] Failed to parse sessions file:", err);
      }
    }

    // Restore verbose mode preferences
    for (const chatId of storedVerbose) {
      chatVerboseMode.add(chatId);
    }
    if (storedVerbose.length > 0) {
      console.log(
        `[Telegram] Restored verbose mode for ${storedVerbose.length} chat(s)`
      );
    }

    // Restore model overrides
    for (const [chatId, modelId] of Object.entries(storedModels)) {
      if (modelId) {
        chatModelOverride.set(chatId, modelId);
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
      sessionId = session.data.id as string;
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
    return sessionId as string;
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
   * Build a one-line summary for a tool call, picking the most meaningful input field.
   */
  function summarizeTool(
    tool: string,
    input?: { [key: string]: unknown }
  ): string {
    if (!input) return tool;

    // Pick the most descriptive field based on common tool patterns
    const summaryField =
      input.filePath || input.path || input.command || input.pattern ||
      input.url || input.query || input.content || input.prompt ||
      input.description || input.name;

    if (summaryField && typeof summaryField === "string") {
      return `${tool} -- ${truncate(summaryField, 80)}`;
    }

    // For tools with a glob/include pattern
    if (input.include && typeof input.include === "string") {
      return `${tool} -- ${truncate(input.include, 80)}`;
    }

    return tool;
  }

  /**
   * Send a message to Telegram, with Markdown fallback.
   * When disableLinkPreview is true, link previews are suppressed (useful for verbose messages).
   */
  async function sendTelegramMessage(chatId: number, text: string, disableLinkPreview = false) {
    const options: Record<string, unknown> = {
      parse_mode: "Markdown",
    };
    if (disableLinkPreview) {
      options.link_preview_options = { is_disabled: true };
    }
    try {
      await bot.telegram.sendMessage(chatId, text, options);
    } catch {
      try {
        const fallbackOptions: Record<string, unknown> = {};
        if (disableLinkPreview) {
          fallbackOptions.link_preview_options = { is_disabled: true };
        }
        await bot.telegram.sendMessage(chatId, text, fallbackOptions);
      } catch (fallbackErr) {
        console.error("[Telegram] Fallback error:", fallbackErr);
      }
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
      await sendTelegramMessage(chatId, chunk);
    }
  }

  /**
   * Send a prompt with streaming: fires the prompt asynchronously, then listens
   * to SSE events to stream thinking and tool call updates to Telegram in real-time.
   * The final text response is sent when the session goes idle.
   */
  async function sendPromptStreaming(
    chatId: number,
    sessionId: string,
    promptBody: {
      parts: Array<{ type: "text"; text: string }>;
      model?: { providerID: string; modelID: string };
    },
    processingMsgId: number,
    verbose = false
  ) {
    // Subscribe to SSE events before sending the prompt so we don't miss anything
    const abortController = new AbortController();
    // Subscribe to SSE events before sending the prompt so we don't miss anything
    const subscribeOptions: Record<string, unknown> = {
      signal: abortController.signal,
    };
    if (projectDirectory) {
      subscribeOptions.query = { directory: projectDirectory };
    }
    const { stream } = await client.event.subscribe(subscribeOptions as never);
    // Fire the prompt asynchronously (returns immediately)
    const asyncResult = await client.session.promptAsync({
      path: { id: sessionId },
      body: promptBody,
    });

    if (asyncResult.error) {
      abortController.abort();
      throw new Error(`Prompt failed: ${JSON.stringify(asyncResult.error)}`);
    }

    // Track state as events stream in
    let finalText = "";
    let processingMsgDeleted = false;
    const sentToolIds = new Set<string>();
    const sentReasoningIds = new Set<string>();
    // Buffer the latest reasoning text -- we send it when a non-reasoning part arrives
    // so we get the complete thinking block rather than a partial one
    let pendingReasoning: { id: string; text: string } | null = null;

    /**
     * Delete the "processing" message once, right before sending the first real output.
     */
    async function deleteProcessingMsg() {
      if (!processingMsgDeleted) {
        processingMsgDeleted = true;
        try {
          await bot.telegram.deleteMessage(chatId, processingMsgId);
        } catch {
          // Ignore
        }
      }
    }

    /**
     * Flush any buffered reasoning to Telegram as a spoiler message.
     */
    async function flushReasoning() {
      if (verbose && pendingReasoning && !sentReasoningIds.has(pendingReasoning.id)) {
        sentReasoningIds.add(pendingReasoning.id);
        await deleteProcessingMsg();
        const truncated = truncate(pendingReasoning.text.replace(/\n/g, " "), 500);
        await sendTelegramMessage(chatId, `\u{1F9E0} Thinking: ${truncated}`, true);
      }
      pendingReasoning = null;
    }

    try {
      for await (const event of stream) {
        const ev = event as { type: string; properties?: Record<string, unknown> };

        if (ev.type === "message.part.updated" && ev.properties) {
          const part = ev.properties.part as {
            type: string;
            sessionID?: string;
            id?: string;
            [key: string]: unknown;
          };

          // Only process events for our session
          if (part.sessionID !== sessionId) continue;

          const partText = part.text as string | undefined;

          if (part.type === "reasoning" && part.id) {
            // Buffer reasoning -- keep updating with the latest full text
            if (partText) {
              pendingReasoning = { id: part.id, text: partText };
            }
          } else if (part.type === "tool" && part.id) {
            // A tool part arrived -- flush any pending reasoning first
            await flushReasoning();

            if (verbose) {
              const state = part.state as {
                status: string;
                input?: { [key: string]: unknown };
                error?: string;
              } | undefined;

              // Only send tool messages once they have a completed/error status
              if (
                state &&
                (state.status === "completed" || state.status === "error") &&
                !sentToolIds.has(part.id)
              ) {
              sentToolIds.add(part.id);
              await deleteProcessingMsg();
              const tool = part.tool as string;
              const summary = summarizeTool(tool, state.input);
              let line = `\u{2699}\u{FE0F} ${summary}`;
              if (state.status === "error") {
                line += ` \u{274C}`;
              }
              await sendTelegramMessage(chatId, line, true);
              }
            }
          } else if (part.type === "text") {
            // A text part arrived -- flush any pending reasoning first
            await flushReasoning();

            // Accumulate text for the final response (text parts carry the full text, not deltas)
            const text = part.text as string | undefined;
            if (text) {
              finalText = text;
            }
          }
        } else if (ev.type === "session.idle" && ev.properties) {
          const idleSessionId = ev.properties.sessionID as string | undefined;
          if (idleSessionId === sessionId) {
            // Flush any remaining reasoning before finishing
            await flushReasoning();
            break;
          }
        } else if (ev.type === "session.error" && ev.properties) {
          const errorSessionId = ev.properties.sessionID as string | undefined;
          if (errorSessionId === sessionId) {
            const error = ev.properties.error as { data?: { message?: string } } | undefined;
            const errorMsg = error?.data?.message || "Unknown error";
            throw new Error(`Session error: ${errorMsg}`);
          }
        }
      }
    } finally {
      abortController.abort();
    }

    // Delete the processing message if it hasn't been deleted yet (non-verbose mode)
    await deleteProcessingMsg();

    // Send the final text response
    if (!finalText) {
      finalText = "The agent returned an empty response.";
    }

    const chunks = splitMessage(finalText, 4096);
    for (const chunk of chunks) {
      await sendTelegramMessage(chatId, chunk);
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
  const bot: TelegramBot = options.botFactory
    ? options.botFactory(token)
    : (new Telegraf(token) as unknown as TelegramBot);

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
      "/export - Export the current session as a markdown file\n" +
      "/export full - Export with all details (thinking, costs, steps)\n" +
      "/verbose - Toggle verbose mode (show thinking and tool calls)\n" +
      "/verbose on|off - Set verbose mode explicitly\n" +
      "/model - Show or search available models\n" +
      "/usage - Show token and cost usage for this session\n" +
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
      "/export - Export the current session as a markdown file\n" +
      "/export full - Export with all details (thinking, costs, steps)\n" +
      "/verbose - Toggle verbose mode (show thinking and tool calls)\n" +
      "/verbose on|off - Set verbose mode explicitly\n" +
      "/model - Show or search available models\n" +
      "/usage - Show token and cost usage for this session\n" +
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

  type SessionListItem = { id: string; title: string; time: { updated: number } };

  /**
   * Get the list of known sessions, sorted by most recently updated.
   */
  async function getKnownSessions(): Promise<SessionListItem[]> {
    const list = await client.session.list();
    const data = (list.data || []) as SessionListItem[];
    if (data.length === 0) return [];
    return data
      .filter((s: SessionListItem) => knownSessionIds.has(s.id))
      .sort((a: SessionListItem, b: SessionListItem) => b.time.updated - a.time.updated);
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
    return sessions.find((s: SessionListItem) => s.id === arg || s.id.startsWith(arg));
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
      sessions.forEach((session: SessionListItem, i: number) => {
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

  // Handle /verbose command - toggle verbose mode for this chat
  // Usage: /verbose, /verbose on, /verbose off
  bot.command("verbose", (ctx) => {
    const chatId = ctx.chat.id.toString();
    const args = ctx.message.text.replace(/^\/verbose\s*/, "").trim().toLowerCase();

    if (args === "on") {
      chatVerboseMode.add(chatId);
    } else if (args === "off") {
      chatVerboseMode.delete(chatId);
    } else {
      if (chatVerboseMode.has(chatId)) {
        chatVerboseMode.delete(chatId);
      } else {
        chatVerboseMode.add(chatId);
      }
    }

    saveSessions();
    const enabled = chatVerboseMode.has(chatId);
    console.log(`[Telegram] Verbose mode ${enabled ? "enabled" : "disabled"} for chat ${chatId}`);
    ctx.reply(
      enabled
        ? "Verbose mode enabled. Responses will include thinking and tool calls."
        : "Verbose mode disabled. Responses will only show the assistant's text."
    );
  });

  /**
   * Fetch and search available models from connected providers.
   */
  async function searchModels(keyword: string) {
    const list = await client.provider.list();
    if (list.error || !list.data) {
      throw new Error(`Failed to list providers: ${JSON.stringify(list.error)}`);
    }

    const connected = new Set<string>(list.data.connected || []);
    const results: Array<{ providerID: string; modelID: string; displayName: string }> = [];
    const query = keyword.toLowerCase();

    for (const provider of list.data.all || []) {
      if (!connected.has(provider.id)) continue;
      const providerName = (provider.name || provider.id).toLowerCase();

      const models = provider.models as Record<string, { name?: string }> | undefined;
      for (const [modelID, model] of Object.entries(models || {})) {
        const modelName = ((model && model.name) || modelID).toLowerCase();
        if (
          modelID.toLowerCase().includes(query) ||
          modelName.includes(query) ||
          providerName.includes(query)
        ) {
          const displayName = `${(model && model.name) || modelID} (${provider.id})`;
          results.push({ providerID: provider.id, modelID, displayName });
        }
      }
    }

    return results;
  }

  // Handle /model command
  // Usage: /model, /model <keyword>, /model <number>, /model default
  bot.command("model", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const args = ctx.message.text.replace(/^\/model\s*/, "").trim();

    if (!args) {
      const current = chatModelOverride.get(chatId) || model || "server default";
      await ctx.reply(
        `Current model: ${current}\n\n` +
          "Use /model <keyword> to search available models.\n" +
          "Use /model default to reset to the default model."
      );
      return;
    }

    if (args.toLowerCase() === "default") {
      chatModelOverride.delete(chatId);
      saveSessions();
      await ctx.reply("Model reset to the default model.");
      return;
    }

    const asNumber = Number.parseInt(args, 10);
    if (!Number.isNaN(asNumber) && String(asNumber) === args) {
      const results = chatModelSearchResults.get(chatId) || [];
      if (results.length === 0) {
        await ctx.reply("No recent search results. Use /model <keyword> first.");
        return;
      }
      if (asNumber < 1 || asNumber > results.length) {
        await ctx.reply("Invalid selection. Use /model <number> from the latest search results.");
        return;
      }
      const selection = results[asNumber - 1];
      const value = `${selection.providerID}/${selection.modelID}`;
      chatModelOverride.set(chatId, value);
      saveSessions();
      await ctx.reply(`Switched to ${selection.displayName}`);
      return;
    }

    try {
      const results = await searchModels(args);
      if (results.length === 0) {
        await ctx.reply(`No models found matching "${args}".`);
        return;
      }

      const limited = results.slice(0, 10);
      chatModelSearchResults.set(chatId, limited);

      let msg = `Models matching "${args}":\n\n`;
      for (const [index, item] of limited.entries()) {
        msg += `${index + 1}. ${item.displayName}\n`;
      }

      if (results.length > limited.length) {
        msg += `\nFound ${results.length} models. Refine your search to narrow the list.`;
      }

      msg += "\nUse /model <number> to select.";
      await ctx.reply(msg);
    } catch (err) {
      console.error("[Telegram] Error searching models:", err);
      await ctx.reply("Failed to list models. Try again later.");
    }
  });

  // Handle /usage command - show token and cost usage for current session
  bot.command("usage", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const sessionId = chatSessions.get(chatId);

    if (!sessionId) {
      await ctx.reply("No active session. Send a message first to create one.");
      return;
    }

    try {
      const messagesResult = await client.session.messages({
        path: { id: sessionId },
      });

      if (messagesResult.error || !messagesResult.data) {
        throw new Error(
          `Failed to get messages: ${JSON.stringify(messagesResult.error)}`
        );
      }

      let assistantCount = 0;
      let costTotal = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let reasoningTokens = 0;
      let cacheRead = 0;
      let cacheWrite = 0;

      for (const msg of messagesResult.data) {
        const info = msg.info as {
          role: string;
          cost?: number;
          tokens?: {
            input: number;
            output: number;
            reasoning: number;
            cache: { read: number; write: number };
          };
        };
        if (info.role !== "assistant") continue;
        assistantCount += 1;
        costTotal += info.cost || 0;
        if (info.tokens) {
          inputTokens += info.tokens.input || 0;
          outputTokens += info.tokens.output || 0;
          reasoningTokens += info.tokens.reasoning || 0;
          cacheRead += info.tokens.cache?.read || 0;
          cacheWrite += info.tokens.cache?.write || 0;
        }
      }

      const totalTokens = inputTokens + outputTokens + reasoningTokens;
      const lines = [
        `Session usage:`,
        `- Assistant responses: ${assistantCount}`,
        `- Tokens: ${totalTokens} total (input ${inputTokens}, output ${outputTokens}, reasoning ${reasoningTokens})`,
        `- Cache: read ${cacheRead}, write ${cacheWrite}`,
        `- Cost: $${costTotal.toFixed(4)}`,
      ];

      await ctx.reply(lines.join("\n"));
    } catch (err) {
      console.error("[Telegram] Error getting usage:", err);
      await ctx.reply("Failed to fetch usage. Try again later.");
    }
  });

  /**
   * Render a message part to markdown.
   * In default mode: only text and tool calls (name + input/output).
   * In detailed mode: also includes reasoning, step info, subtasks, costs, etc.
   */
  function renderPart(
    part: { type: string; [key: string]: unknown },
    detailed: boolean
  ): string {
    let md = "";

    switch (part.type) {
      case "text": {
        const text = part.text as string | undefined;
        if (text) {
          md += `${text}\n\n`;
        }
        break;
      }

      case "tool": {
        const tool = part.tool as string;
        const state = part.state as {
          status: string;
          input?: { [key: string]: unknown };
          output?: string;
          error?: string;
          time?: { start: number; end: number };
        };
        md += `**Tool: ${tool}**\n\n`;
        if (state.input) {
          md += `**Input:**\n\`\`\`json\n${JSON.stringify(state.input, null, 2)}\n\`\`\`\n\n`;
        }
        if (state.output) {
          md += `**Output:**\n\`\`\`\n${state.output}\n\`\`\`\n\n`;
        }
        if (state.error) {
          md += `**Error:**\n\`\`\`\n${state.error}\n\`\`\`\n\n`;
        }
        if (detailed && state.time) {
          const duration = ((state.time.end - state.time.start) / 1000).toFixed(1);
          md += `*Status: ${state.status} (${duration}s)*\n\n`;
        }
        break;
      }

      case "reasoning": {
        if (!detailed) break;
        const text = part.text as string | undefined;
        if (text) {
          md += `<details>\n<summary>Thinking</summary>\n\n${text}\n\n</details>\n\n`;
        }
        break;
      }

      case "step-start": {
        if (!detailed) break;
        md += `---\n*Step started*\n\n`;
        break;
      }

      case "step-finish": {
        if (!detailed) break;
        const reason = part.reason as string | undefined;
        const cost = part.cost as number | undefined;
        const tokens = part.tokens as {
          input: number;
          output: number;
          reasoning: number;
          cache: { read: number; write: number };
        } | undefined;
        let info = `*Step finished`;
        if (reason) info += ` (${reason})`;
        info += `*`;
        if (tokens) {
          info += `\n*Tokens: ${tokens.input} in / ${tokens.output} out`;
          if (tokens.reasoning > 0) info += ` / ${tokens.reasoning} reasoning`;
          if (tokens.cache.read > 0 || tokens.cache.write > 0) {
            info += ` (cache: ${tokens.cache.read} read, ${tokens.cache.write} write)`;
          }
          info += `*`;
        }
        if (cost !== undefined && cost > 0) {
          info += `\n*Cost: $${cost.toFixed(4)}*`;
        }
        md += `${info}\n\n---\n\n`;
        break;
      }

      case "subtask": {
        if (!detailed) break;
        const description = part.description as string | undefined;
        const agent = part.agent as string | undefined;
        const prompt = part.prompt as string | undefined;
        md += `**Subtask${agent ? ` (${agent})` : ""}**`;
        if (description) md += `: ${description}`;
        md += `\n\n`;
        if (prompt) {
          md += `> ${prompt.replace(/\n/g, "\n> ")}\n\n`;
        }
        break;
      }

      case "agent": {
        if (!detailed) break;
        const name = part.name as string | undefined;
        if (name) {
          md += `*Agent: ${name}*\n\n`;
        }
        break;
      }

      case "retry": {
        if (!detailed) break;
        const attempt = part.attempt as number | undefined;
        const error = part.error as { data?: { message?: string } } | undefined;
        md += `**Retry (attempt ${attempt || "?"})**`;
        if (error?.data?.message) {
          md += `\n\`\`\`\n${error.data.message}\n\`\`\``;
        }
        md += `\n\n`;
        break;
      }

      case "compaction": {
        if (!detailed) break;
        const auto = part.auto as boolean | undefined;
        md += `*Context compacted${auto ? " (auto)" : ""}*\n\n`;
        break;
      }

      default:
        // snapshot, patch, file, etc. - skip in both modes
        break;
    }

    return md;
  }

  // Handle /export command - export the current session to the opencode project directory
  // Usage: /export        - default (text + tool calls only)
  //        /export full   - detailed (includes thinking, steps, costs, subtasks, etc.)
  bot.command("export", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const sessionId = chatSessions.get(chatId);

    if (!sessionId) {
      await ctx.reply(
        "No active session. Send a message first to create one."
      );
      return;
    }

    const args = ctx.message.text.replace(/^\/export\s*/, "").trim().toLowerCase();
    const detailed = args === "full" || args === "detailed" || args === "all";

    try {
      const modeLabel = detailed ? "detailed" : "summary";
      const processingMsg = await ctx.reply(`Exporting session (${modeLabel})...`);

      // Fetch session info and messages in parallel
      const [sessionResult, messagesResult, pathResult] = await Promise.all([
        client.session.get({ path: { id: sessionId } }),
        client.session.messages({ path: { id: sessionId } }),
        client.path.get(),
      ]);

      if (sessionResult.error || !sessionResult.data) {
        throw new Error(
          `Failed to get session: ${JSON.stringify(sessionResult.error)}`
        );
      }
      if (messagesResult.error || !messagesResult.data) {
        throw new Error(
          `Failed to get messages: ${JSON.stringify(messagesResult.error)}`
        );
      }

      const session = sessionResult.data;
      const messages = messagesResult.data;

      // Build the markdown export
      let md = `# ${session.title}\n\n`;
      md += `**Session ID:** ${session.id}\n`;
      md += `**Created:** ${new Date(session.time.created * 1000).toLocaleString()}\n`;
      md += `**Updated:** ${new Date(session.time.updated * 1000).toLocaleString()}\n`;
      if (detailed) {
        md += `**Export mode:** Detailed\n`;
      }
      md += `\n---\n\n`;

      for (const msg of messages) {
        const info = msg.info;
        const parts = msg.parts || [];

        if (info.role === "user") {
          md += `## User\n\n`;
          for (const part of parts) {
            md += renderPart(part as { type: string; [key: string]: unknown }, detailed);
          }
          md += `---\n\n`;
        } else if (info.role === "assistant") {
          const assistant = info as {
            modelID: string;
            providerID?: string;
            mode?: string;
            time: { created: number; completed?: number };
            cost?: number;
            tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
          };
          const duration = assistant.time.completed
            ? ((assistant.time.completed - assistant.time.created) / 1000).toFixed(1) + "s"
            : "";
          const modelLabel = assistant.modelID || "unknown";
          const modeLabel = assistant.mode || "";
          const header = [modeLabel, modelLabel, duration].filter(Boolean).join(" · ");
          md += `## Assistant (${header})\n\n`;

          if (detailed && assistant.tokens) {
            const t = assistant.tokens;
            md += `*Tokens: ${t.input} in / ${t.output} out`;
            if (t.reasoning > 0) md += ` / ${t.reasoning} reasoning`;
            if (t.cache.read > 0 || t.cache.write > 0) {
              md += ` (cache: ${t.cache.read} read, ${t.cache.write} write)`;
            }
            md += `*\n`;
            if (assistant.cost && assistant.cost > 0) {
              md += `*Cost: $${assistant.cost.toFixed(4)}*\n`;
            }
            md += `\n`;
          }

          for (const part of parts) {
            md += renderPart(part as { type: string; [key: string]: unknown }, detailed);
          }
          md += `---\n\n`;
        }
      }

      // Write to the project directory
      const projectDir = pathResult.data?.directory;
      const idPrefix = sessionId.substring(0, 8);
      const suffix = detailed ? "-detailed" : "";
      const filename = `session-${idPrefix}${suffix}.md`;
      const exportPath = resolve(projectDir || ".", filename);

      writeFileSync(exportPath, md, "utf-8");
      console.log(
        `[Telegram] Exported session ${sessionId} to ${exportPath} (${detailed ? "detailed" : "summary"})`
      );

      // Delete the processing message
      try {
        await bot.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
      } catch {
        // Ignore if we can't delete it
      }

      // Send the file to the user
      await bot.telegram.sendDocument(ctx.chat.id, {
        source: Buffer.from(md, "utf-8"),
        filename,
      });

      await ctx.reply(`Session exported to: ${exportPath}`);
    } catch (err) {
      console.error("[Telegram] Error exporting session:", err);
      await handleSessionError(chatId);
      await ctx.reply(
        "Sorry, there was an error exporting the session. Try again or use /new to start a fresh session."
      );
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
            agent: "default",
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
      const modelOverride = chatModelOverride.get(chatId) || model;
      if (modelOverride) {
        const [providerID, ...modelParts] = modelOverride.split("/");
        const modelID = modelParts.join("/");
        promptBody.model = { providerID, modelID };
      }

      const verbose = chatVerboseMode.has(chatId);

      await sendPromptStreaming(
        ctx.chat.id,
        sessionId,
        promptBody,
        processingMsg.message_id,
        verbose
      );
    } catch (err) {
      console.error("[Telegram] Error processing message:", err);
      await handleSessionError(chatId);
      await ctx.reply(
        "Sorry, there was an error processing your request. Try again or use /new to start a fresh session."
      );
    }
  });

  if (options.launch !== false) {
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

  return bot;
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
