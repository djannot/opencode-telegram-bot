import { describe, it, expect, beforeAll } from "vitest";
import { createOpencodeClient } from "@opencode-ai/sdk";
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

      const responses = sentMessages
        .map((m) => m.text)
        .filter((t) => !t.includes("Processing your request"));

      expect(responses.length).toBeGreaterThan(0);
    },
    60000
  );
});
