/**
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'puppeteer-core';
import { createSmokeSession, smokeSkipReason, type SmokeSessionContext } from './chromeHarness.js';
import {
  clickOrThrow,
  closeSettings,
  frame0ToolName,
  openSettings,
  readExecutedTools,
  SELECTORS,
  submitPromptInSidebar,
  waitForSidebarText,
} from './sidePanelHelpers.js';
import { NAMED_TOOLS } from './smokeServer.js';

const LOCAL_AGENT_SWITCH = '[role="switch"][aria-label="Allow local agents"]';
const API_KEY_SWITCH = '[role="switch"][aria-label="Your API key"]';

async function connectLocalAgent(sidebar: Page): Promise<void> {
  await openSettings(sidebar);
  await clickOrThrow(sidebar, LOCAL_AGENT_SWITCH);
  await waitForSidebarText(sidebar, 'Connected.');
  await closeSettings(sidebar);
}

/** Calls an MCP tool the way an agent's client does, and returns the reply. */
async function callTool({ server }: SmokeSessionContext, name: string, args: object = {}) {
  const reply = await server.mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return (reply as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
}

/** Sets a controlled input the way typing would, in the background sidebar tab. */
async function fillField(sidebar: Page, label: string, value: string): Promise<void> {
  await sidebar.evaluate(
    (label, value) => {
      const field = [...document.querySelectorAll('.connect-field')].find((node) => node.textContent?.startsWith(label));
      const input = field?.querySelector('input');
      if (!input) throw new Error(`No field labelled ${label}`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    label,
    value
  );
}

/** An OpenAI-compatible provider that asks for one tool, then answers. */
async function startProvider(toolName: string) {
  const requests: Array<{ authorization?: string; messages: Array<{ role: string }> }> = [];
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { messages } = JSON.parse(body);
      requests.push({ authorization: req.headers.authorization, messages });
      const delta =
        messages.at(-1).role === 'tool'
          ? { content: 'Your key works.' }
          : { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: toolName, arguments: '{}' } }] };
      const chunk = { id: 'c', created: 1, model: 'm', choices: [{ index: 0, delta }] };
      const finish = { id: 'c', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe('Smoke — Local agent and API key', { skip: smokeSkipReason(), timeout: 60_000 }, () => {
  it('a local agent is refused until the user allows it', async () => {
    const session = await createSmokeSession();
    try {
      const { isError, content } = await callTool(session, 'list_tabs');
      assert.equal(isError, true);
      assert.match(content[0].text, /side panel/);
    } finally {
      await session.close();
    }
  });

  it('a local agent finds and runs page tools with no prompt, gets the output, and shows up in the chat', async () => {
    const session = await createSmokeSession();
    const { page, sidebar } = session;
    try {
      await connectLocalAgent(sidebar);

      const tabs = await callTool(session, 'list_tabs');
      assert.match(tabs.content[0].text, /^<untrusted-/);
      assert.match(tabs.content[0].text, /test-page/);

      const listed = await callTool(session, 'list_page_tools');
      assert.match(listed.content[0].text, new RegExp(NAMED_TOOLS.deleteAccount.name));

      // The tool the page marks as irreversible, which always prompts in chat.
      const called = await callTool(session, 'call_page_tool', { name: NAMED_TOOLS.deleteAccount.name, args: {} });
      assert.equal(called.isError, undefined);
      assert.match(called.content[0].text, /^<untrusted-/);
      assert.match(called.content[1].text, /"tools":\[.*get_flights/);

      assert.deepEqual(
        (await readExecutedTools(page)).map(({ name }) => name),
        [NAMED_TOOLS.deleteAccount.name]
      );
      assert.equal(await sidebar.$(SELECTORS.permissionCard), null);
      await waitForSidebarText(sidebar, 'Local agent');
      await waitForSidebarText(sidebar, `${NAMED_TOOLS.deleteAccount.name} ✓`);

      const missing = await callTool(session, 'call_page_tool', { name: 'no_such_tool' });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text, /not available/);
      await waitForSidebarText(sidebar, 'no_such_tool ✗');
    } finally {
      await session.close();
    }
  });

  it('turning the switch off cuts the agent off', async () => {
    const session = await createSmokeSession();
    const { sidebar } = session;
    try {
      await connectLocalAgent(sidebar);
      await openSettings(sidebar);
      await clickOrThrow(sidebar, LOCAL_AGENT_SWITCH);
      await sidebar.waitForFunction(() => !document.body.innerText.includes('Connected.'), { polling: 50 });

      // The server sees the connection drop a moment later.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal((await callTool(session, 'list_tabs')).isError, true);
    } finally {
      await session.close();
    }
  });

  it('chat runs on the API key with no server, and keeps its permission prompts', async () => {
    const session = await createSmokeSession();
    const { server, page, sidebar } = session;
    const provider = await startProvider(frame0ToolName(NAMED_TOOLS.bookFlight.name));
    try {
      await openSettings(sidebar);
      await clickOrThrow(sidebar, API_KEY_SWITCH);
      await waitForSidebarText(sidebar, 'Base URL');
      await fillField(sidebar, 'Base URL', provider.baseUrl);
      await fillField(sidebar, 'Model', 'test-model');
      await fillField(sidebar, 'API key', 'sk-browser');
      await closeSettings(sidebar);

      await submitPromptInSidebar(sidebar, 'Book it');
      await sidebar.waitForSelector(SELECTORS.permissionCard);
      assert.equal((await readExecutedTools(page)).length, 0);
      await clickOrThrow(sidebar, SELECTORS.permissionAllow);

      await waitForSidebarText(sidebar, 'Your key works.');
      assert.equal((await readExecutedTools(page)).length, 1);
      assert.equal(provider.requests.length, 2);
      assert.equal(provider.requests[0].authorization, 'Bearer sk-browser');
      assert.equal(server.chatRequests.length, 0);
    } finally {
      provider.close();
      await session.close();
    }
  });
});
