import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const server = new McpServer({ name: "context-probe", version: "1" });
server.tool("inspect_context", "Integration fixture: report host-provided identity only.", {}, async (_args, extra) => ({ content: [{ type: "text", text: JSON.stringify({ meta: extra._meta, env: Object.fromEntries(["CODEX_THREAD_ID", "CODEX_WORKSPACE_ROOT", "PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "PWD", "ORCHESTRATOR_PROJECT_ROOT", "ORCHESTRATOR_GLOBAL_DB"].map(key => [key, process.env[key]])), cwd: process.cwd() }) }] }));
await server.connect(new StdioServerTransport());
