// Setup for the MCP clients the docs cover. ChatGPT, Claude and Grok Bot connect with OAuth (a connector or a
// custom MCP server, signing in to MailCheap); the others with a full access key, from MAILCHEAP_API_KEY in each case.
export const API_KEY_VARIABLE = "MAILCHEAP_API_KEY";

export function getMcpUrl(appUrl) {
	return `${appUrl}/mcp`;
}

export function getClaudeCodeCommand(appUrl) {
	return `claude mcp add --transport http --scope user mailcheap ${getMcpUrl(appUrl)} \\
  --header "Authorization: Bearer $${API_KEY_VARIABLE}"`;
}

export function getCodexConfig(appUrl) {
	return `[mcp_servers.mailcheap]
url = "${getMcpUrl(appUrl)}"
bearer_token_env_var = "${API_KEY_VARIABLE}"`;
}

export function getCodexCommand(appUrl) {
	return `codex mcp add mailcheap --url ${getMcpUrl(appUrl)} --bearer-token-env-var ${API_KEY_VARIABLE}`;
}

export function getCursorConfig(appUrl) {
	const config = { mcpServers: { mailcheap: { url: getMcpUrl(appUrl), headers: { Authorization: `Bearer \${env:${API_KEY_VARIABLE}}` } } } };
	return JSON.stringify(config, null, 2);
}

// Menu names as ChatGPT and Claude show them (OpenAI's and Anthropic's help pages, October 2026). Grok Bot adds
// the server when asked in a chat. A note is optional.
export function getMcpConnectors(appUrl) {
	const url = getMcpUrl(appUrl);
	return [
		{
			id: "chatgpt",
			name: "ChatGPT",
			steps: [
				"Go to Plugins (chatgpt.com/plugins), click + and pick Add custom MCP server.",
				`Name it MailCheap, enter ${url} as the server URL and pick OAuth, with no client ID or secret. If ChatGPT asks how to register, pick Client ID Metadata Document.`,
				"Check I understand and want to continue, then click Create as a plugin.",
				"Install the plugin, sign in to MailCheap when ChatGPT asks and click Allow.",
				"In a chat, type @ and pick MailCheap.",
			],
			note: "Custom MCP servers are on ChatGPT on the web, for Business, Enterprise and Edu workspaces: on Business, admins and owners add them; on Enterprise and Edu, so can the members an admin allows. On Pro, ChatGPT only uses the read-only tools for now.",
		},
		{
			id: "claude",
			name: "Claude",
			steps: [
				"Go to Customize › Connectors and click Add custom connector.",
				`Name it MailCheap and enter ${url}. If Claude asks how it identifies itself, keep Use Claude's published identity. Click Add.`,
				"Click Connect, sign in to MailCheap and click Allow.",
				"The connector works in claude.ai, Claude Desktop and the mobile apps. Turn it on or off in a chat from + › Connectors.",
			],
			note: "On Team and Enterprise plans, an owner adds it once in Organization settings › Connectors › Add › Custom › Web, then each member clicks Connect under Customize › Connectors. The Free plan has one custom connector.",
		},
		{
			id: "grok-bot",
			name: "Grok Bot",
			steps: [`In a chat, ask Grok Bot to add the custom MCP server ${url}.`, "Sign in to MailCheap when it asks, and click Allow."],
		},
	];
}

export function getMcpClients(appUrl) {
	return [
		{
			id: "claude-code",
			name: "Claude Code",
			file: "Terminal",
			code: getClaudeCodeCommand(appUrl),
			note: "The shell puts the key in Claude Code's settings when the command runs. --scope user makes the server available in every project; run /mcp in Claude Code to check it's connected.",
		},
		{
			id: "codex",
			name: "Codex",
			file: "~/.codex/config.toml",
			code: getCodexConfig(appUrl),
			note: `Codex reads the key from ${API_KEY_VARIABLE} each time it starts, so export it in your shell profile. The same server from the terminal: ${getCodexCommand(appUrl)}`,
		},
		{
			id: "cursor",
			name: "Cursor",
			file: "~/.cursor/mcp.json",
			code: getCursorConfig(appUrl),
			note: `Cursor reads ${API_KEY_VARIABLE} from the environment it was opened in. If it isn't set there, put the key itself after Bearer, and keep the file out of version control.`,
		},
	];
}
