# AgentConnect Test App

Minimal app for testing AgentConnect behavior in isolation, without extra product logic.

## Run locally

From the repo root:

```bash
bun install
bun --cwd apps/test-app run dev
```

Start the host in a second terminal:

```bash
agentconnect dev --app apps/test-app --ui http://localhost:5174
```

## MCP testing

Use the MCP Loadout panel in the app UI to add, edit, enable, or remove servers.

When you send prompts, provider command lines (prompt redacted) are emitted in
the host terminal when `--log-spawn` is enabled.

By default, the app starts with:

- `@modelcontextprotocol/server-filesystem`
- `@modelcontextprotocol/server-memory`
- `@modelcontextprotocol/server-sqlite`
- `@playwright/mcp` (disabled by default)
- `@modelcontextprotocol/server-puppeteer` (disabled by default)
- `@modelcontextprotocol/server-github` (disabled by default)
- `@modelcontextprotocol/server-brave-search` (disabled by default)
- `@modelcontextprotocol/server-sequential-thinking` (disabled by default)

Note:

- MCP dynamic loadouts apply to Claude, Codex, and Cursor.
- Local provider currently does not support MCP loadouts.
- Some servers require external credentials (for example, Brave Search uses `BRAVE_API_KEY`).
