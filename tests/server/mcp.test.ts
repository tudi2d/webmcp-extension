/**
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createMcpBridge, refuseMcpRequest } from '../../server/mcp.ts';

/** A real server holding the panel's connection, as server/server.ts does. */
async function connectPanel(bridge: ReturnType<typeof createMcpBridge>) {
  const server = http.createServer((_req, res) => bridge.attachPanel(res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}`, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    /** The next line that is a call rather than a keepalive. */
    async nextCall() {
      while (true) {
        const end = buffer.indexOf('\n');
        if (end === -1) {
          const { value, done } = await reader.read();
          if (done) throw new Error('The connection ended before a call arrived.');
          buffer += decoder.decode(value);
          continue;
        }
        const line = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (line.id) return line;
      }
    },
    close() {
      controller.abort();
      server.closeAllConnections();
      server.close();
    },
  };
}

const callTool = (name: string, args: unknown = {}) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, arguments: args },
});

test('refuseMcpRequest takes local agents with the token, and nothing else', () => {
  const token = 'secret';
  const authorization = 'Bearer secret';
  assert.equal(refuseMcpRequest('POST', { authorization }, token), null);
  assert.equal(refuseMcpRequest('POST', {}, token)?.status, 401);
  assert.equal(refuseMcpRequest('POST', { authorization: 'Bearer wrong' }, token)?.status, 401);
  assert.equal(refuseMcpRequest('GET', { authorization }, token)?.status, 405);
  // A web page holding the token is still a web page.
  assert.equal(refuseMcpRequest('POST', { authorization, origin: 'https://evil.example' }, token)?.status, 403);
  assert.equal(refuseMcpRequest('POST', { authorization, origin: 'chrome-extension://abc' }, token)?.status, 403);
});

test('initialize agrees a protocol version and hands over the safety instructions', async () => {
  const { handle } = createMcpBridge();
  const reply = (version: string) =>
    handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version } }) as Promise<any>;

  assert.equal((await reply('2025-03-26')).result.protocolVersion, '2025-03-26');
  const unknown = await reply('1999-01-01');
  assert.equal(unknown.result.protocolVersion, '2025-11-25');
  assert.deepEqual(unknown.result.capabilities, { tools: {} });
  assert.match(unknown.result.instructions, /untrusted-/);
});

test('notifications get no reply, and bad messages get JSON-RPC errors', async () => {
  const { handle } = createMcpBridge();
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(((await handle([])) as any).error.code, -32600);
  assert.equal(((await handle(null)) as any).error.code, -32600);
  assert.equal(((await handle({ id: 1, method: 'nope' })) as any).error.code, -32601);
  assert.equal(((await handle(callTool('nope'))) as any).error.code, -32602);
});

test('tools/list declares the three browser tools', async () => {
  const { handle } = createMcpBridge();
  const { result } = (await handle({ id: 1, method: 'tools/list' })) as any;
  assert.deepEqual(result.tools.map((tool: any) => tool.name), ['list_tabs', 'list_page_tools', 'call_page_tool']);
});

test('a call with no panel open says what to do, as a tool error the agent can read', async () => {
  const { handle } = createMcpBridge();
  const { result } = (await handle(callTool('list_tabs'))) as any;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /side panel/);
});

test('a call goes to the panel, and its output comes back to the agent', async () => {
  const bridge = createMcpBridge();
  const panel = await connectPanel(bridge);
  try {
    const reply = bridge.handle(callTool('call_page_tool', { name: 'book', args: { seats: 2 } }));
    const call = await panel.nextCall();
    assert.equal(call.tool, 'call_page_tool');
    assert.deepEqual(call.args, { name: 'book', args: { seats: 2 } });

    bridge.settle({ id: call.id, content: ['booked', 'page state'] });
    const { id, result } = (await reply) as any;
    assert.equal(id, 7);
    assert.deepEqual(result, {
      content: [
        { type: 'text', text: 'booked' },
        { type: 'text', text: 'page state' },
      ],
    });
  } finally {
    panel.close();
  }
});

test('an error in the browser reaches the agent as a tool error', async () => {
  const bridge = createMcpBridge();
  const panel = await connectPanel(bridge);
  try {
    const reply = bridge.handle(callTool('list_tabs'));
    const { id } = await panel.nextCall();
    bridge.settle({ id, error: 'Tool "x" is not available on this page.' });
    const { result } = (await reply) as any;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not available/);
  } finally {
    panel.close();
  }
});

test('a panel closing mid-call answers the agent rather than leaving it hanging', async () => {
  const bridge = createMcpBridge();
  const panel = await connectPanel(bridge);
  const reply = bridge.handle(callTool('list_tabs'));
  await panel.nextCall();
  panel.close();
  const { result } = (await reply) as any;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /closed/);
});

test('a panel that never answers times out, and a late or unknown answer is ignored', async () => {
  const bridge = createMcpBridge({ callTimeoutMs: 20 });
  const panel = await connectPanel(bridge);
  try {
    const reply = bridge.handle(callTool('list_tabs'));
    const { id } = await panel.nextCall();
    const { result } = (await reply) as any;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /did not answer/);
    bridge.settle({ id, content: ['too late'] });
    bridge.settle({ id: 'unknown' });
    bridge.settle(null);
  } finally {
    panel.close();
  }
});
