# LittleTake MCP server

Lets any MCP agent (Claude Code, Claude Desktop, Codex, ...) direct a LittleTake project. The agent joins a project room as one more editor, so the scene changes in every browser page that has the project open, and those pages can undo the change like any other edit.

Edits use the same scene operations and validation as Muse (`src/scene-edit/operations.ts`). A batch applies completely or not at all.

## Tools

| Tool | What it does |
| --- | --- |
| `list_projects` | Projects saved on the server |
| `open_project` | Join a project by its code |
| `get_scene` | Objects, cameras, shots, base transforms and what is animated |
| `get_entity` | Full JSON of one object or camera, with asset joints and limits |
| `inspect_parts` | World position, forward and up of asset parts at a time, after joint animation (a dragon's mouth, a knight's hand) |
| `inspect_spatial` | Bounds, support, anchors and gaps, the measurements Muse uses |
| `check_visibility` | How much of an object or part a camera really sees at a time, counting occlusion by every other object |
| `operation_schema` | JSON Schema for chosen operation types |
| `apply_operations` | Apply operations and publish them to the room |

`check_visibility` and `inspect_parts` exist because an action only reads in the shot, and in any depth pass made from it, if the camera can see it. Example: a shield raised in front of a knight's chest is invisible from a camera behind him.

## Run

Start LittleTake (`npm run dev` or the production server), then point the MCP server at it:

```sh
LITTLETAKE_URL=http://127.0.0.1:4176 npm run mcp
```

`LITTLETAKE_PROJECT=<code>` opens a project on start. Otherwise the agent calls `open_project`.

Claude Code:

```sh
claude mcp add littletake --env LITTLETAKE_URL=http://127.0.0.1:4176 -- npx tsx server/mcp/server.ts
```

Claude Desktop (`claude_desktop_config.json`), with `cwd` set to this repository:

```json
{ "mcpServers": { "littletake": { "command": "npx", "args": ["tsx", "server/mcp/server.ts"], "cwd": "/path/to/littletake", "env": { "LITTLETAKE_URL": "http://127.0.0.1:4176" } } }
```

## Notes

- Pages show the agent's edits live when the server runs in cloud mode (`LITTLETAKE_MODE=cloud`, or `LITTLETAKE_PUBLIC_URL` set). In local mode the edits are saved to the project, and a page shows them after it reopens the project.
- The server keeps its edit session alive with a heartbeat every 30 s and releases it on exit.
- Rendering stills and video still happens in the browser.
