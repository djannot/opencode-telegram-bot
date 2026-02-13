import { describe, it, expect, beforeAll } from "vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { startTelegram } from "../src/app";
import { createMockBot } from "./helpers";

const runIntegration = !!process.env.OPENCODE_TEST_URL;
const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration("integration", () => {
  beforeAll(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.AUTHORIZED_TELEGRAM_USER_ID = "1";
  });

  it(
    "streams a real OpenCode response",
    async () => {
      const url = process.env.OPENCODE_TEST_URL as string;
      const model = process.env.OPENCODE_TEST_MODEL;

      const { bot, dispatchText, sentMessages } = createMockBot();
      const client = createOpencodeClient({ baseUrl: url });

      await startTelegram({
        url,
        model,
        launch: false,
        client: client as any,
        botFactory: () => bot as any,
      });

      await dispatchText("Hello");

      // sendPromptStreaming runs detached; poll until a real response arrives
      const deadline = Date.now() + 30_000;
      let responses: string[] = [];
      while (Date.now() < deadline) {
        responses = sentMessages
          .map((m) => m.text)
          .filter((t) => !t.includes("Processing your request"));
        if (responses.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      expect(responses.length).toBeGreaterThan(0);
    },
    60000
  );
});
