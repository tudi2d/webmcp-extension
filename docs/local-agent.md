# Local agents and your own API key

This fork adds two ways to use the extension. Both are off until you turn them
on in **Settings**, and neither needs a new dependency.

## Use it from a local agent (MCP)

Any MCP client that supports HTTP servers can use the WebMCP tools on your open
pages, and gets each tool's output back as the MCP reply.

1. Run `npm run build`, load `dist/` as an unpacked extension, and run
   `npm run server`. The server needs no model API key for this.
2. Open the side panel and turn on **Settings → Local agent → Allow local agents**.
   It says **Connected** once it has reached the server.
3. Choose **Copy MCP config** and add it to your agent. For Claude Code:

   ```bash
   claude mcp add --transport http webmcp http://localhost:3000/mcp \
     --header "Authorization: Bearer $WEBMCP_AUTH_TOKEN"
   ```

   The token is `WEBMCP_AUTH_TOKEN` in `.env`. It is built into the extension,
   so run `npm run build` again if it changes.

The agent gets three tools:

| Tool | What it does |
|---|---|
| `list_tabs` | Lists the open tabs. |
| `list_page_tools` | Lists a tab's WebMCP tools, with schemas and annotations. |
| `call_page_tool` | Runs a tool. Returns its result, then the tab it ended up on and the tools there. |

Calls show up in the tab's chat, marked ✓ or ✗.

> [!WARNING]
> Local agents run tools **with no permission prompt**, including tools the page
> marks as irreversible, like payments and deletions. Anything holding the token
> can do this while the switch is on and the panel is open. Closing the panel or
> turning off the switch cuts agents off at once.

- **The panel has to stay open.** Tools run in it, so this is also how you see
  what an agent is doing. With it closed, agents get an error saying so.
- **Everything from a page is fenced** in an `untrusted-…` tag, and the server
  tells agents to read it as data. This lowers the risk of prompt injection but
  cannot remove it, and a compromised agent has no prompt to stop it.
- **Results are limited** to 8,000 characters, as they are in chat.
- `/mcp` requires the token and refuses any request with an `Origin` header, so
  web pages cannot reach it.

## Use your own API key

Turn on **Settings → Model → Your API key**, then choose a provider or enter a
base URL, a model and a key. Chat goes straight from the browser to any
OpenAI-compatible API, so no server is needed. Local runtimes such as Ollama
work too, and take no key.

Permission prompts apply to these chats as usual. The key is stored unencrypted
in this browser profile's extension storage, so use a key with a spending limit.
It is never synced and never sent to the local server.

## Keeping up with upstream

This code lives in `extension/sidepanel/connect/`, `server/mcp.ts` and their
tests. Upstream files only hold small hooks, so rebasing should stay simple:

```bash
git fetch upstream && git rebase upstream/main && npm test
```

The hooks are in `App.tsx`, `index.tsx`, `SettingsScreen.tsx`, `chatBridge.ts`,
`backendBridge.ts`, `server.ts` and `tests/smoke/smokeServer.ts`.
