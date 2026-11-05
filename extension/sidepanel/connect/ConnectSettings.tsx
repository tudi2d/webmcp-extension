/**
 * SPDX-License-Identifier: Apache-2.0
 */

import { useId, useState, useSyncExternalStore } from 'react';
import { Switch } from '../components/Switch.js';
import { SymbolIcon } from '../components/Icons.js';
import { getAuthToken, SERVER_URL } from '../services/backendBridge.js';
import { tabSessions } from '../services/tabSessionStore.js';
import { type ApiKeyConfig, readApiKeyConfig, writeApiKeyConfig } from './apiKeyBackend.js';
import {
  getLinkStatus,
  isLocalAgentEnabled,
  type LinkStatus,
  setLocalAgentEnabled,
  subscribeLinkStatus,
} from './mcpBridge.js';

const PRESETS = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' },
  { label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' },
];

export interface ApiKeySettingProps {
  /** The on-device model answers instead while it is on. */
  onDeviceModel: boolean;
  responseInProgress: boolean;
}

/** The API key item of the Model section. */
export function ApiKeySetting({ onDeviceModel, responseInProgress }: ApiKeySettingProps) {
  const descId = useId();
  const [config, setConfig] = useState<ApiKeyConfig>(readApiKeyConfig);

  const update = (changes: Partial<ApiKeyConfig>) => {
    const next = { ...config, ...changes };
    setConfig(next);
    writeApiKeyConfig(next);
  };

  const toggle = () => {
    if (responseInProgress) return;
    // Neither backend can carry on the other's conversation. Each chat is
    // ended before the switch, on the backend that holds it.
    if (!onDeviceModel) {
      for (const tabId of tabSessions.tabIds()) tabSessions.resetChat(tabId);
    }
    update({ enabled: !config.enabled });
  };

  const field = (label: string, key: 'baseUrl' | 'model' | 'apiKey', type = 'text') => (
    <label className="connect-field">
      {label}
      <input
        type={type}
        value={config[key]}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => update({ [key]: event.target.value })}
      />
    </label>
  );

  return (
    <div className="settings-item">
      <div className="settings-item__icon">
        <SymbolIcon name="key" size={24} color="var(--color-on-surface-variant)" />
      </div>
      <div className="settings-item__content">
        <span className="settings-item__title">Your API key</span>
        <p id={descId} className="settings-item__desc">
          {config.enabled && onDeviceModel
            ? 'The on-device model is answering. Turn it off to use your key.'
            : 'Send prompts and page data straight from this browser to any OpenAI-compatible provider. No server needed.'}
        </p>
        {config.enabled && (
          <div className="connect-fields">
            <label className="connect-field">
              Provider
              <select
                value={PRESETS.find(({ baseUrl }) => baseUrl === config.baseUrl)?.label ?? ''}
                onChange={(event) => {
                  const preset = PRESETS.find(({ label }) => label === event.target.value);
                  if (preset) update({ baseUrl: preset.baseUrl, model: preset.model });
                }}
              >
                <option value="">Custom</option>
                {PRESETS.map(({ label }) => (
                  <option key={label}>{label}</option>
                ))}
              </select>
            </label>
            {field('Base URL', 'baseUrl')}
            {field('Model', 'model')}
            {field('API key', 'apiKey', 'password')}
          </div>
        )}
      </div>
      <div className="settings-item__control">
        <Switch
          checked={config.enabled}
          onChange={toggle}
          disabled={responseInProgress}
          aria-label="Your API key"
          aria-describedby={descId}
        />
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<LinkStatus, string> = {
  off: 'Off',
  connecting: 'Waiting for the server. Start it with npm run server.',
  connected: 'Connected. Agents can reach this browser while the panel is open.',
};

/** What an MCP client needs to connect. It holds the auth token, so it is only shown on request. */
function mcpConfig(): string {
  const server = { type: 'http', url: `${SERVER_URL}/mcp`, headers: { Authorization: `Bearer ${getAuthToken()}` } };
  return JSON.stringify({ mcpServers: { webmcp: server } }, null, 2);
}

const getServerStatus = (): LinkStatus => 'off';

/** The Local agent section of the settings. */
export function LocalAgentSection() {
  const descId = useId();
  const [enabled, setEnabled] = useState(isLocalAgentEnabled);
  const [copied, setCopied] = useState(false);
  const status = useSyncExternalStore(subscribeLinkStatus, getLinkStatus, getServerStatus);

  const toggle = () => {
    setLocalAgentEnabled(!enabled);
    setEnabled(!enabled);
  };

  const copyConfig = async () => {
    await navigator.clipboard.writeText(mcpConfig());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Local agent</h2>
      <div className="settings-item">
        <div className="settings-item__icon">
          <SymbolIcon name="terminal" size={24} color="var(--color-on-surface-variant)" />
        </div>
        <div className="settings-item__content">
          <span className="settings-item__title">Allow local agents</span>
          <p id={descId} className="settings-item__desc">
            Let agents on this computer, such as Claude Code, use the tools on your pages over MCP. They run right away,
            with no alerts, including payments and deletions.
          </p>
          {enabled && (
            <div className="connect-fields">
              <p className="connect-status" data-status={status}>
                {STATUS_TEXT[status]}
              </p>
              <button type="button" className="connect-copy" onClick={copyConfig}>
                {copied ? 'Copied' : 'Copy MCP config'}
              </button>
            </div>
          )}
        </div>
        <div className="settings-item__control">
          <Switch
            checked={enabled}
            onChange={toggle}
            aria-label="Allow local agents"
            aria-describedby={descId}
          />
        </div>
      </div>
    </div>
  );
}
