import os from 'os';
import path from 'path';
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { runCodexPrompt } from '../packages/host/src/providers/codex.ts';

const WAIT_TIMEOUT_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMissing(filePath, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(filePath)) return true;
    await sleep(50);
  }
  return !existsSync(filePath);
}

async function createMockCodexCli() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentconnect-codex-mcp-rig-'));
  const commandPath = path.join(dir, 'mock-codex.js');
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-V')) {
  console.log('codex 0.0.0');
}
process.exit(0);
`;
  await writeFile(commandPath, script, 'utf8');
  await chmod(commandPath, 0o755);
  return { dir, commandPath };
}

function readCommandDetailArgs(events) {
  const commandDetail = events.find(
    (event) => event?.type === 'detail' && event?.providerDetail?.eventType === 'command'
  );
  if (!commandDetail) return null;
  const args = commandDetail.providerDetail?.data?.args;
  return Array.isArray(args) ? args.map((value) => String(value)) : null;
}

function findConfigValue(args, key) {
  const prefix = `${key}=`;
  const entry = args.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}

async function run() {
  console.log('Codex MCP rig: starting');
  const mock = await createMockCodexCli();
  const previousCodexCommand = process.env.AGENTCONNECT_CODEX_COMMAND;

  try {
    process.env.AGENTCONNECT_CODEX_COMMAND = mock.commandPath;

    const envEvents = [];
    await runCodexPrompt({
      prompt: 'check codex mcp env wrapping',
      repoRoot: process.cwd(),
      cwd: process.cwd(),
      mcpServers: {
        demo: {
          command: 'bunx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          env: { TEST_SECRET: 'ac-secret' },
        },
      },
      onEvent: (event) => envEvents.push(event),
    });

    const envArgs = readCommandDetailArgs(envEvents);
    if (!envArgs) {
      throw new Error('Expected codex command detail event with args.');
    }
    if (envArgs.join(' ').includes('ac-secret')) {
      throw new Error('Codex command detail leaked MCP env values.');
    }
    const wrappedCommand = findConfigValue(envArgs, 'mcp_servers.demo.command');
    if (!wrappedCommand) {
      throw new Error('Missing mcp_servers.demo.command config for Codex run.');
    }
    const wrapperPath = wrappedCommand.replace(/^"/, '').replace(/"$/, '');
    if (!wrapperPath.includes('agentconnect-codex-mcp-')) {
      throw new Error('Expected Codex MCP env wrapper path in command config.');
    }
    const removed = await waitForMissing(wrapperPath);
    if (!removed) {
      throw new Error('Codex MCP wrapper file was not cleaned up after run.');
    }

    const plainEvents = [];
    await runCodexPrompt({
      prompt: 'check codex mcp plain command',
      repoRoot: process.cwd(),
      cwd: process.cwd(),
      mcpServers: {
        plain: {
          command: 'bunx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
        },
      },
      onEvent: (event) => plainEvents.push(event),
    });
    const plainArgs = readCommandDetailArgs(plainEvents);
    if (!plainArgs) {
      throw new Error('Expected codex command detail args for plain MCP run.');
    }
    const plainCommand = findConfigValue(plainArgs, 'mcp_servers.plain.command');
    if (plainCommand !== '"bunx"') {
      throw new Error(`Expected plain MCP command to remain bunx, got ${plainCommand || 'none'}`);
    }

    console.log('Codex MCP rig: ok');
  } finally {
    if (previousCodexCommand === undefined) {
      delete process.env.AGENTCONNECT_CODEX_COMMAND;
    } else {
      process.env.AGENTCONNECT_CODEX_COMMAND = previousCodexCommand;
    }
    await rm(mock.dir, { recursive: true });
  }
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
