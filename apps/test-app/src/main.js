import { defineAgentConnectComponents } from '@agentconnect/ui';
import { AgentConnect } from '@agentconnect/sdk';

defineAgentConnectComponents();

const connectEl = document.querySelector('agentconnect-connect');
const statusEl = document.querySelector('[data-ac-status]');
const logEl = document.querySelector('[data-chat-log]');
const summaryEl = document.querySelector('[data-chat-summary]');
const summaryTextEl = document.querySelector('[data-chat-summary-text]');
const formEl = document.querySelector('[data-chat-form]');
const inputEl = document.querySelector('[data-chat-input]');
const sendButton = document.querySelector('[data-chat-send]');
const stopButton = document.querySelector('[data-chat-stop]');
const mcpListEl = document.querySelector('[data-mcp-list]');
const mcpAddButton = document.querySelector('[data-mcp-add]');
const mcpResetButton = document.querySelector('[data-mcp-reset]');
const mcpNoteEl = document.querySelector('[data-mcp-note]');
const mcpWarningEl = document.querySelector('[data-mcp-warning]');

let clientPromise = null;
let session = null;
let sessionKey = null;
let assistantBubble = null;
let activeSelection = null;

const DEFAULT_MCP_ROWS = [
  {
    id: 'filesystem',
    command: 'bunx',
    argsText: '-y @modelcontextprotocol/server-filesystem .',
    cwd: '',
    enabled: true,
  },
  {
    id: 'memory',
    command: 'bunx',
    argsText: '-y @modelcontextprotocol/server-memory',
    cwd: '',
    enabled: true,
  },
  {
    id: 'sqlite',
    command: 'bunx',
    argsText: '-y @modelcontextprotocol/server-sqlite ./.agentconnect-test-mcp.sqlite',
    cwd: '',
    enabled: true,
  },
  {
    id: 'playwright',
    command: 'bunx',
    argsText: '-y @playwright/mcp --headless',
    cwd: '',
    enabled: false,
  },
  {
    id: 'puppeteer',
    command: 'bunx',
    argsText: '-y @modelcontextprotocol/server-puppeteer',
    cwd: '',
    enabled: false,
  },
  {
    id: 'github',
    command: 'bunx',
    argsText: '-y @modelcontextprotocol/server-github',
    cwd: '',
    enabled: false,
  },
  {
    id: 'brave-search',
    command: 'bunx',
    argsText: '-y @modelcontextprotocol/server-brave-search',
    cwd: '',
    enabled: false,
  },
  {
    id: 'sequential-thinking',
    command: 'bunx',
    argsText: '-y @modelcontextprotocol/server-sequential-thinking',
    cwd: '',
    enabled: false,
  },
];

let mcpRows = DEFAULT_MCP_ROWS.map((row) => ({ ...row }));

function parseArgsText(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return undefined;
  return trimmed.split(/\s+/).filter(Boolean);
}

function getMcpRowsWithCommand() {
  const rows = [];
  for (const row of mcpRows) {
    const id = String(row.id || '').trim();
    const command = String(row.command || '').trim();
    if (!id || !command) continue;
    rows.push({ id, command, row });
  }
  return rows;
}

function getDuplicateMcpIds() {
  const seen = new Set();
  const duplicates = new Set();
  for (const entry of getMcpRowsWithCommand()) {
    if (seen.has(entry.id)) {
      duplicates.add(entry.id);
      continue;
    }
    seen.add(entry.id);
  }
  return [...duplicates].sort();
}

function updateMcpWarning() {
  if (!mcpWarningEl) return;
  const duplicates = getDuplicateMcpIds();
  if (!duplicates.length) {
    mcpWarningEl.hidden = true;
    mcpWarningEl.textContent = '';
    return;
  }
  mcpWarningEl.hidden = false;
  mcpWarningEl.textContent = `Duplicate server IDs are ignored after the first entry: ${duplicates.join(', ')}`;
}

function buildMcpServers() {
  const servers = {};
  const seen = new Set();
  for (const entry of getMcpRowsWithCommand()) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const args = parseArgsText(entry.row.argsText);
    const cwd = String(entry.row.cwd || '').trim();
    servers[entry.id] = {
      command: entry.command,
      ...(args?.length ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(entry.row.enabled === false ? { enabled: false } : {}),
    };
  }
  return Object.keys(servers).length ? servers : undefined;
}

function getMcpServersForSelection(selection) {
  if (!selection || selection.provider === 'local') return undefined;
  return buildMcpServers();
}

function mcpKeyForSelection(selection) {
  const servers = getMcpServersForSelection(selection);
  return JSON.stringify(servers || {});
}

function updateMcpNote() {
  if (!mcpNoteEl) return;
  if (!activeSelection) {
    mcpNoteEl.textContent = 'MCP servers are applied for Claude, Codex, and Cursor.';
    return;
  }
  if (activeSelection.provider === 'local') {
    mcpNoteEl.textContent = 'Local provider does not support MCP loadouts yet.';
    return;
  }
  mcpNoteEl.textContent = `This MCP loadout will be used for the next ${activeSelection.provider} session.`;
}

function createField({ label, value, field, index, placeholder, wide = false }) {
  const wrap = document.createElement('div');
  wrap.className = `mcp-field${wide ? ' mcp-field-wide' : ''}`;
  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder || '';
  input.dataset.index = String(index);
  input.dataset.field = field;
  wrap.append(labelEl, input);
  return wrap;
}

function renderMcpRows() {
  if (!mcpListEl) return;
  mcpListEl.innerHTML = '';

  if (!mcpRows.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-message system';
    empty.textContent = 'No MCP servers configured.';
    mcpListEl.appendChild(empty);
    return;
  }

  mcpRows.forEach((row, index) => {
    const item = document.createElement('div');
    item.className = 'mcp-row';

    const grid = document.createElement('div');
    grid.className = 'mcp-grid';
    grid.append(
      createField({
        label: 'Server ID',
        value: row.id,
        field: 'id',
        index,
        placeholder: 'filesystem',
      }),
      createField({
        label: 'Command',
        value: row.command,
        field: 'command',
        index,
        placeholder: 'bunx',
      }),
      createField({
        label: 'Args',
        value: row.argsText,
        field: 'argsText',
        index,
        placeholder: '-y @modelcontextprotocol/server-memory',
        wide: true,
      }),
      createField({
        label: 'Cwd (optional)',
        value: row.cwd,
        field: 'cwd',
        index,
        placeholder: '.',
        wide: true,
      })
    );

    const footer = document.createElement('div');
    footer.className = 'mcp-footer';

    const toggle = document.createElement('label');
    toggle.className = 'mcp-toggle';
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = row.enabled !== false;
    toggleInput.dataset.index = String(index);
    toggleInput.dataset.field = 'enabled';
    const toggleText = document.createElement('span');
    toggleText.textContent = 'Enabled';
    toggle.append(toggleInput, toggleText);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'mcp-remove';
    removeButton.textContent = 'Remove';
    removeButton.dataset.index = String(index);
    removeButton.dataset.action = 'remove';

    footer.append(toggle, removeButton);
    item.append(grid, footer);
    mcpListEl.appendChild(item);
  });

  updateMcpWarning();
}

function ensureClient() {
  if (!clientPromise) {
    clientPromise = AgentConnect.connect();
  }
  return clientPromise;
}

function updateStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function setSummary(text) {
  if (!summaryEl || !summaryTextEl) return;
  const summary = text?.trim();
  if (!summary) {
    summaryTextEl.textContent = '';
    summaryEl.hidden = true;
    return;
  }
  summaryTextEl.textContent = summary;
  summaryEl.hidden = false;
}

function setFormEnabled(enabled) {
  if (inputEl) inputEl.disabled = !enabled;
  if (sendButton) sendButton.disabled = !enabled;
  if (stopButton) stopButton.disabled = !enabled || !session;
}

function appendMessage(role, text, className) {
  if (!logEl) return null;
  const item = document.createElement('div');
  item.className = `chat-message ${className || ''}`.trim();
  const label = document.createElement('div');
  label.className = 'chat-label';
  label.textContent = role;
  const body = document.createElement('div');
  body.className = 'chat-body';
  body.textContent = text;
  item.append(label, body);
  logEl.appendChild(item);
  logEl.scrollTop = logEl.scrollHeight;
  return body;
}

function setAssistantText(text) {
  if (!assistantBubble) {
    assistantBubble = appendMessage('Assistant', '', 'assistant');
  }
  if (assistantBubble) {
    assistantBubble.textContent = text;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }
}

async function ensureSession(selection) {
  if (!selection) return null;
  const key = `${selection.provider}:${selection.model || ''}:${selection.reasoningEffort || ''}:${mcpKeyForSelection(selection)}`;
  if (session && key === sessionKey) return session;
  if (session) {
    try {
      await session.close();
    } catch (err) {
      void err;
    }
  }

  const client = await ensureClient();
  const mcpServers = getMcpServersForSelection(selection);
  session = await client.sessions.create({
    provider: selection.provider,
    model: selection.model || 'default',
    reasoningEffort: selection.reasoningEffort || undefined,
    providerDetailLevel: 'minimal',
    mcpServers,
  });
  sessionKey = key;
  assistantBubble = null;
  setSummary('');

  session.on('delta', (event) => {
    setAssistantText((assistantBubble?.textContent || '') + event.text);
  });
  session.on('final', (event) => {
    setAssistantText(event.text);
    assistantBubble = null;
  });
  session.on('message', (event) => {
    if (event.role === 'assistant') {
      setAssistantText(event.content || '');
      assistantBubble = null;
    }
  });
  session.on('error', (event) => {
    appendMessage('Error', event.message, 'error');
    assistantBubble = null;
  });
  session.on('summary', (event) => {
    setSummary(event.summary);
  });

  return session;
}

function handleSelection(detail) {
  activeSelection = detail;
  updateMcpNote();
  setSummary('');
  if (!detail) {
    updateStatus('Not connected');
    setFormEnabled(false);
    return;
  }
  updateStatus(`${detail.provider} · ${detail.model || 'default'}`);
  setFormEnabled(true);
}

connectEl?.addEventListener('agentconnect:connected', (event) => {
  handleSelection(event.detail);
});

connectEl?.addEventListener('agentconnect:selection-changed', (event) => {
  handleSelection(event.detail);
});

connectEl?.addEventListener('agentconnect:disconnected', () => {
  handleSelection(null);
});

mcpListEl?.addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const index = Number(target.dataset.index);
  const field = target.dataset.field;
  if (!Number.isFinite(index) || !field || !mcpRows[index]) return;
  if (field === 'enabled') {
    mcpRows[index].enabled = target.checked;
    return;
  }
  mcpRows[index][field] = target.value;
});

mcpListEl?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.dataset.action !== 'remove') return;
  const index = Number(target.dataset.index);
  if (!Number.isFinite(index) || !mcpRows[index]) return;
  mcpRows.splice(index, 1);
  renderMcpRows();
});

mcpAddButton?.addEventListener('click', () => {
  mcpRows.push({
    id: '',
    command: '',
    argsText: '',
    cwd: '',
    enabled: true,
  });
  renderMcpRows();
});

mcpResetButton?.addEventListener('click', () => {
  mcpRows = DEFAULT_MCP_ROWS.map((row) => ({ ...row }));
  renderMcpRows();
});

formEl?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl?.value?.trim();
  if (!text) return;
  if (!activeSelection) {
    appendMessage('System', 'Select a provider first.', 'system');
    return;
  }
  appendMessage('You', text, 'user');
  if (inputEl) inputEl.value = '';
  setFormEnabled(false);
  try {
    const sessionInstance = await ensureSession(activeSelection);
    await sessionInstance.send(text);
  } catch (err) {
    appendMessage('Error', err?.message || 'Failed to send message.', 'error');
  } finally {
    setFormEnabled(true);
  }
});

stopButton?.addEventListener('click', async () => {
  if (!session) return;
  try {
    await session.cancel();
  } catch (err) {
    void err;
  }
});

setFormEnabled(false);
updateMcpNote();
updateMcpWarning();
renderMcpRows();
