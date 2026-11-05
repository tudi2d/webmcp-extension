/**
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildHeaders, postToBackend, SERVER_URL } from '../services/backendBridge.js';
import { getSpotlighting } from '../services/chatBridge.js';
import { executeTabTool, getChrome, requestTabTools } from '../services/extensionBridge.js';
import { tabSessions } from '../services/tabSessionStore.js';
import { applySpotlighting, applyTokenLimit, waitForToolsToSettle } from '../services/toolResults.js';
import { type ChatMessage } from '../types/index.js';

/**
 * The side panel's end of server/mcp.ts: takes calls from local agents, runs
 * them, and posts what happened back to the agent.
 *
 * An agent connected with the auth token is trusted like the user, so nothing
 * here asks for permission. The switch in Settings is what grants that, and it
 * is off until the user turns it on. Calls are shown in the tab's chat.
 */

const ENABLED_KEY = 'localAgent';
const RETRY_MS = 2000;
/** A tab with no content script never reports its tools, so don't wait as long as a turn would. */
const TOOL_REPORT_TIMEOUT_MS = 1000;

export type LinkStatus = 'off' | 'connecting' | 'connected';

interface BridgeCall {
  id?: string;
  tool?: string;
  args?: { tabId?: number; frameId?: number; name?: string; args?: Record<string, unknown> };
}

let status: LinkStatus = 'off';
let link: AbortController | null = null;
const listeners = new Set<() => void>();

function setStatus(next: LinkStatus): void {
  status = next;
  for (const listener of [...listeners]) listener();
}

export const getLinkStatus = (): LinkStatus => status;

export function subscribeLinkStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isLocalAgentEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Page content is always fenced here, whatever the page says about itself:
 * no one confirms what an agent does next, so a page must not be able to opt
 * out by marking its output as trusted.
 */
function forAgent(value: unknown): string {
  const fenced = { name: '', untrustedContentHint: true };
  return applySpotlighting(applyTokenLimit(value), fenced, getSpotlighting(true)) as string;
}

async function resolveTabId(tabId?: number): Promise<number> {
  if (typeof tabId === 'number') return tabId;
  const [tab] = (await getChrome()?.tabs.query({ active: true, lastFocusedWindow: true })) ?? [];
  if (tab?.id === undefined) throw new Error('No tab is in front.');
  return tab.id;
}

/** Asks the page for its tools and returns them once they have settled. */
async function currentTools(tabId: number) {
  const toolsView = {
    get current() {
      return tabSessions.getState(tabId).tools;
    },
  };
  await waitForToolsToSettle(toolsView, {
    requestTools: () => requestTabTools(tabId),
    timeoutMs: TOOL_REPORT_TIMEOUT_MS,
  });
  return toolsView.current;
}

/** The message in each tab that lists its agent calls, so they share one. */
const activityMessageIds = new Map<number, number>();
let nextActivityId = 0;

/** Shows a running call in the tab's chat, and returns how to mark it finished. */
function showCall(tabId: number, toolName: string): (succeeded: boolean) => void {
  const label = `\`${toolName.replaceAll('`', '')}\``;
  const running = `- ${label} …`;
  tabSessions.update(tabId, ({ messages }) => {
    const last = messages.at(-1);
    if (last && last.id === activityMessageIds.get(tabId)) {
      return { messages: [...messages.slice(0, -1), { ...last, text: `${last.text}\n${running}` }] };
    }
    // Negative, so it cannot meet the ids useAgentSession hands out.
    const id = --nextActivityId;
    activityMessageIds.set(tabId, id);
    // `onDevice` hides the empty thinking log above it, which an agent call has no use for.
    const message: ChatMessage = { id, role: 'ai', text: `**Local agent**\n\n${running}`, onDevice: true };
    return { messages: [...messages, message] };
  });

  const messageId = activityMessageIds.get(tabId);
  return (succeeded) => {
    tabSessions.update(tabId, ({ messages }) => ({
      messages: messages.map((message) =>
        message.id === messageId
          ? { ...message, text: message.text.replace(running, `- ${label} ${succeeded ? '✓' : '✗'}`) }
          : message
      ),
    }));
  };
}

async function callPageTool({ name, args, frameId, tabId }: NonNullable<BridgeCall['args']>): Promise<string[]> {
  if (typeof name !== 'string' || !name) throw new Error('call_page_tool needs a tool name.');
  const startTabId = await resolveTabId(tabId);
  const finish = showCall(startTabId, name);
  try {
    // Checked first because the content script reports a failed tool as an
    // ordinary result, which would read to the agent as a success.
    const matching = (await currentTools(startTabId)).filter(
      (tool) => tool.name === name && (frameId === undefined || (tool.frameId ?? 0) === frameId)
    );
    const tool = matching.find((candidate) => !candidate.frameId) ?? matching[0];
    if (!tool) throw new Error(`Tool "${name}" is not available on this page.`);

    let endTabId = startTabId;
    const result = await executeTabTool(name, args ?? {}, tool.frameId ?? 0, startTabId, {
      onTabChanged: (movedTabId) => {
        endTabId = movedTabId;
      },
    });
    // The call may have changed the page, and the agent needs to know what it can do next.
    const tools = await currentTools(endTabId);
    finish(true);
    return [forAgent(result), forAgent({ tabId: endTabId, tools: tools.map((tool) => tool.name) })];
  } catch (error) {
    finish(false);
    throw error;
  }
}

/** Runs one call from the server and returns its MCP text content. */
export async function runBridgeCall({ tool, args = {} }: BridgeCall): Promise<string[]> {
  switch (tool) {
    case 'list_tabs': {
      const tabs = (await getChrome()?.tabs.query({})) ?? [];
      return [forAgent(tabs.map(({ id, title, url, active }) => ({ tabId: id, title, url, active })))];
    }
    case 'list_page_tools': {
      const tabId = await resolveTabId(args.tabId);
      const tools = await currentTools(tabId);
      const notice = tabSessions.getState(tabId).statusMsg;
      return [forAgent({ tabId, tools, ...(notice ? { notice } : {}) })];
    }
    case 'call_page_tool':
      return callPageTool(args);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

async function answerCall(call: BridgeCall): Promise<void> {
  let outcome: { content: string[] } | { error: string };
  try {
    outcome = { content: await runBridgeCall(call) };
  } catch (error) {
    outcome = { error: error instanceof Error ? error.message : String(error) };
  }
  await postToBackend('/api/mcp/result', { id: call.id, ...outcome }).catch((error) => {
    console.warn('[WebMCP] Could not report a call back to the server:', error);
  });
}

/** Reads the server's NDJSON stream until it ends. */
async function readCalls(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const call = JSON.parse(line) as BridgeCall;
      // Blank objects only keep the connection alive.
      if (call.id) void answerCall(call);
    }
  }
}

async function keepConnected(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const res = await fetch(`${SERVER_URL}/api/mcp/bridge`, { method: 'POST', headers: buildHeaders(), signal });
      if (res.ok && res.body) {
        setStatus('connected');
        await readCalls(res.body);
      }
    } catch {
      // The server is not running. It may be started at any time.
    }
    if (signal.aborted) return;
    setStatus('connecting');
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

function stopLink(): void {
  link?.abort();
  link = null;
  setStatus('off');
}

function startLink(): void {
  stopLink();
  link = new AbortController();
  setStatus('connecting');
  void keepConnected(link.signal);
}

/** Connects if the user has turned this on, and returns how to disconnect. */
export function startLocalAgentBridge(): () => void {
  if (isLocalAgentEnabled()) startLink();
  return stopLink;
}

export function setLocalAgentEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, String(enabled));
  } catch {}
  if (enabled) startLink();
  else stopLink();
}
