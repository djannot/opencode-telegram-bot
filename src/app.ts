import { Telegraf } from "telegraf";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = resolve(__dirname, "..", "sessions.json");

interface OpencodeClientLike {
  session: {
    list: (params?: any, options?: any) => Promise<any>;
    create: (params: any, options?: any) => Promise<any>;
    update: (params: any, options?: any) => Promise<any>;
    delete: (params: any, options?: any) => Promise<any>;
    get: (params: any, options?: any) => Promise<any>;
    messages: (params: any, options?: any) => Promise<any>;
    command: (params: any, options?: any) => Promise<any>;
    promptAsync: (params: any, options?: any) => Promise<any>;
  };
  command: {
    list: (params?: any, options?: any) => Promise<any>;
  };
  provider: {
    list: (params?: any, options?: any) => Promise<any>;
  };
  path: {
    get: (params?: any, options?: any) => Promise<any>;
  };
  event: {
    subscribe: (params?: any, options?: any) => Promise<any>;
  };
  question: {
    list: (params?: any, options?: any) => Promise<any>;
    reply: (params: any, options?: any) => Promise<any>;
    reject: (params: any, options?: any) => Promise<any>;
  };
  app: {
    agents: (params?: any, options?: any) => Promise<any>;
  };
}

type PromptPartInput =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; filename?: string; url: string };

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
  catch: (fn: (err: unknown, ctx: any) => void) => void;
  start: (fn: (ctx: any) => void | Promise<void>) => void;
  help: (fn: (ctx: any) => void | Promise<void>) => void;
  command: (command: string, fn: (ctx: any) => void | Promise<void>) => void;
  on: (event: string, fn: (ctx: any) => void | Promise<void>) => void;
  action: (trigger: string | RegExp, fn: (ctx: any) => void | Promise<void>) => void;
  launch: (options?: { dropPendingUpdates?: boolean }) => Promise<void>;
  stop: (reason?: string) => void;
  telegram: {
    sendMessage: (chatId: number, text: string, options?: Record<string, unknown>) => Promise<any>;
    deleteMessage: (chatId: number, messageId: number) => Promise<void>;
    sendDocument: (chatId: number, file: { source: Buffer; filename: string }) => Promise<void>;
    getFileLink: (fileId: string) => Promise<{ toString(): string }>;
    setMyCommands: (commands: Array<{ command: string; description: string }>) => Promise<unknown>;
    pinChatMessage: (chatId: number, messageId: number, extra?: Record<string, unknown>) => Promise<void>;
    unpinChatMessage: (chatId: number, messageId?: number) => Promise<void>;
    editMessageText: (chatId: number | undefined, messageId: number | undefined, inlineMessageId: string | undefined, text: string, extra?: Record<string, unknown>) => Promise<void>;
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

  // Available agents fetched from OpenCode on startup
  let availableAgents: Array<{ name: string; description: string; mode: string }> = [];

  // Verify connection to the OpenCode server and fetch available commands
  const opencodeCommands = new Set<string>();
  const opencodeCommandMenu: Array<{ command: string; description: string }> = [];
  const hiddenOpenCodeCommands = new Set(["init", "review", "reviews"]);
  const isHiddenOpenCodeCommand = (name: string) =>
    hiddenOpenCodeCommands.has(name.toLowerCase());
  let projectDirectory = "";
  try {
    const sessions = await client.session.list({});
    if (sessions.error) {
      throw new Error(`Server returned error: ${JSON.stringify(sessions.error)}`);
    }
    console.log(`[Telegram] Connected to OpenCode server at ${url}`);

    // Fetch the project directory (needed for SSE event subscription)
    const pathResult = await client.path.get({});
    if (pathResult.data?.directory) {
      projectDirectory = pathResult.data.directory;
      console.log(`[Telegram] Project directory: ${projectDirectory}`);
    }

    // Fetch available OpenCode commands
    const cmds = await client.command.list({});
    if (cmds.data) {
      for (const cmd of cmds.data) {
        const name = cmd.name;
        if (!name) continue;
        opencodeCommands.add(name);
        console.log(`[Telegram] Found OpenCode command: ${name}`);
        if (!isHiddenOpenCodeCommand(name) && /^[a-z0-9_]{1,32}$/.test(name)) {
          const desc = cmd.description || "OpenCode command";
          opencodeCommandMenu.push({
            command: name,
            description: desc.length > 256 ? desc.slice(0, 253) + "..." : desc,
          });
        }
      }
      console.log(
        `[Telegram] Available OpenCode commands: ${[...opencodeCommands].join(", ")}`
      );
    }

    // Fetch available agents
    const agentsResult = await client.app.agents({});
    if (agentsResult.data) {
      availableAgents = (agentsResult.data as Array<{ name: string; description?: string; mode?: string; hidden?: boolean }>)
        .filter((a) => !a.hidden)
        .map((a) => ({
          name: a.name,
          description: a.description || "",
          mode: a.mode || "primary",
        }));
      console.log(
        `[Telegram] Available agents: ${availableAgents.map((a) => `${a.name} (${a.mode})`).join(", ")}`
      );
    }
  } catch (err) {
    throw new Error(
      `[Telegram] Failed to connect to OpenCode server at ${url}. Make sure it's running (npm run serve). Error: ${err}`
    );
  }

  // Telegram-only commands that should not be forwarded to OpenCode
  const telegramCommands = new Set([
    "start", "help", "new", "sessions", "switch", "title", "delete", "export", "verbose", "model", "usage", "agent",
  ]);

  const telegramCommandMenu: Array<{ command: string; description: string }> = [
    { command: "new", description: "Start a new conversation" },
    { command: "sessions", description: "List your sessions" },
    { command: "title", description: "Rename a session (/title <text>)" },
    { command: "export", description: "Export session (/export full for details)" },
    { command: "verbose", description: "Toggle verbose mode" },
    { command: "model", description: "Search models (/model <keyword>)" },
    { command: "agent", description: "Switch agent (plan, build, ...)" },
    { command: "usage", description: "Show token and cost usage" },
    { command: "help", description: "Show available commands" },
  ];

  const getVisibleOpenCodeCommands = () =>
    [...opencodeCommands].filter((command) => !isHiddenOpenCodeCommand(command));

  // Map of chatId -> sessionId for the active session per chat
  const chatSessions = new Map<string, string>();
  // Set of all session IDs ever created/used by this bot (for filtering)
  const knownSessionIds = new Set<string>();
  // Set of chatIds with verbose mode enabled
  const chatVerboseMode = new Set<string>();
  // Map of chatId -> model override (provider/model)
  const chatModelOverride = new Map<string, string>();
  // Map of chatId -> agent override (e.g. "plan", "build")
  const chatAgentOverride = new Map<string, string>();
  // Map of chatId -> pinned status message ID
  const chatPinnedStatusMsg = new Map<string, number>();

  // Map of chatId -> last search results (in-memory only)
  const chatModelSearchResults = new Map<
    string,
    Array<{ providerID: string; modelID: string; displayName: string }>
  >();
  // Map of questionId -> pending question context (for forwarding OpenCode questions to Telegram)
  const pendingQuestions = new Map<
    string,
    {
      chatId: string;
      sessionId: string;
      questions: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string }>;
        multiple: boolean;
      }>;
    }
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
        agents: Object.fromEntries(chatAgentOverride),
        pinnedStatus: Object.fromEntries(chatPinnedStatusMsg),
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
    let storedAgents: Record<string, string> = {};
    let storedPinnedStatus: Record<string, number> = {};
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
          storedAgents = parsed.agents || {};
          storedPinnedStatus = parsed.pinnedStatus || {};
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

    // Restore agent overrides
    for (const [chatId, agentName] of Object.entries(storedAgents)) {
      if (agentName) {
        chatAgentOverride.set(chatId, agentName);
      }
    }

    // Restore pinned status message IDs
    for (const [chatId, msgId] of Object.entries(storedPinnedStatus)) {
      if (msgId) {
        chatPinnedStatusMsg.set(chatId, msgId);
      }
    }

    // Fetch all server sessions once for validation and fallback matching
    let serverSessions: Array<{ id: string; title: string }> = [];
    try {
      const list = await client.session.list({});
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

  // Build a reverse lookup: sessionId -> chatId
  function sessionToChatId(sessionId: string): string | undefined {
    for (const [chatId, sid] of chatSessions) {
      if (sid === sessionId) return chatId;
    }
    return undefined;
  }

  // Track which sessions were just created so we can auto-title them
  const newlyCreatedSessions = new Set<string>();

  /**
   * Get or create an OpenCode session for a given chat.
   */
  async function getOrCreateSession(chatId: string): Promise<string> {
    let sessionId = chatSessions.get(chatId);
    if (!sessionId) {
      const session = await client.session.create({
        title: `Telegram chat ${chatId}`,
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
        sessionID: sessionId,
        title,
      });
      console.log(`[Telegram] Auto-titled session ${sessionId}: "${title}"`);
    } catch (err) {
      console.warn("[Telegram] Failed to auto-title session:", err);
    }
  }

  function buildPromptBody(chatId: string, parts: PromptPartInput[]) {
    const promptBody: {
      parts: PromptPartInput[];
      model?: { providerID: string; modelID: string };
      agent?: string;
    } = { parts };

    const modelOverride = chatModelOverride.get(chatId) || model;
    if (modelOverride) {
      const [providerID, ...modelParts] = modelOverride.split("/");
      const modelID = modelParts.join("/");
      promptBody.model = { providerID, modelID };
    }

    const agentOverride = chatAgentOverride.get(chatId);
    if (agentOverride) {
      promptBody.agent = agentOverride;
    }

    return promptBody;
  }

  function getChatIdFromContext(ctx: any) {
    const direct = ctx.chat?.id;
    if (direct) return direct.toString();
    const fromCallback = ctx.callbackQuery?.message?.chat?.id;
    if (fromCallback) return fromCallback.toString();
    return null;
  }

  async function answerAndEdit(ctx: any, text: string) {
    if (typeof ctx.answerCbQuery === "function") {
      try {
        await ctx.answerCbQuery();
      } catch {
        // Ignore "query is too old" or other callback query errors —
        // the callback may have expired but we still want to update the message.
      }
    }

    if (typeof ctx.editMessageText === "function") {
      try {
        await ctx.editMessageText(text);
      } catch {
        // If edit fails (message deleted, too old, etc.), fall back to reply
        try {
          await ctx.reply(text);
        } catch {
          // Give up silently
        }
      }
      return;
    }

    await ctx.reply(text);
  }

  async function getTelegramFileUrl(fileId: string): Promise<string> {
    const link = await bot.telegram.getFileLink(fileId);
    return link.toString();
  }

  function isTextMime(mime: string) {
    const normalized = mime.toLowerCase();
    return (
      normalized.startsWith("text/") ||
      normalized === "application/json" ||
      normalized === "application/xml" ||
      normalized === "application/yaml" ||
      normalized === "application/x-yaml" ||
      normalized === "application/markdown"
    );
  }

  async function fetchTelegramFileText(fileId: string, maxBytes = 200_000) {
    const url = await getTelegramFileUrl(fileId);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.status}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new Error("File is too large to send as text.");
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error("File is too large to send as text.");
    }

    return new TextDecoder("utf-8").decode(buffer);
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
      parts: PromptPartInput[];
      model?: { providerID: string; modelID: string };
    },
    processingMsgId: number,
    verbose = false
  ) {
    // Subscribe to SSE events before sending the prompt so we don't miss anything
    const abortController = new AbortController();
    const subscribeParams: Record<string, unknown> = {};
    if (projectDirectory) {
      subscribeParams.directory = projectDirectory;
    }
    const { stream } = await client.event.subscribe(
      subscribeParams,
      { signal: abortController.signal } as any
    );
    // Fire the prompt asynchronously (returns immediately)
    const asyncResult = await client.session.promptAsync({
      sessionID: sessionId,
      ...promptBody,
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
    const sentSubtaskIds = new Set<string>();
    let sawDelegation = false;
    let sentSubagentDetails = false;
    let sentSubagentResponseNotice = false;

    function extractTaskId(outputText: string): string | null {
      const match = outputText.match(/task[_-]?id:\s*([\w-]+)/i);
      return match ? match[1] : null;
    }

    async function emitSubagentMessages(taskSessionId: string) {
      try {
        const messagesResult = await client.session.messages({
          sessionID: taskSessionId,
        });
        if (messagesResult.error || !messagesResult.data) {
          console.warn(
            `[Telegram] Failed to fetch subagent messages for ${taskSessionId}: ${JSON.stringify(
              messagesResult.error
            )}`
          );
          return;
        }
        for (const msg of messagesResult.data) {
          const info = msg.info as { role?: string } | undefined;
          if (info?.role !== "assistant") continue;
          const parts = msg.parts || [];
          for (const part of parts) {
            if (part.type === "reasoning") {
              const text = part.text as string | undefined;
              if (!text) continue;
              const truncated = truncate(text.replace(/\n/g, " "), 500);
              await sendTelegramMessage(
                chatId,
                `\u{1F9E0} Thinking (agent: subagent): ${truncated}`,
                true
              );
              sentSubagentDetails = true;
            }
            if (part.type === "tool") {
              const tool = part.tool as string;
              const state = part.state as {
                status: string;
                input?: { [key: string]: unknown };
                error?: string;
              } | undefined;
              if (!state) continue;
              if (state.status !== "completed" && state.status !== "error") continue;
              const summary = summarizeTool(tool, state.input);
              let line = `\u{2699}\u{FE0F} ${summary} (agent: subagent)`;
              if (state.status === "error") {
                line += ` \u{274C}`;
              }
              await sendTelegramMessage(chatId, line, true);
              sentSubagentDetails = true;
            }
          }
        }
        if (!sentSubagentResponseNotice) {
          await sendTelegramMessage(
            chatId,
            "ℹ️ Subagent responded",
            true
          );
          sentSubagentResponseNotice = true;
        }
      } catch (err) {
        console.warn("[Telegram] Error fetching subagent messages:", err);
      }
    }
    // Buffer the latest reasoning text -- we send it when a non-reasoning part arrives
    // so we get the complete thinking block rather than a partial one
    let pendingReasoning: { id: string; text: string; agent?: string } | null = null;

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
        const agentLabel = pendingReasoning.agent
          ? ` (agent: ${pendingReasoning.agent})`
          : "";
        await sendTelegramMessage(
          chatId,
          `\u{1F9E0} Thinking${agentLabel}: ${truncated}`,
          true
        );
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

          const partSessionId = part.sessionID as string | undefined;
          const parentSessionId =
            (part.parentSessionID as string | undefined) ||
            (part.parentSessionId as string | undefined);
          const rootSessionId =
            (part.rootSessionID as string | undefined) ||
            (part.rootSessionId as string | undefined);
          const isPrimarySession = partSessionId === sessionId;
          const isChildSession =
            parentSessionId === sessionId || rootSessionId === sessionId;

          // Only process events for our session (or subagent sessions that link back)
          if (!isPrimarySession && !isChildSession) continue;
          if (!isPrimarySession && isChildSession && verbose) {
            // Subagent events are allowed to stream in verbose mode
          }

          const partText = part.text as string | undefined;

          if (part.type === "reasoning" && part.id) {
            // Buffer reasoning -- keep updating with the latest full text
            if (partText) {
              const agent =
                (part.agent as string | undefined) ||
                (!isPrimarySession ? "subagent" : undefined);
              pendingReasoning = { id: part.id, text: partText, agent };
            }
          } else if (part.type === "tool" && part.id) {
            // A tool part arrived -- flush any pending reasoning first
            await flushReasoning();

            if (verbose) {
              const state = part.state as {
                status: string;
                input?: { [key: string]: unknown };
                output?: unknown;
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
              const agent =
                (part.agent as string | undefined) ||
                (!isPrimarySession ? "subagent" : undefined);
              if (tool === "task") {
                const input = state.input as
                  | { description?: string; prompt?: string }
                  | undefined;
                const description =
                  input?.description || input?.prompt || summarizeTool(tool, state.input);
                let line = `\u{1F9E9} Delegated`;
                if (description) {
                  line += `: ${truncate(description, 120)}`;
                }
                if (agent) {
                  line += ` (agent: ${agent})`;
                }
                if (state.status === "error") {
                  line += ` \u{274C}`;
                }
                await sendTelegramMessage(chatId, line, true);
                sawDelegation = true;
                if (state.output && verbose) {
                  const rawOutput =
                    typeof state.output === "string"
                      ? state.output
                      : JSON.stringify(state.output, null, 2);
                  const outputText = rawOutput.trim();
                  if (outputText) {
                    const taskSessionId = extractTaskId(outputText);
                    if (taskSessionId) {
                      await emitSubagentMessages(taskSessionId);
                    }
                    if (!sentSubagentDetails && !sentSubagentResponseNotice) {
                      await sendTelegramMessage(
                        chatId,
                        "ℹ️ Subagent responded (no thought/tool details available)",
                        true
                      );
                      sentSubagentResponseNotice = true;
                    }
                  }
                }
              } else {
                const summary = summarizeTool(tool, state.input);
                let line = `\u{2699}\u{FE0F} ${summary}`;
                if (agent) {
                  line += ` (agent: ${agent})`;
                }
                if (state.status === "error") {
                  line += ` \u{274C}`;
                }
                await sendTelegramMessage(chatId, line, true);
              }
              }
            }
          } else if (part.type === "subtask") {
            await flushReasoning();
            if (verbose) {
              const id = part.id as string | undefined;
              if (!id || !sentSubtaskIds.has(id)) {
                if (id) sentSubtaskIds.add(id);
                await deleteProcessingMsg();
                const description = part.description as string | undefined;
                const agent =
                  (part.agent as string | undefined) ||
                  (!isPrimarySession ? "subagent" : undefined);
                let line = "\u{1F9E9} Delegated";
                if (description) {
                  line += `: ${truncate(description, 120)}`;
                }
                if (agent) {
                  line += ` (agent: ${agent})`;
                }
                await sendTelegramMessage(chatId, line, true);
                sawDelegation = true;
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
        } else if (ev.type === "question.asked" && ev.properties) {
          const questionSessionId = ev.properties.sessionID as string | undefined;
          if (questionSessionId === sessionId) {
            const questionId = ev.properties.id as string;
            const questions = ev.properties.questions as Array<{
              question: string;
              header: string;
              options: Array<{ label: string; description: string }>;
              multiple: boolean;
            }>;

            if (questionId && questions?.length > 0) {
              // Store the pending question
              pendingQuestions.set(questionId, {
                chatId: chatId.toString(),
                sessionId,
                questions,
              });

              console.log(`[Telegram] Sending ${questions.length} question(s) to chat ${chatId} (question ${questionId})`);

              // Send each question to Telegram with inline buttons
              for (let qi = 0; qi < questions.length; qi++) {
                const q = questions[qi];
                let msg = "";
                if (q.header) msg += `*${q.header}*\n`;
                msg += q.question;

                const keyboard = q.options.map((opt, oi) => [
                  {
                    text: opt.label,
                    callback_data: `qa:${questionId}:${qi}:${oi}`,
                  },
                ]);
                // Add a dismiss/reject button
                keyboard.push([
                  { text: "Dismiss", callback_data: `qa_reject:${questionId}` },
                ]);

                await bot.telegram.sendMessage(chatId, msg, {
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: keyboard,
                  },
                });
              }
            }
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
    if (verbose && sawDelegation) {
      const lines = finalText.split("\n");
      let inTaskResult = false;
      const filtered = lines.filter((line) => {
        const trimmed = line.trim();
        if (/^<task_result>$/i.test(trimmed)) {
          inTaskResult = true;
          return false;
        }
        if (/^<\/task_result>$/i.test(trimmed)) {
          inTaskResult = false;
          return false;
        }
        if (inTaskResult) return false;
        if (/^Subagent response:/i.test(trimmed)) return false;
        if (/^Subagent (ran|returned|reported)/i.test(trimmed)) return false;
        if (/^Ran the subagent/i.test(trimmed)) return false;
        return true;
      });
      const cleaned = filtered.join("\n").trim();
      // If the cleaned text is non-empty, use it; otherwise keep the
      // original finalText so the user still sees the agent's conclusion.
      if (cleaned) {
        finalText = cleaned;
      }
    }

    const chunks = splitMessage(finalText, 4096);
    for (const chunk of chunks) {
      await sendTelegramMessage(chatId, chunk);
    }
  }

  async function handleFileMessage(
    ctx: any,
    fileId: string,
    mime: string,
    filename?: string,
    caption?: string
  ) {
    const chatId = ctx.chat.id.toString();

    try {
      const processingMsg = await ctx.reply("Processing your request...");
      const sessionId = await getOrCreateSession(chatId);

      const titleText = caption || filename || "File upload";
      await autoTitleSession(sessionId, titleText);

      const parts: PromptPartInput[] = [];
      if (caption) {
        parts.push({ type: "text", text: caption });
      }

      const normalizedMime = mime.toLowerCase();
      if (isTextMime(normalizedMime)) {
        const textContent = await fetchTelegramFileText(fileId);
        const header = filename ? `File: ${filename}` : "File";
        parts.push({
          type: "text",
          text: `${header}\n\n${textContent}`,
        });
      } else {
        const url = await getTelegramFileUrl(fileId);
        parts.push({ type: "file", mime: normalizedMime, filename, url });
      }

      const promptBody = buildPromptBody(chatId, parts);
      const verbose = chatVerboseMode.has(chatId);

      // Fire detached so the handler completes and Telegraf can process
      // subsequent updates (e.g. callback queries from question buttons).
      sendPromptStreaming(
        ctx.chat.id,
        sessionId,
        promptBody,
        processingMsg.message_id,
        verbose
      ).catch(async (err) => {
        console.error("[Telegram] Error processing file message:", err);
        await handleSessionError(chatId);
        await sendTelegramMessage(
          ctx.chat.id,
          "Sorry, there was an error processing your request. Try again or use /new to start a fresh session."
        );
      });
    } catch (err) {
      console.error("[Telegram] Error setting up file message:", err);
      await handleSessionError(chatId);
      await ctx.reply(
        "Sorry, there was an error processing your request. Try again or use /new to start a fresh session."
      );
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
          sessionID: sessionId,
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
    : (new Telegraf(token, { handlerTimeout: 600_000 }) as unknown as TelegramBot);

  async function registerCommandMenu() {
    const combined = [...telegramCommandMenu, ...opencodeCommandMenu];
    const seen = new Set<string>();
    const commands: Array<{ command: string; description: string }> = [];
    for (const entry of combined) {
      if (!entry.command || seen.has(entry.command)) continue;
      seen.add(entry.command);
      commands.push(entry);
    }

    if (commands.length === 0) return;
    try {
      await bot.telegram.setMyCommands(commands);
    } catch (err) {
      console.warn("[Telegram] Failed to register command menu:", err);
    }
  }

  // Global error handler — prevents unhandled errors from crashing the process
  bot.catch((err: unknown, ctx: any) => {
    const updateType = ctx?.updateType || "unknown";
    console.error(`[Telegram] Unhandled error in ${updateType} handler:`, err);
  });

  // Middleware to check if the user is authorized
  bot.use((ctx, next) => {
    if (!authorizedUserId) {
      return next();
    }

    // Skip auth for service messages without a sender or from the bot itself
    // (e.g. pin notifications where ctx.from is the bot)
    if (!ctx.from || ctx.from.is_bot) {
      return next();
    }

    const userId = ctx.from.id.toString();
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

  await registerCommandMenu();

  // Handle /start command
  bot.start((ctx) => {
    let msg =
      "Hello! I'm your OpenCode bot. Send me a message and I'll forward it to the OpenCode agent.\n\n" +
      "Bot commands:\n" +
      "/new - Start a new conversation\n" +
      "/sessions - List your sessions (buttons)\n" +
      "/title <text> - Rename the current session\n" +
      "/export - Export the current session as a markdown file\n" +
      "/export full - Export with all details (thinking, costs, steps)\n" +
      "/verbose - Toggle verbose mode (show thinking and tool calls)\n" +
      "/verbose on|off - Set verbose mode explicitly\n" +
      "/model <keyword> - Search available models\n" +
      "/agent - Switch agent (plan, build, ...)\n" +
      "/usage - Show token and cost usage for this session\n" +
      "/help - Show this help message\n";

    const visibleOpenCodeCommands = getVisibleOpenCodeCommands();
    if (visibleOpenCodeCommands.length > 0) {
      msg +=
        "\nOpenCode commands are also available:\n" +
        visibleOpenCodeCommands.map((c) => `/${c}`).join(", ");
    }

    ctx.reply(msg);
  });

  // Handle /help command
  bot.help((ctx) => {
    let msg =
      "Send me any message and I'll process it using OpenCode.\n\n" +
      "Bot commands:\n" +
      "/new - Start a new conversation\n" +
      "/sessions - List your sessions (buttons)\n" +
      "/title <text> - Rename the current session\n" +
      "/export - Export the current session as a markdown file\n" +
      "/export full - Export with all details (thinking, costs, steps)\n" +
      "/verbose - Toggle verbose mode (show thinking and tool calls)\n" +
      "/verbose on|off - Set verbose mode explicitly\n" +
      "/model <keyword> - Search available models\n" +
      "/agent - Switch agent (plan, build, ...)\n" +
      "/usage - Show token and cost usage for this session\n" +
      "/help - Show this help message\n";

    const visibleOpenCodeCommands = getVisibleOpenCodeCommands();
    if (visibleOpenCodeCommands.length > 0) {
      msg +=
        "\nOpenCode commands:\n" +
        visibleOpenCodeCommands.map((c) => `/${c}`).join(", ");
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
    const list = await client.session.list({});
    const data = (list.data || []) as SessionListItem[];
    if (data.length === 0) return [];
    return data
      .filter((s: SessionListItem) => knownSessionIds.has(s.id))
      .sort((a: SessionListItem, b: SessionListItem) => b.time.updated - a.time.updated);
  }

  /**
   * Resolve a user argument to a session ID / prefix.
   */
  function resolveSession(
    sessions: Awaited<ReturnType<typeof getKnownSessions>>,
    arg: string
  ) {
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

      const activeSession = sessions.find((session) => session.id === activeSessionId);
      const msgLines = ["Your sessions:"];
      if (activeSession) {
        msgLines.push(`Current session: ${activeSession.title}`);
      }

      const otherSessions = sessions.filter(
        (session) => session.id !== activeSessionId
      );
      if (otherSessions.length === 0) {
        msgLines.push("This is your only session.");
        await ctx.reply(msgLines.join("\n"));
        return;
      }

      msgLines.push("Tap a session to switch or delete.");

      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      otherSessions.forEach((session) => {
        keyboard.push([
          {
            text: session.title,
            callback_data: `switch:${session.id}`,
          },
          {
            text: "Delete",
            callback_data: `delete:${session.id}`,
          },
        ]);
      });

      await ctx.reply(msgLines.join("\n"), {
        reply_markup: {
          inline_keyboard: keyboard,
        },
      });
    } catch (err) {
      console.error("[Telegram] Error listing sessions:", err);
      await ctx.reply("Failed to list sessions.");
    }
  });

  // Handle /switch <id> command - switch to a different session
  bot.command("switch", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const args = ctx.message.text.replace(/^\/switch\s*/, "").trim();

    if (!args) {
      await ctx.reply(
        "Usage: /switch <session id>\n\nUse /sessions to see available sessions."
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
        sessionID: sessionId,
        title: newTitle,
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

  // Handle /delete <id> command - delete a session
  bot.command("delete", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const args = ctx.message.text.replace(/^\/delete\s*/, "").trim();

    if (!args) {
      await ctx.reply(
        "Usage: /delete <session id>\n\nUse /sessions to see available sessions."
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
        sessionID: match.id,
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


  bot.action(/^switch:(.+)$/, async (ctx) => {
    const chatId = getChatIdFromContext(ctx);
    const sessionId = ctx.match?.[1];
    if (!chatId || !sessionId) return;

    try {
      const sessions = await getKnownSessions();
      const match = sessions.find((session) => session.id === sessionId);
      if (!match) {
        await answerAndEdit(ctx, "Session not found. Use /sessions to refresh.");
        return;
      }

      chatSessions.set(chatId, match.id);
      saveSessions();
      console.log(`[Telegram] Switched chat ${chatId} to session ${match.id}`);
      await answerAndEdit(ctx, `Switched to session: ${match.title}`);
    } catch (err) {
      console.error("[Telegram] Error switching session:", err);
      await answerAndEdit(ctx, "Failed to switch session.");
    }
  });

  bot.action(/^delete:(.+)$/, async (ctx) => {
    const chatId = getChatIdFromContext(ctx);
    const sessionId = ctx.match?.[1];
    if (!chatId || !sessionId) return;

    try {
      const sessions = await getKnownSessions();
      const match = sessions.find((session) => session.id === sessionId);
      if (!match) {
        await answerAndEdit(ctx, "Session not found. Use /sessions to refresh.");
        return;
      }

      const activeSessionId = chatSessions.get(chatId);
      if (match.id === activeSessionId) {
        await answerAndEdit(
          ctx,
          "Cannot delete the active session. Use /new or /switch first, then delete it."
        );
        return;
      }

      const result = await client.session.delete({
        sessionID: match.id,
      });

      if (result.error) {
        throw new Error(JSON.stringify(result.error));
      }

      knownSessionIds.delete(match.id);
      saveSessions();
      console.log(`[Telegram] Deleted session ${match.id}`);
      await answerAndEdit(ctx, `Deleted session: ${match.title}`);
    } catch (err) {
      console.error("[Telegram] Error deleting session:", err);
      await answerAndEdit(ctx, "Failed to delete session.");
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
    updatePinnedStatus(chatId, ctx.chat.id);
  });

  /**
   * Fetch and search available models from connected providers.
   */
  async function searchModels(keyword: string) {
    const list = await client.provider.list({});
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
  // Usage: /model, /model <keyword>, /model default
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

    try {
      const results = await searchModels(args);
      if (results.length === 0) {
        await ctx.reply(`No models found matching "${args}".`);
        return;
      }

      const limited = results.slice(0, 10);
      chatModelSearchResults.set(chatId, limited);

      let msg = `Models matching "${args}":`;
      if (results.length > limited.length) {
        msg += `\nFound ${results.length} models. Refine your search to narrow the list.`;
      }
      msg += "\nTap a model to select.";

      const keyboard = limited.map((item, index) => [
        {
          text: item.displayName,
          callback_data: `model:${index + 1}`,
        },
      ]);
      keyboard.push([
        { text: "Reset to default", callback_data: "model_default" },
      ]);

      await ctx.reply(msg, {
        reply_markup: {
          inline_keyboard: keyboard,
        },
      });
    } catch (err) {
      console.error("[Telegram] Error searching models:", err);
      await ctx.reply("Failed to list models. Try again later.");
    }
  });

  bot.action(/^model:(\d+)$/, async (ctx) => {
    const chatId = getChatIdFromContext(ctx);
    const indexText = ctx.match?.[1];
    if (!chatId || !indexText) return;

    const selectionIndex = Number.parseInt(indexText, 10);
    const results = chatModelSearchResults.get(chatId) || [];
    if (results.length === 0) {
      await answerAndEdit(ctx, "No recent search results. Use /model <keyword> first.");
      return;
    }
    if (selectionIndex < 1 || selectionIndex > results.length) {
      await answerAndEdit(ctx, "Invalid selection. Use the latest model search results.");
      return;
    }

    const selection = results[selectionIndex - 1];
    const value = `${selection.providerID}/${selection.modelID}`;
    chatModelOverride.set(chatId, value);
    saveSessions();
    try { await ctx.answerCbQuery(); } catch { /* ignore */ }
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    updatePinnedStatus(chatId, Number(chatId));
  });

  bot.action("model_default", async (ctx) => {
    const chatId = getChatIdFromContext(ctx);
    if (!chatId) return;
    chatModelOverride.delete(chatId);
    saveSessions();
    try { await ctx.answerCbQuery(); } catch { /* ignore */ }
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    updatePinnedStatus(chatId, Number(chatId));
  });

  // --- Agent switching and pinned status message ---

  function getActiveAgent(chatId: string): string {
    return chatAgentOverride.get(chatId) || "build";
  }

  function getActiveModelDisplay(chatId: string): string {
    const m = chatModelOverride.get(chatId) || model;
    if (!m) return "default";
    const parts = m.split("/");
    return parts.length > 1 ? parts.slice(1).join("/") : m;
  }

  function buildStatusText(chatId: string): string {
    const agent = getActiveAgent(chatId);
    const modelDisplay = getActiveModelDisplay(chatId);
    const verbose = chatVerboseMode.has(chatId) ? "on" : "off";
    return `Agent: *${agent}* | Model: ${modelDisplay} | Verbose: ${verbose}`;
  }

  function buildStatusKeyboard(chatId: string) {
    const active = getActiveAgent(chatId);
    // Show non-hidden agents as buttons, highlight the active one
    const buttons = availableAgents
      .filter((a) => a.mode === "primary" || a.mode === "subagent")
      .map((a) => ({
        text: a.name === active ? `[${a.name}]` : a.name,
        callback_data: `agent:${a.name}`,
      }));
    // Arrange in rows of 3
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < buttons.length; i += 3) {
      keyboard.push(buttons.slice(i, i + 3));
    }
    return keyboard;
  }

  async function updatePinnedStatus(chatId: string, numericChatId: number) {
    const text = buildStatusText(chatId);

    // Delete the old status message to keep the chat clean
    const existingMsgId = chatPinnedStatusMsg.get(chatId);
    if (existingMsgId) {
      try {
        await bot.telegram.deleteMessage(numericChatId, existingMsgId);
      } catch {
        // Already deleted
      }
      chatPinnedStatusMsg.delete(chatId);
    }

    // Always send a fresh message and pin it. Editing in place doesn't
    // refresh the pinned bar on Android, so delete+send+pin is the only
    // reliable approach. The pinned message itself serves as the
    // confirmation — no separate reply is needed.
    try {
      const msg = await bot.telegram.sendMessage(numericChatId, text, {
        parse_mode: "Markdown",
      });
      const messageId = (msg as any).message_id;
      if (messageId) {
        chatPinnedStatusMsg.set(chatId, messageId);
        saveSessions();
        try {
          await bot.telegram.pinChatMessage(numericChatId, messageId, {
            disable_notification: true,
          });
        } catch (pinErr) {
          console.warn("[Telegram] Failed to pin status message:", pinErr);
        }
      }
    } catch (err) {
      console.warn("[Telegram] Failed to send status message:", err);
    }
  }

  // Handle /agent command
  bot.command("agent", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const args = (ctx.message?.text || "").replace(/^\/agent\s*/i, "").trim();

    if (!args) {
      // Show current agent and list available ones
      const current = getActiveAgent(chatId);
      let msg = `Current agent: *${current}*\n\nAvailable agents:\n`;
      for (const a of availableAgents) {
        const marker = a.name === current ? " (active)" : "";
        const desc = a.description ? ` -- ${truncate(a.description, 80)}` : "";
        msg += `- *${a.name}*${marker}${desc}\n`;
      }
      msg += "\nTap a button or use `/agent <name>` to switch.";

      const keyboard = buildStatusKeyboard(chatId);

      await ctx.reply(msg, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    // Direct switch by name
    const target = args.toLowerCase();
    const match = availableAgents.find((a) => a.name === target);
    if (!match) {
      await ctx.reply(
        `Unknown agent "${args}". Available: ${availableAgents.map((a) => a.name).join(", ")}`
      );
      return;
    }

    chatAgentOverride.set(chatId, match.name);
    saveSessions();
    await updatePinnedStatus(chatId, ctx.chat.id);
  });

  // Handle agent switch via inline button
  bot.action(/^agent:(.+)$/, async (ctx) => {
    const chatId = getChatIdFromContext(ctx);
    if (!chatId) return;

    const agentName = ctx.match?.[1];
    if (!agentName) return;

    const match = availableAgents.find((a) => a.name === agentName);
    if (!match) {
      await answerAndEdit(ctx, `Unknown agent: ${agentName}`);
      return;
    }

    chatAgentOverride.set(chatId, match.name);
    saveSessions();

    try { await ctx.answerCbQuery(); } catch { /* ignore */ }
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    await updatePinnedStatus(chatId, Number(chatId));
  });

  // Handle question answer callback (from OpenCode question.asked events)
  bot.action(/^qa:([^:]+):(\d+):(\d+)$/, async (ctx) => {
    console.log("[Telegram] Question answer callback received:", ctx.match?.[0]);
    const questionId = ctx.match?.[1];
    const questionIndex = Number.parseInt(ctx.match?.[2] || "0", 10);
    const optionIndex = Number.parseInt(ctx.match?.[3] || "0", 10);
    if (!questionId) return;

    const pending = pendingQuestions.get(questionId);
    if (!pending) {
      await answerAndEdit(ctx, "This question has expired or was already answered.");
      return;
    }

    const question = pending.questions[questionIndex];
    if (!question) {
      await answerAndEdit(ctx, "Invalid question.");
      return;
    }

    const selectedOption = question.options[optionIndex];
    if (!selectedOption) {
      await answerAndEdit(ctx, "Invalid option.");
      return;
    }

    try {
      // Build answers array: one answer per question, using the selected option label
      const answers = pending.questions.map((q, i) => {
        if (i === questionIndex) {
          return [selectedOption.label];
        }
        // For other questions in the same request, auto-select first option
        return [q.options[0]?.label || ""];
      });

      await client.question.reply({
        requestID: questionId,
        answers,
      });

      pendingQuestions.delete(questionId);
      await answerAndEdit(ctx, `Answered: ${selectedOption.label}`);
    } catch (err) {
      console.error("[Telegram] Error answering question:", err);
      await answerAndEdit(ctx, "Failed to submit answer.");
    }
  });

  // Handle question reject/dismiss callback
  bot.action(/^qa_reject:(.+)$/, async (ctx) => {
    console.log("[Telegram] Question reject callback received:", ctx.match?.[0]);
    const questionId = ctx.match?.[1];
    if (!questionId) return;

    const pending = pendingQuestions.get(questionId);
    if (!pending) {
      await answerAndEdit(ctx, "This question has expired or was already answered.");
      return;
    }

    try {
      await client.question.reject({
        requestID: questionId,
      });

      pendingQuestions.delete(questionId);
      await answerAndEdit(ctx, "Question dismissed.");
    } catch (err) {
      console.error("[Telegram] Error rejecting question:", err);
      await answerAndEdit(ctx, "Failed to dismiss question.");
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
        sessionID: sessionId,
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

  // Handle photo messages (images)
  bot.on("photo", async (ctx) => {
    const photos = ctx.message.photo;
    if (!photos || photos.length === 0) return;
    const largest = photos[photos.length - 1];
    const caption = ctx.message.caption;
    await handleFileMessage(
      ctx,
      largest.file_id,
      "image/jpeg",
      "photo.jpg",
      caption
    );
  });

  // Handle document messages (files)
  bot.on("document", async (ctx) => {
    const doc = ctx.message.document;
    if (!doc) return;
    const caption = ctx.message.caption;
    await handleFileMessage(
      ctx,
      doc.file_id,
      doc.mime_type || "application/octet-stream",
      doc.file_name,
      caption
    );
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
        client.session.get({ sessionID: sessionId }),
        client.session.messages({ sessionID: sessionId }),
        client.path.get({}),
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
        const available = getVisibleOpenCodeCommands()
          .map((c) => `/${c}`)
          .join(", ");
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
          sessionID: sessionId,
          command: commandName,
          arguments: commandArgs,
          agent: "default",
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

      const promptBody = buildPromptBody(chatId, [
        { type: "text", text: userText },
      ]);

      const verbose = chatVerboseMode.has(chatId);

      // Fire detached so the handler completes and Telegraf can process
      // subsequent updates (e.g. callback queries from question buttons).
      sendPromptStreaming(
        ctx.chat.id,
        sessionId,
        promptBody,
        processingMsg.message_id,
        verbose
      ).catch(async (err) => {
        console.error("[Telegram] Error processing message:", err);
        await handleSessionError(chatId);
        await sendTelegramMessage(
          ctx.chat.id,
          "Sorry, there was an error processing your request. Try again or use /new to start a fresh session."
        );
      });
    } catch (err) {
      console.error("[Telegram] Error setting up message:", err);
      await handleSessionError(chatId);
      await ctx.reply(
        "Sorry, there was an error processing your request. Try again or use /new to start a fresh session."
      );
    }
  });

  // Check for pending questions left over from previous bot runs.
  // If any exist for a session we know about, re-forward them to Telegram
  // so the user can answer them and unblock the session.
  try {
    const pendingResult = await client.question.list({});
    if (pendingResult.data && pendingResult.data.length > 0) {
      console.log(
        `[Telegram] Found ${pendingResult.data.length} pending question(s) from previous run`
      );
      for (const pq of pendingResult.data) {
        const questionId = pq.id as string;
        const questionSessionId = pq.sessionID as string;
        const questions = pq.questions as Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description: string }>;
          multiple: boolean;
        }>;
        const chatId = sessionToChatId(questionSessionId);
        if (!chatId || !questionId || !questions?.length) {
          // No matching chat — reject the stale question to unblock the session
          console.log(
            `[Telegram] Rejecting orphan pending question ${questionId} (no matching chat)`
          );
          try {
            await client.question.reject({ requestID: questionId });
          } catch (err) {
            console.warn(`[Telegram] Failed to reject orphan question ${questionId}:`, err);
          }
          continue;
        }

        // Store in pendingQuestions and re-send inline keyboard
        pendingQuestions.set(questionId, {
          chatId,
          sessionId: questionSessionId,
          questions,
        });

        const numericChatId = Number(chatId);
        for (let qi = 0; qi < questions.length; qi++) {
          const q = questions[qi];
          let msg = "";
          if (q.header) msg += `*${q.header}*\n`;
          msg += q.question;
          msg += "\n_(resumed from previous session)_";

          const keyboard = q.options.map((opt, oi) => [
            {
              text: opt.label,
              callback_data: `qa:${questionId}:${qi}:${oi}`,
            },
          ]);
          keyboard.push([
            { text: "Dismiss", callback_data: `qa_reject:${questionId}` },
          ]);

          try {
            await bot.telegram.sendMessage(numericChatId, msg, {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: keyboard },
            });
          } catch (err) {
            console.warn(`[Telegram] Failed to re-send question to chat ${chatId}:`, err);
          }
        }
        console.log(
          `[Telegram] Re-forwarded pending question ${questionId} to chat ${chatId}`
        );
      }
    }
  } catch (err) {
    console.warn("[Telegram] Failed to check for pending questions:", err);
  }

  if (options.launch !== false) {
    try {
      // Start the bot — launch() returns a promise that resolves only
      // when polling stops, so we log before awaiting it.
      console.log("[Telegram] Bot is running (long-polling started)");
      await bot.launch({ dropPendingUpdates: true });

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
