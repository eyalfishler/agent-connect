import os from 'os';
import path from 'path';
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { JSDOM } from 'jsdom';
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

async function waitFor(check, label, timeoutMs = TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function sendAndWaitForError(session, message, contains, label) {
  const errorEvent = new Promise((resolve, reject) => {
    const offFinal = session.on('final', (event) => {
      offError();
      offFinal();
      reject(
        new Error(
          `${label} unexpectedly returned final output: ${event?.text || '(empty final response)'}`
        )
      );
    });
    const offError = session.on('error', (event) => {
      offError();
      offFinal();
      resolve(event);
    });
  });

  await withTimeout(session.send(message), `${label} send`);
  const event = await withTimeout(errorEvent, `${label} error event`);
  const messageText = event?.message || '';
  if (!messageText.includes(contains)) {
    throw new Error(`${label} had unexpected error message: ${messageText}`);
  }
}

async function createMockClaudeCli() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentconnect-ui-auth-rig-'));
  const commandPath = path.join(dir, 'mock-claude.js');
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-V')) {
  console.log('2.1.39 (Claude Code)');
  process.exit(0);
}
if (!args.includes('--print') && !args.includes('-p')) {
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  if (input.trim() === 'ping') {
    console.log(JSON.stringify({ type: 'result', result: 'ok' }));
    process.exit(0);
    return;
  }
  console.log(JSON.stringify({
    type: 'result',
    is_error: true,
    result:
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}',
  }));
  process.exit(0);
});
if (process.stdin.isTTY) {
  process.stdin.emit('end');
}
`;
  await writeFile(commandPath, script, 'utf8');
  await chmod(commandPath, 0o755);
  return { dir, commandPath };
}

function installDomGlobals(dom) {
  const { window } = dom;
  globalThis.window = window;
  globalThis.self = window;
  globalThis.document = window.document;
  globalThis.customElements = window.customElements;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.localStorage = window.localStorage;
  globalThis.navigator = window.navigator;
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
}

function getAuthRowState(connectEl) {
  const wrap = connectEl.shadowRoot?.querySelector('.ac-popover-auth');
  const text = connectEl.shadowRoot?.querySelector('.ac-popover-auth-text');
  const button = connectEl.shadowRoot?.querySelector('.ac-popover-auth-action');
  return {
    wrap,
    hidden: Boolean(wrap?.hidden),
    text: text?.textContent?.trim() || '',
    button: button?.textContent?.trim() || '',
  };
}

async function run() {
  console.log('UI auth rig: setting up');
  const mockClaude = await createMockClaudeCli();
  const previousClaudeCommand = process.env.AGENTCONNECT_CLAUDE_COMMAND;
  const previousHostMode = process.env.AGENTCONNECT_HOST_MODE;

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  installDomGlobals(dom);

  process.env.AGENTCONNECT_CLAUDE_COMMAND = mockClaude.commandPath;
  delete process.env.AGENTCONNECT_HOST_MODE;

  let client = null;
  try {
    const bridge = createHostBridge({ mode: 'embedded' });
    globalThis.__AGENTCONNECT_BRIDGE__ = bridge;
    client = await withTimeout(AgentConnect.connect({ preferInjected: true }), 'SDK connect');

    const statusBefore = await withTimeout(
      client.providers.status('claude', { fast: false, force: true }),
      'Claude status before auth failure'
    );
    if (!statusBefore.installed) {
      throw new Error('Expected Claude to be installed in UI auth rig.');
    }
    if (!statusBefore.loggedIn) {
      throw new Error('Expected Claude loggedIn=true before auth failure.');
    }

    const { defineAgentConnectComponents, resetClient } =
      await import('../packages/ui/src/index.ts');
    resetClient();
    defineAgentConnectComponents();

    const connectEl = globalThis.document.createElement('agentconnect-connect');
    globalThis.document.body.appendChild(connectEl);

    await waitFor(
      () =>
        Boolean(connectEl.shadowRoot) &&
        Array.isArray(connectEl.state?.providers) &&
        connectEl.state.providers.length > 0,
      'Connect component provider prefetch'
    );

    connectEl.applySelection('claude', 'claude-sonnet-4-5', false, null);
    connectEl.setView('connected');
    await withTimeout(
      connectEl.checkProviderStatus('claude', 'Claude', { silent: true, force: true }),
      'Connected status check before auth failure'
    );

    const rowBefore = getAuthRowState(connectEl);
    if (!rowBefore.wrap) {
      throw new Error('Connected auth row is missing from the connect popover.');
    }
    if (!rowBefore.hidden) {
      throw new Error(
        `Expected auth row hidden before auth failure, got: ${JSON.stringify(rowBefore)}`
      );
    }

    const session = await withTimeout(
      client.sessions.create({ provider: 'claude', model: 'claude-sonnet-4-5' }),
      'Create Claude session'
    );
    await sendAndWaitForError(
      session,
      'trigger auth failure',
      'OAuth token has expired',
      'Claude send auth failure'
    );
    await withTimeout(session.close(), 'Close Claude session').catch(() => {});

    const statusAfter = await withTimeout(
      client.providers.status('claude', { fast: false, force: true }),
      'Claude status after auth failure'
    );
    if (statusAfter.loggedIn !== false) {
      throw new Error('Expected Claude loggedIn=false after auth failure.');
    }

    await withTimeout(
      connectEl.checkProviderStatus('claude', 'Claude', { silent: true, force: true }),
      'Connected status check after auth failure'
    );
    const rowAfter = getAuthRowState(connectEl);
    if (rowAfter.hidden) {
      throw new Error(
        `Expected auth row visible after auth failure, got: ${JSON.stringify(rowAfter)}`
      );
    }
    if (!rowAfter.text.toLowerCase().includes('authentication required')) {
      throw new Error(`Expected auth row text to mention authentication, got: ${rowAfter.text}`);
    }
    if (!['Login', 'Run /login'].includes(rowAfter.button)) {
      throw new Error(
        `Expected auth button label to be Login or Run /login, got: ${rowAfter.button}`
      );
    }

    client.close();
    client = null;
    console.log('UI auth rig: ok');
  } finally {
    if (client) {
      client.close();
    }
    delete globalThis.__AGENTCONNECT_BRIDGE__;
    dom.window.close();
    if (previousClaudeCommand === undefined) {
      delete process.env.AGENTCONNECT_CLAUDE_COMMAND;
    } else {
      process.env.AGENTCONNECT_CLAUDE_COMMAND = previousClaudeCommand;
    }
    if (previousHostMode === undefined) {
      delete process.env.AGENTCONNECT_HOST_MODE;
    } else {
      process.env.AGENTCONNECT_HOST_MODE = previousHostMode;
    }
    await rm(mockClaude.dir, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
