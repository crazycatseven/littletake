// LittleTake MCP server: lets any MCP agent (Claude Code, Claude Desktop, Codex...) edit a LittleTake project live.
// Run: LITTLETAKE_URL=http://127.0.0.1:4176 npx tsx server/mcp/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { LittleTakeRoom } from './room.ts';
import { INSTRUCTIONS, littleTakeTools } from './tools.ts';

export function createLittleTakeMcpServer(room: LittleTakeRoom) {
  const tools = littleTakeTools(room), byName = new Map(tools.map(tool => [tool.name, tool]));
  const server = new Server({ name: 'littletake', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = byName.get(request.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text' as const, text: `Unknown tool ${request.params.name}.` }] };
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await tool.run(request.params.arguments ?? {})) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message || 'The tool failed.' }] };
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const room = new LittleTakeRoom(process.env.LITTLETAKE_URL || 'http://127.0.0.1:4176');
  const server = createLittleTakeMcpServer(room);
  if (process.env.LITTLETAKE_PROJECT) await room.open(process.env.LITTLETAKE_PROJECT);
  const stop = async () => { await room.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await server.connect(new StdioServerTransport());
}
