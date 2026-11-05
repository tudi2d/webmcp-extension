/**
 * SPDX-License-Identifier: Apache-2.0
 */

import { createOpenAI } from '@ai-sdk/openai';
import { streamText, type ModelMessage } from 'ai';

import { appendTurnMessages, buildTools, hasPendingToolCalls } from '../../../server/tools.ts';
import { buildSystemInstruction } from '../../../shared/systemPrompt.ts';
import { formatErrorMessage } from '../services/backendBridge.js';
import { type ChatTurnRequest, type ChatTurnResponse, UserFacingError } from '../types/index.js';

/**
 * Runs chat turns from the side panel against any OpenAI-compatible API, with
 * the user's own key, so no local server is needed. It does what the `/api/chat`
 * route of server/server.ts does, with the same helpers.
 */

export interface ApiKeyConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
}

const STORAGE_KEY = 'apiKeyBackend';

const EMPTY_CONFIG: ApiKeyConfig = { enabled: false, baseUrl: '', model: '', apiKey: '' };

/** Kept in this browser profile only. It is never synced or sent to the server. */
export function readApiKeyConfig(): ApiKeyConfig {
  try {
    return { ...EMPTY_CONFIG, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') };
  } catch {
    return EMPTY_CONFIG;
  }
}

export function writeApiKeyConfig(config: ApiKeyConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {}
}

export function isApiKeyBackendOn(): boolean {
  return readApiKeyConfig().enabled;
}

/** Tool results are spotlighted as they are for the server (see applySpotlighting). */
const SPOTLIGHTING = { format: 'Base64-encoded', howToRead: 'Decode the base64 data' };

const chats = new Map<string, ModelMessage[]>();

function openModel({ baseUrl, model, apiKey }: ApiKeyConfig) {
  const isAnthropic = /(^|\.)anthropic\.com$/.test(URL.parse(baseUrl)?.hostname ?? '');
  return createOpenAI({
    baseURL: baseUrl,
    // Local runtimes take no key, but the SDK insists on one.
    apiKey: apiKey || 'none',
    // Anthropic refuses requests with a browser Origin without this.
    headers: isAnthropic ? { 'anthropic-dangerous-direct-browser-access': 'true' } : undefined,
  }).chat(model);
}

export async function sendApiKeyChat(
  request: ChatTurnRequest,
  { signal, onText }: { signal?: AbortSignal; onText?: (text: string) => void } = {}
): Promise<ChatTurnResponse> {
  const config = readApiKeyConfig();
  if (!config.baseUrl || !config.model) {
    throw new UserFacingError('Add a base URL and a model under Settings → Your API key.');
  }

  const { message, toolResponses, tools } = request;
  const chatId = request.chatId || crypto.randomUUID();
  const baseHistory = chats.get(chatId) ?? [];
  if (message === undefined && !hasPendingToolCalls(baseHistory)) {
    throw new UserFacingError('This chat is no longer available. Start a new chat.');
  }

  const history = appendTurnMessages(baseHistory, { message, toolResponses });
  chats.set(chatId, history);

  let text = '';
  try {
    const result = streamText({
      model: openModel(config),
      system: buildSystemInstruction(SPOTLIGHTING),
      messages: history,
      tools: buildTools(tools),
      abortSignal: signal,
    });

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        text += part.text;
        onText?.(text);
      } else if (part.type === 'error') {
        throw part.error;
      }
    }

    const [response, toolCalls] = await Promise.all([result.response, result.toolCalls]);
    chats.set(chatId, [...history, ...response.messages]);
    return {
      chatId,
      text,
      functionCalls: toolCalls.map((call) => ({
        id: call.toolCallId,
        name: call.toolName,
        args: (call.input ?? {}) as Record<string, unknown>,
      })),
    };
  } catch (error) {
    chats.set(chatId, baseHistory);
    if (signal?.aborted) throw error;
    // Unlike the server's replies, this comes straight from the user's own
    // provider and says what to fix, such as a wrong key or model.
    throw new UserFacingError(formatErrorMessage(error));
  }
}

/** Ends one chat, or every chat without a `chatId`. */
export function endApiKeyChat(chatId?: string): void {
  if (chatId) chats.delete(chatId);
  else chats.clear();
}
