import { vi } from "vitest";

type Middleware = (ctx: any, next: () => Promise<void>) => Promise<void> | void;

export function createMockBot() {
  const middlewares: Middleware[] = [];
  const commands = new Map<string, (ctx: any) => Promise<void> | void>();
  let startHandler: ((ctx: any) => Promise<void> | void) | null = null;
  let helpHandler: ((ctx: any) => Promise<void> | void) | null = null;
  const eventHandlers = new Map<string, (ctx: any) => Promise<void> | void>();
  const actionHandlers: Array<{ trigger: string | RegExp; handler: (ctx: any) => Promise<void> | void }> = [];

  const sentMessages: Array<{ chatId: number; text: string; options?: Record<string, unknown> }> = [];
  const deletedMessages: Array<{ chatId: number; messageId: number }> = [];
  const sentDocuments: Array<{ chatId: number; filename: string; content: string }> = [];
  const editedMessages: Array<{ chatId: number; text: string; options?: Record<string, unknown> }> = [];
  let messageId = 1;

  const telegram = {
    sendMessage: vi.fn(async (chatId: number, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return { message_id: messageId++ };
    }),
    deleteMessage: vi.fn(async (chatId: number, messageIdToDelete: number) => {
      deletedMessages.push({ chatId, messageId: messageIdToDelete });
    }),
    sendDocument: vi.fn(async (chatId: number, file: { source: Buffer; filename: string }) => {
      sentDocuments.push({
        chatId,
        filename: file.filename,
        content: file.source.toString("utf-8"),
      });
    }),
    getFileLink: vi.fn(async (fileId: string) => new URL(`https://files.test/${fileId}`)),
    setMyCommands: vi.fn(async () => true),
  };

  const bot = {
    use(fn: Middleware) {
      middlewares.push(fn);
    },
    start(fn: (ctx: any) => Promise<void> | void) {
      startHandler = fn;
    },
    help(fn: (ctx: any) => Promise<void> | void) {
      helpHandler = fn;
    },
    command(command: string, fn: (ctx: any) => Promise<void> | void) {
      commands.set(command, fn);
    },
    on(event: string, fn: (ctx: any) => Promise<void> | void) {
      eventHandlers.set(event, fn);
    },
    action(trigger: string | RegExp, fn: (ctx: any) => Promise<void> | void) {
      actionHandlers.push({ trigger, handler: fn });
    },
    launch: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
    telegram,
  };

  async function dispatchWithContext(ctx: any, handler: (ctx: any) => Promise<void> | void) {
    async function runMiddlewares(index: number): Promise<void> {
      if (index < middlewares.length) {
        await middlewares[index](ctx, () => runMiddlewares(index + 1));
      } else {
        await handler(ctx);
      }
    }

    await runMiddlewares(0);
  }

  async function dispatchText(text: string, chatId = 1, userId = 1) {
    const ctx = {
      chat: { id: chatId },
      message: { text, from: { id: userId } },
      from: { id: userId },
      reply: async (replyText: string, options?: Record<string, unknown>) => {
        return telegram.sendMessage(chatId, replyText, options);
      },
    };
    const commandMatch = text.match(/^\/(\w+)/);
    const command = commandMatch ? commandMatch[1] : null;

    const handler = command
      ? command === "start"
        ? startHandler
        : command === "help"
          ? helpHandler
          : commands.get(command) || eventHandlers.get("text")
      : eventHandlers.get("text");

    if (!handler) return;
    await dispatchWithContext(ctx, handler);
  }

  async function dispatchDocument(params: {
    fileId: string;
    mimeType?: string;
    fileName?: string;
    caption?: string;
    chatId?: number;
    userId?: number;
  }) {
    const chatId = params.chatId ?? 1;
    const userId = params.userId ?? 1;
    const ctx = {
      chat: { id: chatId },
      message: {
        document: {
          file_id: params.fileId,
          mime_type: params.mimeType,
          file_name: params.fileName,
        },
        caption: params.caption,
        from: { id: userId },
      },
      from: { id: userId },
      reply: async (replyText: string, options?: Record<string, unknown>) => {
        return telegram.sendMessage(chatId, replyText, options);
      },
    };

    const handler = eventHandlers.get("document");
    if (!handler) return;
    await dispatchWithContext(ctx, handler);
  }

  async function dispatchPhoto(params: {
    fileId: string;
    caption?: string;
    chatId?: number;
    userId?: number;
  }) {
    const chatId = params.chatId ?? 1;
    const userId = params.userId ?? 1;
    const ctx = {
      chat: { id: chatId },
      message: {
        photo: [{ file_id: params.fileId }],
        caption: params.caption,
        from: { id: userId },
      },
      from: { id: userId },
      reply: async (replyText: string, options?: Record<string, unknown>) => {
        return telegram.sendMessage(chatId, replyText, options);
      },
    };

    const handler = eventHandlers.get("photo");
    if (!handler) return;
    await dispatchWithContext(ctx, handler);
  }

  async function dispatchCallbackQuery(params: {
    data: string;
    chatId?: number;
    userId?: number;
    messageId?: number;
  }) {
    const chatId = params.chatId ?? 1;
    const userId = params.userId ?? 1;
    const messageIdToEdit = params.messageId ?? 1;
    const ctx: any = {
      chat: { id: chatId },
      from: { id: userId },
      callbackQuery: {
        data: params.data,
        message: {
          message_id: messageIdToEdit,
          chat: { id: chatId },
        },
        from: { id: userId },
      },
      answerCbQuery: vi.fn(async () => {}),
      editMessageText: vi.fn(async (text: string, options?: Record<string, unknown>) => {
        editedMessages.push({ chatId, text, options });
      }),
      reply: async (replyText: string, options?: Record<string, unknown>) => {
        return telegram.sendMessage(chatId, replyText, options);
      },
    };

    let matchEntry:
      | { trigger: string | RegExp; handler: (ctx: any) => Promise<void> | void }
      | undefined;

    for (const entry of actionHandlers) {
      if (typeof entry.trigger === "string") {
        if (entry.trigger === params.data) {
          matchEntry = entry;
          break;
        }
        continue;
      }

      const match = entry.trigger.exec(params.data);
      if (match) {
        ctx.match = match;
        matchEntry = entry;
        break;
      }
    }

    if (!matchEntry) return;

    await dispatchWithContext(ctx, matchEntry.handler);
  }

  return {
    bot,
    telegram,
    sentMessages,
    deletedMessages,
    sentDocuments,
    editedMessages,
    dispatchText,
    dispatchDocument,
    dispatchPhoto,
    dispatchCallbackQuery,
  };
}

export function streamFrom(events: Array<any>) {
  async function* generator() {
    for (const event of events) {
      yield event;
    }
  }
  return generator();
}

export function createMockClient(overrides: Partial<any> = {}) {
  const base = {
    session: {
      list: vi.fn(async () => ({ data: [], error: undefined })),
      create: vi.fn(async () => ({ data: { id: "ses_test" }, error: undefined })),
      update: vi.fn(async () => ({ data: {}, error: undefined })),
      delete: vi.fn(async () => ({ data: {}, error: undefined })),
      get: vi.fn(async () => ({ data: { id: "ses_test" }, error: undefined })),
      messages: vi.fn(async () => ({ data: [], error: undefined })),
      command: vi.fn(async () => ({ data: { parts: [] }, error: undefined })),
      promptAsync: vi.fn(async () => ({ data: undefined, error: undefined })),
    },
    command: {
      list: vi.fn(async () => ({ data: [], error: undefined })),
    },
    provider: {
      list: vi.fn(async () => ({ data: { all: [], connected: [] }, error: undefined })),
    },
    path: {
      get: vi.fn(async () => ({ data: { directory: "/tmp" }, error: undefined })),
    },
    event: {
      subscribe: vi.fn(async () => ({ stream: streamFrom([]) })),
    },
  };

  return {
    ...base,
    ...overrides,
    session: { ...base.session, ...(overrides as any).session },
    command: { ...base.command, ...(overrides as any).command },
    path: { ...base.path, ...(overrides as any).path },
    event: { ...base.event, ...(overrides as any).event },
  };
}
