import http from 'http';
import os from 'os';
import path from 'path';
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { AgentConnect } from '../packages/sdk/src/index.ts';
import { createHostBridge } from '@agentconnect/host';

const TIMEOUT_MS = 15000;

function withTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function expectReject(promise, contains, label) {
  try {
    await promise;
  } catch (err) {
    const message = err?.message || String(err);
    if (!message.includes(contains)) {
      throw new Error(`${label} failed with unexpected error: ${message}`);
    }
    return;
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

async function sendAndWait(session, message, options, label = 'Session send') {
  const detailEvents = [];
  const finalEvent = new Promise((resolve, reject) => {
    const offDetail = session.on('detail', (event) => {
      detailEvents.push(event);
    });
    const offFinal = session.on('final', (event) => {
      offDetail();
      offFinal();
      offError();
      resolve(event);
    });
    const offError = session.on('error', (event) => {
      offDetail();
      offFinal();
      offError();
      reject(new Error(event.message));
    });
  });

  await withTimeout(session.send(message, options), label);
  const final = await withTimeout(finalEvent, `${label} final`);
  return { final, detailEvents };
}

async function createMockClaudeExpiredAuthCli() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentconnect-claude-auth-'));
  const commandPath = path.join(dir, 'mock-claude.js');
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-V')) {
  console.log('claude 0.0.0');
  process.exit(0);
}
if (args.includes('--print') || args.includes('-p')) {
  console.log(JSON.stringify({
    type: 'result',
    is_error: true,
    result:
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}',
  }));
  process.exit(0);
}
process.exit(0);
`;
  await writeFile(commandPath, script, 'utf8');
  await chmod(commandPath, 0o755);
  return { dir, commandPath };
}

function startLocalApi() {
  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString('utf8');
      }
      if (!body) {
        res.statusCode = 400;
        res.end('missing body');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind local model server.'));
        return;
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
    });
  });
}

async function run() {
  console.log('Smoke: starting embedded host bridge');
  const { server, baseUrl } = await startLocalApi();
  const mockClaude = await createMockClaudeExpiredAuthCli();
  const previousClaudeCommand = process.env.AGENTCONNECT_CLAUDE_COMMAND;
  process.env.AGENTCONNECT_LOCAL_BASE_URL = baseUrl;
  process.env.AGENTCONNECT_LOCAL_MODEL = 'mock-model';
  process.env.AGENTCONNECT_CLAUDE_COMMAND = mockClaude.commandPath;

  try {
    const bridge = createHostBridge({ mode: 'embedded' });
    globalThis.__AGENTCONNECT_BRIDGE__ = bridge;

    const client = await AgentConnect.connect({ preferInjected: true });
    const hello = await withTimeout(client.hello(), 'Hello');
    if (!hello.hostId) throw new Error('Host hello failed.');
    if (!Array.isArray(hello.capabilities) || !hello.capabilities.includes('sessions.mcpServers')) {
      throw new Error('Host did not advertise sessions.mcpServers capability.');
    }

    const providers = await withTimeout(client.providers.list(), 'Providers list');
    if (!Array.isArray(providers)) throw new Error('Provider list failed.');
    const localProvider = providers.find((provider) => provider.id === 'local');
    if (!localProvider) throw new Error('Local provider not found.');
    if (localProvider.supportsMcpServers !== false) {
      throw new Error('Expected local provider MCP support to be false.');
    }
    const claudeProvider = providers.find((provider) => provider.id === 'claude');
    if (!claudeProvider) throw new Error('Claude provider not found.');
    if (claudeProvider.supportsMcpServers !== true) {
      throw new Error('Expected claude provider MCP support to be true.');
    }
    const codexProvider = providers.find((provider) => provider.id === 'codex');
    if (!codexProvider) throw new Error('Codex provider not found.');
    if (codexProvider.supportsMcpServers !== true) {
      throw new Error('Expected codex provider MCP support to be true.');
    }
    const cursorProvider = providers.find((provider) => provider.id === 'cursor');
    if (!cursorProvider) throw new Error('Cursor provider not found.');
    if (cursorProvider.supportsMcpServers !== true) {
      throw new Error('Expected cursor provider MCP support to be true.');
    }
    const claudeStatus = await withTimeout(
      client.providers.status('claude', { fast: false, force: true }),
      'Claude auth status'
    );
    if (claudeStatus.loggedIn !== false) {
      throw new Error('Expected Claude loggedIn=false when CLI reports expired OAuth token.');
    }

    await expectReject(
      withTimeout(
        client.sessions.create({
          model: 'local',
          mcpServers: {
            invalid: { command: '' },
          },
        }),
        'Session create invalid MCP'
      ),
      'AC_ERR_INVALID_ARGS',
      'Session create invalid MCP'
    );

    const session = await withTimeout(
      client.sessions.create({
        model: 'local',
        mcpServers: {
          demo: { command: 'echo', args: ['hi'] },
        },
      }),
      'Session create'
    );
    if (!session?.id) throw new Error('Session create failed.');

    await expectReject(
      withTimeout(session.send('session-level mcp unsupported'), 'Session send unsupported'),
      'AC_ERR_UNSUPPORTED',
      'Session send unsupported'
    );

    const sendWithNullOverride = await sendAndWait(
      session,
      'clear mcp for one call',
      { mcpServers: null },
      'Session send with null MCP override'
    );
    if (!sendWithNullOverride.final?.text) {
      throw new Error('Expected final output after null MCP override.');
    }

    await expectReject(
      withTimeout(
        session.send('session-level mcp still active after one-shot clear'),
        'Session send unsupported after null override'
      ),
      'AC_ERR_UNSUPPORTED',
      'Session send unsupported after null override'
    );

    await withTimeout(
      client.sessions.resume(session.id, { mcpServers: null }),
      'Session resume clear MCP'
    );

    const sendAfterResumeClear = await sendAndWait(
      session,
      'session-level mcp cleared via resume',
      undefined,
      'Session send after resume clear'
    );
    if (!sendAfterResumeClear.final?.text) {
      throw new Error('Expected final output after resume MCP clear.');
    }
    const hasCommandDetail = sendAfterResumeClear.detailEvents.some(
      (event) => event.providerDetail?.eventType === 'command'
    );
    if (!hasCommandDetail) {
      throw new Error('Expected provider command detail event for session send.');
    }

    await withTimeout(
      client.sessions.resume(session.id, {
        mcpServers: {
          demo: { command: 'echo', args: ['hi'] },
        },
      }),
      'Session resume set MCP'
    );

    await expectReject(
      withTimeout(
        session.send('session-level mcp unsupported after resume set'),
        'Session send unsupported after resume set'
      ),
      'AC_ERR_UNSUPPORTED',
      'Session send unsupported after resume set'
    );

    const sendWithInvalidOneShot = await sendAndWait(
      session,
      'invalid mcp one-shot should continue',
      {
        mcpServers: {
          broken: { args: ['missing-command'] },
        },
      },
      'Session send invalid MCP one-shot'
    );
    const hasMcpFailureDetail = sendWithInvalidOneShot.detailEvents.some(
      (event) => event.providerDetail?.eventType === 'mcp.server_failed'
    );
    if (!hasMcpFailureDetail) {
      throw new Error(
        'Expected non-fatal mcp.server_failed detail event for invalid one-shot MCP.'
      );
    }

    await expectReject(
      withTimeout(
        session.send('session-level mcp remains after invalid one-shot'),
        'Session send unsupported after invalid one-shot'
      ),
      'AC_ERR_UNSUPPORTED',
      'Session send unsupported after invalid one-shot'
    );

    await withTimeout(session.close(), 'Session close');
    client.close();
    console.log('Smoke: bridge ok');
  } finally {
    if (previousClaudeCommand === undefined) {
      delete process.env.AGENTCONNECT_CLAUDE_COMMAND;
    } else {
      process.env.AGENTCONNECT_CLAUDE_COMMAND = previousClaudeCommand;
    }
    await rm(mockClaude.dir, { recursive: true });
    server.close();
  }
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
