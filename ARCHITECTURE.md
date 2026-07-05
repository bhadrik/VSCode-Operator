# VSCode Operator Architecture

This document summarizes the current architecture and implementation details for maintainers and AI contributors.

## Project Scope

VSCode Operator is a VS Code extension that exposes editor and debugger capabilities through `vscode.lm.registerTool`.

The extension also hosts a local MCP server stack in-process:

- `McpProxyServer` routes requests across workspaces
- `LmToolsMcpBridgeServer` exposes a supported external MCP catalog of policy-enforced read-only workspace tools plus reviewed token-free LM proxy tools

This is not a sidecar process. All tool execution stays in the Extension Host so tools can read live VS Code state.

## Repository Layout

```text
src/
   extension.ts            # activation and tool registration
   features/
      commandTool.ts        # editor/context command tools
      problemsTool.ts       # diagnostics tool (severity/path filtering)
      debugTool.ts          # debugger control + inspection tools
      index.ts              # feature exports
   mcp/
      proxyServer.ts        # fixed-port proxy (19191 by default)
      bridgeServer.ts       # workspace-local MCP bridge (port+1, port+2...)
      external/             # explicit external MCP catalog and native handlers
   security/
      accessPolicy.ts       # protected-path policy loading/evaluation
      pathGuard.ts          # operation/path authorization
      workspaceResolver.ts  # workspace root resolution and canonical helpers
   ui/
      accessPolicyCommands.ts # local policy commands and Explorer actions
package.json              # contributes.languageModelTools + config/commands
README.md                 # user-facing docs
```

## Tool Surface

### Core editor tools

- `vscodeOperator_readProblems`
- `vscodeOperator_activeEditorSummary`
- `vscodeOperator_hoverTopVisible`
- `vscodeOperator_hoverAtPosition`
- `vscodeOperator_completionAt`
- `vscodeOperator_executeCommand`

### Debugger tools

- `vscodeOperator_debugStart`
- `vscodeOperator_debugSetBreakpoints`
- `vscodeOperator_debugClearBreakpoints`
- `vscodeOperator_debugControl`
- `vscodeOperator_debugGetThreads`
- `vscodeOperator_debugGetTopFrame`
- `vscodeOperator_debugGetStackTrace`
- `vscodeOperator_debugGetScopes`
- `vscodeOperator_debugGetVariables`
- `vscodeOperator_debugEvaluate`
- `vscodeOperator_debugSnapshot`
- `vscodeOperator_debugStatus`

## Diagnostics Tool Notes

`vscodeOperator_readProblems` supports:

- `minSeverity` (default `warning`, meaning warning + error)
- `pathGlob` filter with glob syntax
- absolute and workspace-relative globs
- comma-separated string patterns and string-array patterns
- exclusion patterns prefixed with `!`

## Debugger Tool Design

Implementation file: `src/features/debugTool.ts`

Key decisions:

- Use stable `vscode.debug` APIs plus DAP `customRequest(...)` for `threads/stackTrace/scopes/variables/evaluate`
- Do not rely on `vscode.debug.sessions` (not present in current type definitions)
- Maintain a session registry via:
   - `vscode.debug.onDidStartDebugSession`
   - `vscode.debug.onDidTerminateDebugSession`
   - fallback to `vscode.debug.activeDebugSession`

### Debug session hygiene

- Before starting a new debug session, check whether an earlier session is still active.
- For the second and later launches, stop the previous session by default unless the caller explicitly wants to reuse it.
- If previous debug findings may have been misapplied, treat the old session as untrusted: stop it first, then restart cleanly.
- After the debugging task is complete, stop the session if it is no longer needed. This prevents stale state from contaminating later requests.

## Low-Roundtrip Strategy

To reduce AI request count during paused debugging, prefer:

1. `vscodeOperator_debugSnapshot`
2. then optional targeted follow-ups (`debugControl`, `debugEvaluate`)
3. when a fresh run is required, stop any stale prior session before calling `debugStart`

`debugSnapshot` packs into one call:

- top frame
- selected scopes
- variables per scope (bounded by input limits)
- optional batch expression evaluation

This replaces typical multi-call chains (`threads -> stackTrace -> scopes -> variables -> evaluate`).

Recommended session lifecycle:

1. `debugStatus` or `debugSnapshot` to inspect current state
2. `debugControl` with `action="stop"` if an old session should not be reused
3. `debugStart` for a fresh run
4. `debugSnapshot` for compact paused-state inspection
5. `debugEvaluate` or `debugControl` only when targeted follow-up is needed
6. `debugControl` with `action="stop"` after the investigation finishes

## MCP Architecture

### Proxy (`src/mcp/proxyServer.ts`)

- Binds to `127.0.0.1:<port>` (default `19191`)
- Receives bridge registrations via `/bridge-channel`
- Routes `/mcp` requests by session, `workspacePath`, or fallback strategy
- Exposes health endpoint `/health`

### Bridge (`src/mcp/bridgeServer.ts`)

- Each VS Code window starts a bridge on an auto-selected port (`port+1` and up)
- Registers itself to proxy through a persistent SSE channel
- Exposes MCP at configured path (default `/mcp`)
- Exposes native external MCP tools before any reviewed VS Code LM proxy tools
- The reviewed LM allowlist includes only token-free read/inspection tools and excludes terminal/process execution, generic command execution, debug launch/control, breakpoint mutation, and expression evaluation

### External MCP tool contract

- Native external tools are read-only workspace operations: status, list, stat, read, text search, diagnostics, open-document listing, and symbols.
- Native workspace tools validate `workspacePath` against open workspace folders, reject path traversal and symlink escapes, enforce output/size limits, and apply `.vscode/vscode-operator.access.json`.
- Denied paths are hidden from listing/search/status outputs and blocked from read/stat/symbol/diagnostic tools.
- Read-only policy paths permit read-like operations and reject future mutation tools.
- The LM proxy only advertises and invokes explicitly allowlisted token-free tools.
- Token-gated or high-risk LM tools such as `vscodeOperator_executeCommand`, debug start/control/breakpoint mutation, and debug expression evaluation are intentionally unavailable to external MCP clients.
- External `vscodeOperator_debugSnapshot` removes expression-evaluation inputs from both the advertised schema and the invocation payload.

### Why HTTP bridge

- Extension Host is not launched as a stdio MCP server process
- Local HTTP keeps integration simple for external MCP clients
- Still runs in-process for direct access to VS Code APIs

## Configuration and Commands

Settings:

- `vscodeOperator.mcpBridge.enabled`
- `vscodeOperator.mcpBridge.host`
- `vscodeOperator.mcpBridge.port`
- `vscodeOperator.mcpBridge.path`
- `vscodeOperator.externalMcp.enabled`
- `vscodeOperator.externalMcp.policyFile`
- `vscodeOperator.externalMcp.commandMode`
- `vscodeOperator.externalMcp.requireWorkspaceTrust`
- `vscodeOperator.externalMcp.maxReadBytes`
- `vscodeOperator.externalMcp.maxSearchResults`
- `vscodeOperator.externalMcp.maxCommandOutputBytes`
- `vscodeOperator.externalMcp.maxCommandRuntimeMs`

Commands:

- `vscodeOperator.mcpBridge.showStatus`
- `vscodeOperator.mcpBridge.restart`
- `vscodeOperator.externalMcp.openAccessPolicy`
- `vscodeOperator.externalMcp.protectSelectedExplorerItem`
- `vscodeOperator.externalMcp.removeProtectionFromSelectedExplorerItem`
- `vscodeOperator.externalMcp.showAccessStatus`
- `vscodeOperator.externalMcp.setCommandMode`

## Development

```bash
npm install
npm run compile
npm run watch
```

- Press `F5` to launch Extension Development Host
- Entry point is `src/extension.ts`
- Compiled output is `dist/`

## Known Pitfalls

- URI arguments may lose type over JSON boundaries; deserialize where needed
- `MarkdownString` hover content does not stringify directly; extract text explicitly
- JSON schema arrays in tool definitions must include `items`
- Use schema constants for MCP SDK v1 request handlers
- External MCP discovery and execution must agree; do not advertise LM tools unless they are verified as safe without a VS Code invocation token
- Do not add external write, Git mutation, debug launch/control, or command tools unless they call the shared path guard and respect protected paths end to end
