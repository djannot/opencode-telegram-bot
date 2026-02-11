import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTelegram } from "../src/app";
import { createMockBot, createMockClient, streamFrom } from "./helpers";

function createTempSessionsFile() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-telegram-bot-"));
  return join(dir, "sessions.json");
}

describe("Telegram bot", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.AUTHORIZED_TELEGRAM_USER_ID = "1";
  });

  it("toggles verbose on/off and persists", async () => {
    const sessionsFilePath = createTempSessionsFile();
    const { bot, dispatchText } = createMockBot();
    const client = createMockClient();

    await startTelegram({
      url: "http://localhost:4096",
      launch: false,
      client,
      botFactory: () => bot as any,
      sessionsFilePath,
    });

    await dispatchText("/verbose on");
    const dataOn = JSON.parse(readFileSync(sessionsFilePath, "utf-8"));
    expect(dataOn.verbose).toContain("1");

    await dispatchText("/verbose off");
    const dataOff = JSON.parse(readFileSync(sessionsFilePath, "utf-8"));
    expect(dataOff.verbose).not.toContain("1");
  });

  it("streams verbose messages with thinking and tool calls", async () => {
    const sessionsFilePath = createTempSessionsFile();
    const { bot, dispatchText, sentMessages } = createMockBot();

    const sessionId = "ses_test";
    const client = createMockClient({
      session: {
        list: vi.fn(async () => ({ data: [], error: undefined })),
        create: vi.fn(async () => ({ data: { id: sessionId }, error: undefined })),
        update: vi.fn(async () => ({ data: {}, error: undefined })),
        promptAsync: vi.fn(async () => ({ data: undefined, error: undefined })),
      },
      event: {
        subscribe: vi.fn(async () => ({
          stream: streamFrom([
            {
              type: "message.part.updated",
              properties: {
                part: {
                  type: "reasoning",
                  id: "prt_r",
                  sessionID: sessionId,
                  text: "Thinking: test reasoning",
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  type: "tool",
                  id: "prt_t",
                  sessionID: sessionId,
                  tool: "read",
                  state: {
                    status: "completed",
                    input: { filePath: "src/app.ts" },
                  },
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  type: "text",
                  id: "prt_txt",
                  sessionID: sessionId,
                  text: "Final response",
                },
              },
            },
            {
              type: "session.idle",
              properties: { sessionID: sessionId },
            },
          ]),
        })),
      },
    });

    await startTelegram({
      url: "http://localhost:4096",
      launch: false,
      client,
      botFactory: () => bot as any,
      sessionsFilePath,
    });

    await dispatchText("/verbose on");
    await dispatchText("Hello");

    const texts = sentMessages.map((m) => m.text);
    expect(texts.join("\n")).toContain("🧠 Thinking:");
    expect(texts.join("\n")).toContain("⚙️ read -- src/app.ts");
    expect(texts.join("\n")).toContain("Final response");
  });

  it("streams non-verbose messages with only final response", async () => {
    const sessionsFilePath = createTempSessionsFile();
    const { bot, dispatchText, sentMessages } = createMockBot();

    const sessionId = "ses_test";
    const client = createMockClient({
      session: {
        list: vi.fn(async () => ({ data: [], error: undefined })),
        create: vi.fn(async () => ({ data: { id: sessionId }, error: undefined })),
        update: vi.fn(async () => ({ data: {}, error: undefined })),
        promptAsync: vi.fn(async () => ({ data: undefined, error: undefined })),
      },
      event: {
        subscribe: vi.fn(async () => ({
          stream: streamFrom([
            {
              type: "message.part.updated",
              properties: {
                part: {
                  type: "reasoning",
                  id: "prt_r",
                  sessionID: sessionId,
                  text: "Thinking: should not show",
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  type: "tool",
                  id: "prt_t",
                  sessionID: sessionId,
                  tool: "read",
                  state: {
                    status: "completed",
                    input: { filePath: "src/app.ts" },
                  },
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  type: "text",
                  id: "prt_txt",
                  sessionID: sessionId,
                  text: "Final response",
                },
              },
            },
            {
              type: "session.idle",
              properties: { sessionID: sessionId },
            },
          ]),
        })),
      },
    });

    await startTelegram({
      url: "http://localhost:4096",
      launch: false,
      client,
      botFactory: () => bot as any,
      sessionsFilePath,
    });

    await dispatchText("Hello");
    const texts = sentMessages.map((m) => m.text);
    expect(texts.join("\n")).not.toContain("Thinking:");
    expect(texts.join("\n")).not.toContain("⚙️");
    expect(texts.join("\n")).toContain("Final response");
  });

  it("searches models and switches via /model", async () => {
    const sessionsFilePath = createTempSessionsFile();
    const { bot, dispatchText, sentMessages } = createMockBot();

    const promptAsync = vi.fn(async () => ({ data: undefined, error: undefined }));
    const client = createMockClient({
      provider: {
        list: vi.fn(async () => ({
          data: {
            connected: ["openai"],
            all: [
              {
                id: "openai",
                name: "OpenAI",
                models: {
                  "gpt-5.2-codex": { name: "gpt-5.2-codex" },
                  "gpt-4.1": { name: "gpt-4.1" },
                },
              },
            ],
          },
          error: undefined,
        })),
      },
      session: {
        create: vi.fn(async () => ({ data: { id: "ses_test" }, error: undefined })),
        update: vi.fn(async () => ({ data: {}, error: undefined })),
        promptAsync,
      },
      event: {
        subscribe: vi.fn(async () => ({
          stream: streamFrom([
            {
              type: "message.part.updated",
              properties: { part: { type: "text", id: "prt_txt", sessionID: "ses_test", text: "Hi" } },
            },
            { type: "session.idle", properties: { sessionID: "ses_test" } },
          ]),
        })),
      },
    });

    await startTelegram({
      url: "http://localhost:4096",
      launch: false,
      client,
      botFactory: () => bot as any,
      sessionsFilePath,
    });

    await dispatchText("/model codex");
    const listText = sentMessages.map((m) => m.text).join("\n");
    expect(listText).toContain("1. gpt-5.2-codex (openai)");

    await dispatchText("/model 1");
    await dispatchText("Hello");

    const call = (promptAsync as any).mock.calls.at(-1)?.[0];
    expect(call?.body?.model).toEqual({ providerID: "openai", modelID: "gpt-5.2-codex" });
  });

  it("resets model override with /model default", async () => {
    const sessionsFilePath = createTempSessionsFile();
    const { bot, dispatchText } = createMockBot();

    const client = createMockClient({
      provider: {
        list: vi.fn(async () => ({
          data: { connected: ["openai"], all: [] },
          error: undefined,
        })),
      },
    });

    await startTelegram({
      url: "http://localhost:4096",
      launch: false,
      client,
      botFactory: () => bot as any,
      sessionsFilePath,
    });

    await dispatchText("/model default");
    const data = JSON.parse(readFileSync(sessionsFilePath, "utf-8"));
    expect(data.models?.["1"]).toBeUndefined();
  });

  it("exports session markdown and sends a document", async () => {
    const sessionsFilePath = createTempSessionsFile();
    const exportDir = mkdtempSync(join(tmpdir(), "opencode-export-"));
    const { bot, dispatchText, sentDocuments } = createMockBot();

    const sessionId = "ses_test";
    const client = createMockClient({
      session: {
        list: vi.fn(async () => ({ data: [], error: undefined })),
        create: vi.fn(async () => ({ data: { id: sessionId }, error: undefined })),
        get: vi.fn(async () => ({ data: { id: sessionId, title: "Test", time: { created: 1, updated: 2 } }, error: undefined })),
        messages: vi.fn(async () => ({
          data: [
            { info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] },
            { info: { role: "assistant", modelID: "test", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: "Hi" }] },
          ],
          error: undefined,
        })),
      },
      path: {
        get: vi.fn(async () => ({ data: { directory: exportDir }, error: undefined })),
      },
    });

    await startTelegram({
      url: "http://localhost:4096",
      launch: false,
      client,
      botFactory: () => bot as any,
      sessionsFilePath,
    });

    await dispatchText("Hello");
    await dispatchText("/export");

    expect(sentDocuments.length).toBe(1);
    const doc = sentDocuments[0];
    expect(doc.filename).toContain("session-");
    expect(doc.content).toContain("# Test");
  });

  it("lists sessions and switches by index", async () => {
    const sessionsFilePath = createTempSessionsFile();
    const { bot, dispatchText, sentMessages } = createMockBot();

    const client = createMockClient({
      session: {
        list: vi.fn(async () => ({
          data: [
            { id: "ses_a", title: "First", time: { updated: 2 } },
            { id: "ses_b", title: "Second", time: { updated: 3 } },
          ],
          error: undefined,
        })),
      },
    });

    // Pre-populate sessions file with known sessions
    const initial = {
      active: { "1": "ses_a" },
      known: ["ses_a", "ses_b"],
      verbose: [],
    };
    writeFileSync(sessionsFilePath, JSON.stringify(initial));

    await startTelegram({
      url: "http://localhost:4096",
      launch: false,
      client,
      botFactory: () => bot as any,
      sessionsFilePath,
    });

    await dispatchText("/sessions");
    expect(sentMessages.map((m) => m.text).join("\n")).toContain("First");
    expect(sentMessages.map((m) => m.text).join("\n")).toContain("Second");

    await dispatchText("/switch 2");
    const data = JSON.parse(readFileSync(sessionsFilePath, "utf-8"));
    expect(data.active["1"]).toBe("ses_a");
  });

  it("renames sessions with /title", async () => {
    const sessionsFilePath = createTempSessionsFile();
    const { bot, dispatchText } = createMockBot();

    const client = createMockClient({
      session: {
        create: vi.fn(async () => ({ data: { id: "ses_test" }, error: undefined })),
        update: vi.fn(async () => ({ data: {}, error: undefined })),
      },
    });

    await startTelegram({
      url: "http://localhost:4096",
      launch: false,
      client,
      botFactory: () => bot as any,
      sessionsFilePath,
    });

    await dispatchText("Hello");
    await dispatchText("/title New Name");

    expect(client.session.update).toHaveBeenCalled();
  });

  it("prevents deleting the active session", async () => {
    const sessionsFilePath = createTempSessionsFile();
    const { bot, dispatchText, sentMessages } = createMockBot();

    const client = createMockClient({
      session: {
        list: vi.fn(async () => ({
          data: [
            { id: "ses_a", title: "First", time: { updated: 2 } },
          ],
          error: undefined,
        })),
      },
    });

    const initial = {
      active: { "1": "ses_a" },
      known: ["ses_a"],
      verbose: [],
    };
    writeFileSync(sessionsFilePath, JSON.stringify(initial));

    await startTelegram({
      url: "http://localhost:4096",
      launch: false,
      client,
      botFactory: () => bot as any,
      sessionsFilePath,
    });

    await dispatchText("/delete 1");
    expect(sentMessages.map((m) => m.text).join("\n")).toContain("Cannot delete the active session");
  });

  it("forwards OpenCode commands", async () => {
    const sessionsFilePath = createTempSessionsFile();
    const { bot, dispatchText, sentMessages } = createMockBot();

    const client = createMockClient({
      command: {
        list: vi.fn(async () => ({ data: [{ name: "review" }], error: undefined })),
      },
      session: {
        create: vi.fn(async () => ({ data: { id: "ses_test" }, error: undefined })),
        command: vi.fn(async () => ({
          data: { parts: [{ type: "text", text: "Review output" }] },
          error: undefined,
        })),
      },
    });

    await startTelegram({
      url: "http://localhost:4096",
      launch: false,
      client,
      botFactory: () => bot as any,
      sessionsFilePath,
    });

    await dispatchText("/review");
    expect(sentMessages.map((m) => m.text).join("\n")).toContain("Review output");
  });

  it("renders /start and /help with verbose info", async () => {
    const sessionsFilePath = createTempSessionsFile();
    const { bot, dispatchText, sentMessages } = createMockBot();
    const client = createMockClient();

    await startTelegram({
      url: "http://localhost:4096",
      launch: false,
      client,
      botFactory: () => bot as any,
      sessionsFilePath,
    });

    await dispatchText("/start");
    await dispatchText("/help");

    const text = sentMessages.map((m) => m.text).join("\n");
    expect(text).toContain("/verbose");
    expect(text).toContain("/verbose on|off");
  });
});
