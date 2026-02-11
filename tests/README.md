# Tests

This directory contains the unit and integration tests for the Telegram bot.

## Unit tests

Run all unit tests (one-shot):

```bash
npm run test:run
```

Run in watch mode:

```bash
npm test
```

## Integration tests

Integration tests require a running OpenCode server. They are skipped unless
`OPENCODE_TEST_URL` is set.

Run integration tests:

```bash
OPENCODE_TEST_URL=http://localhost:4096 npm run test:integration
```

Optional model override:

```bash
OPENCODE_TEST_MODEL=openai/gpt-5.2-codex npm run test:integration
```

## Files

- `tests/app.test.ts` - Unit tests for bot behavior
- `tests/helpers.ts` - Mock bot and client helpers
- `tests/integration.test.ts` - Optional integration test

## What is tested

Unit tests (`tests/app.test.ts`) cover:

- Verbose mode toggle and persistence to `sessions.json`
- Streaming responses in verbose mode (thinking + tool call summaries + final text)
- Streaming responses in non-verbose mode (final text only)
- Session export (`/export`) writes markdown and sends a document
- Session listing and switching by index
- Session renaming via `/title`
- Preventing deletion of the active session
- Forwarding OpenCode commands (e.g. `/review`)
- `/start` and `/help` output includes verbose commands
- Model search and switching with `/model`

Integration test (`tests/integration.test.ts`) covers:

- End-to-end streaming of a real OpenCode response (requires `OPENCODE_TEST_URL`)
