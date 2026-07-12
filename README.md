# VSCode Operator

A TypeScript VS Code extension that exposes native editor context as Language Model Tools, enabling Copilot Agent to autonomously operate VS Code (read diagnostics, query hover/LSP info, execute commands).

It also starts a local MCP bridge inside the Extension Host so external MCP clients can discover and call a supported external catalog of policy-enforced, read-only workspace tools plus a reviewed allowlist of token-free VS Code LM tools.

## Simple Intro (For Marketplace)

VSCode Operator connects AI assistants to real VS Code context.
It exposes diagnostics, hover/completion capabilities, command execution, and debugger control/introspection as VS Code Language Model Tools, and provides a built-in local MCP bridge for protected external read-only access to your live editor session.

> **For detailed architecture and design decisions, see [ARCHITECTURE.md](ARCHITECTURE.md).**

## Tools

### Core Editor Tools

| Tool | Reference name | Purpose |
|---|---|---|
| `vscodeOperator_readProblems` | `readProblems` | Read all diagnostics from the Problems panel |
| `vscodeOperator_activeEditorSummary` | `activeEditorSummary` | Get active editor file/language/cursor summary |
| `vscodeOperator_hoverTopVisible` | `hoverTopVisible` | Get hover info at top visible position |
| `vscodeOperator_hoverAtPosition` | `hoverAtPosition` | Get hover info at a specific line/column |
| `vscodeOperator_completionAt` | `completionAt` | Get completion candidates at a specific line/column |
| `vscodeOperator_executeCommand` | `executeCommand` | Execute any VS Code command by ID with automatic URI deserialization |

### File Editing Tools

| Tool | Reference name | Purpose |
|---|---|---|
| `vscodeOperator_readFile` | `readFile` | Read a file's text (live unsaved buffer if open), optional line range |
| `vscodeOperator_writeFile` | `writeFile` | Create or overwrite a file's full content |
| `vscodeOperator_applyTextEdits` | `applyTextEdits` | Apply precise line/column range edits through the editor edit API |
| `vscodeOperator_deleteFile` | `deleteFile` | Delete a file or directory (trash by default) |
| `vscodeOperator_createDirectory` | `createDirectory` | Create a directory and missing parents |
| `vscodeOperator_movePath` | `movePath` | Move or rename a file or directory |
| `vscodeOperator_saveDocument` | `saveDocument` | Save one open document |
| `vscodeOperator_saveAllDocuments` | `saveAllDocuments` | Save all open documents |

All file-editing tools are authorized through the same `.vscode/vscode-operator.access.json` policy as the external MCP workspace tools (see [Protected Paths](#protected-paths)): denied paths are rejected outright, and read-only paths reject any write/delete/move. `vscodeOperator_writeFile`, `vscodeOperator_applyTextEdits`, `vscodeOperator_deleteFile`, and `vscodeOperator_movePath` show VS Code's native confirmation dialog before running.

### Process Execution Tools

| Tool | Reference name | Purpose |
|---|---|---|
| `vscodeOperator_runCommand` | `runCommand` | Run an allowlisted executable (argument array, no shell) and wait for it to finish |
| `vscodeOperator_startBackgroundProcess` | `startBackgroundProcess` | Start a long-running process (dev server, `adb logcat`) and return immediately |
| `vscodeOperator_readProcessOutput` | `readProcessOutput` | Read buffered stdout/stderr from a background process |
| `vscodeOperator_stopProcess` | `stopProcess` | Stop a background process (SIGTERM, then SIGKILL) |
| `vscodeOperator_listProcesses` | `listProcesses` | List tracked background processes and their status |

`vscodeOperator_runCommand` and `vscodeOperator_startBackgroundProcess` are the general-purpose mechanism for Android and Node.js development: `npm`/`npx`/`vite`/`yarn`/`pnpm`/`node`/`tsc`/`eslint`, `git`, `adb`, and `gradlew`/`gradlew.bat` (pass `./gradlew` so it resolves against `cwd`). Arguments are always passed as an array and spawned without a shell, so there is no shell-interpolation risk. Only executables listed in `vscodeOperator.processTools.allowedExecutables` (configurable) can be launched, `cwd` is authorized against the same access policy as file tools (`commands.mode: "off"` in the policy file disables process execution entirely), output is capped per `vscodeOperator.processTools.maxOutputBytes`, and foreground commands are force-killed past `timeoutMs`/`vscodeOperator.processTools.maxTimeoutMs`. Background processes are tracked in memory and are always killed when the extension deactivates or reloads — call `vscodeOperator_stopProcess` when you're done with one rather than leaving it running.

All five process tools show VS Code's native confirmation dialog with the exact command line before running, except `readProcessOutput` and `listProcesses`, which are read-only.

### Native External MCP Workspace Tools

These tools are exposed through the local MCP bridge for external MCP clients. They do not route through `vscode.lm.invokeTool(...)`, so they do not require a VS Code internal invocation token.

| Tool | Purpose |
|---|---|
| `vscode_workspace_status` | Show workspace roots and non-sensitive access-policy status |
| `vscode_workspace_list_files` | List allowed files and folders under a selected workspace root |
| `vscode_workspace_stat` | Read metadata for an allowed file or folder |
| `vscode_workspace_read_file` | Read an allowed file with a size cap |
| `vscode_workspace_search_text` | Search allowed text files for a literal string with bounded results |
| `vscode_workspace_read_problems` | Read diagnostics for allowed files only |
| `vscode_editor_list_open_documents` | List open documents that are allowed by policy |
| `vscode_workspace_get_symbols` | Read symbols from an allowed file |

External MCP intentionally does not expose terminal/process execution, `vscodeOperator_executeCommand`, debug session start/control/mutation tools, or expression evaluation. Those capabilities remain available only through VS Code's internal Language Model Tool invocation path where VS Code can enforce its own approval and invocation-context checks.

### Allowlisted External MCP LM Tools

The external MCP bridge does not advertise every discovered `vscode.lm.tools` entry. It only proxies reviewed token-free tools such as diagnostics, active-editor summaries, hover/completion, and read-only debug inspection. Token-gated or high-risk tools such as `run_in_terminal`, `vscodeOperator_executeCommand`, `vscodeOperator_debugStart`, `vscodeOperator_debugControl`, and `vscodeOperator_debugEvaluate` are hidden from `tools/list` and return an explicit unsupported-tool error if called directly. For external MCP, `vscodeOperator_debugSnapshot` omits expression-evaluation inputs even though the internal VS Code LM tool supports them.

### Protected Paths

External MCP access is controlled by a workspace-local policy file:

```text
.vscode/vscode-operator.access.json
```

The policy file itself is always hidden and blocked from external MCP. Users can edit it directly or use:

- `VSCode Operator: Open External MCP Access Policy`
- `VSCode Operator: Protect from External MCP`
- `VSCode Operator: Remove External MCP Protection`
- `VSCode Operator: Show External MCP Access Status`
- `VSCode Operator: Set External MCP Command Mode`

Supported policy fields in this milestone are `defaultAccess`, `deny`, `readOnly`, and `commands.mode`. Denied paths are omitted from listing/search results and rejected by read/stat/symbol/diagnostic tools. Read-only paths permit list/stat/read/search and reject future mutation tools.

### Debugger Tools (AI Can Operate Debugger)

| Tool | Reference name | Purpose |
|---|---|---|
| `vscodeOperator_debugStart` | `debugStart` | Start debug session by launch config name or inline configuration |
| `vscodeOperator_debugSetBreakpoints` | `debugSetBreakpoints` | Set source breakpoints by file + line numbers |
| `vscodeOperator_debugClearBreakpoints` | `debugClearBreakpoints` | Clear breakpoints globally or by file |
| `vscodeOperator_debugControl` | `debugControl` | Continue, pause, step over/into/out, restart, or stop |
| `vscodeOperator_debugGetThreads` | `debugGetThreads` | Get DAP thread list |
| `vscodeOperator_debugGetTopFrame` | `debugGetTopFrame` | Get current top stack frame quickly |
| `vscodeOperator_debugGetStackTrace` | `debugGetStackTrace` | Get stack trace for a thread |
| `vscodeOperator_debugGetScopes` | `debugGetScopes` | Get scopes by frame id |
| `vscodeOperator_debugGetVariables` | `debugGetVariables` | Get variables by `variablesReference` |
| `vscodeOperator_debugEvaluate` | `debugEvaluate` | Evaluate expression in debug context |
| `vscodeOperator_debugSnapshot` | `debugSnapshot` | One-shot snapshot: top frame + scopes + variables + optional evaluate |
| `vscodeOperator_debugStatus` | `debugStatus` | Snapshot of active sessions, breakpoints, and thread preview |

### Recommended Low-Roundtrip Debug Flow

When you want AI to inspect paused state with fewer MCP calls, use:

1. `vscodeOperator_debugSnapshot` first (single-call context capture)
2. `vscodeOperator_debugControl` only when you need to continue/step/pause
3. `vscodeOperator_debugEvaluate` for targeted follow-up expressions
4. Before starting a new debug run, always stop any stale prior session unless you intentionally want to reuse it

Example snapshot call:

```json
{
  "maxScopes": 4,
  "maxVariablesPerScope": 80,
  "evaluateExpressions": ["this", "req", "res.statusCode"],
  "evaluateContext": "watch"
}
```

### Agent Prompt Templates (Debugger)

Use the following prompt templates to make AI prefer fewer roundtrips.

Minimal snapshot-first template:

```text
Use VSCode Operator debugger tools.
1) Call vscodeOperator_debugSnapshot first.
2) Summarize current paused state from topFrame/scopes/variables.
3) Only if needed, call vscodeOperator_debugControl or vscodeOperator_debugEvaluate.
4) Before starting a new debug session, stop any previous session unless it is clearly the one you should keep using.
5) After finishing the investigation, stop the debug session if it is no longer needed.
Avoid unnecessary extra tool calls.
```

Snapshot + targeted evaluate template:

```text
Use vscodeOperator_debugSnapshot with:
- maxScopes=4
- maxVariablesPerScope=80
- evaluateExpressions=["this", "req", "res.statusCode"]

Then:
1) Explain the current execution location and likely root cause.
2) If one key value is still missing, do one vscodeOperator_debugEvaluate call only.
3) Propose the next debugging action (continue/stepOver/stepInto) with reason.
4) If a fresh run is needed, stop the previous debug session before starting the next one.
5) If the old session may have been misused, do not trust it; stop it first and restart cleanly.
```

### Debug Session Hygiene

To avoid AI accidentally reusing stale debugger state:

1. Before the second and later debug launches, stop the previous session unless you explicitly want to continue it.
2. If previous debug results may have been misapplied, stop the old session before doing any new inspection.
3. After a debugging task is complete, stop the session to avoid contaminating the next task.
4. Treat "stop old session before new debugStart" as the default safe policy.

## MCP Bridge

### Architecture

VSCode Operator uses a **proxy + bridge architecture** to support multiple VS Code workspaces simultaneously:

- **Proxy Server**: Listens on fixed port `19191`, routes MCP requests to appropriate workspace bridges based on `workspacePath` parameter
- **Bridge Server**: Each VS Code instance runs its own bridge (auto-assigned port 19192+), exposes the supported policy-enforced external MCP catalog, and registers with the proxy

### Endpoints & Configuration

- **Proxy endpoint**: `http://127.0.0.1:19191/mcp` (stable, connect here)
- **Bridge registers at**: Each bridge auto-discovers an available port and registers with the proxy
- **Health check**: `http://127.0.0.1:19191/health`
- **Commands**: `VSCode Operator: Show MCP Bridge Status`, `VSCode Operator: Restart MCP Bridge`
- **Settings**: `vscodeOperator.mcpBridge.*`, `vscodeOperator.externalMcp.*`

For confidential workspaces, keep `vscodeOperator.mcpBridge.host` on `127.0.0.1`, keep `vscodeOperator.mcpBridge.allowRemoteConnections` disabled, and leave `vscodeOperator.mcpBridge.logPayloadPreview` disabled. Payload preview logging is off by default so MCP request arguments and tool response bodies are not copied into the VS Code Output channel. Non-loopback binding and payload preview logging require explicit User-level settings; workspace settings cannot enable them by themselves.

### Multi-Workspace Usage

When multiple VS Code instances are running:

1. Each runs its own MCP bridge server (auto-assigned port 19192+)
2. All bridges register with the central proxy on port 19191
3. MCP clients connect to the proxy endpoint: `http://127.0.0.1:19191/mcp`
4. Include `workspacePath` parameter in tool calls to route to correct bridge:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "vscodeOperator_hoverAtPosition",
    "arguments": {
      "workspacePath": "/absolute/path/to/projectA",
      "line": 10,
      "column": 5
    }
  }
}
```

### Customize Proxy Port

Default proxy port is `19191`. To change it:

```json
{
  "vscodeOperator.mcpBridge.port": 20191
}
```

Note: Only the **first instance** uses the configured port. Additional instances auto-increment (19192, 19193, etc.).

## Development

```bash
npm install
npm run compile   # tsc -p ./ → dist/
npm run watch     # incremental compile during development
```

Press **F5** to launch an Extension Development Host. Copilot Agent can then invoke registered tools automatically based on context (see `.github/copilot-instructions.md`).

The local MCP bridge starts automatically on activation unless `vscodeOperator.mcpBridge.enabled` is disabled.
