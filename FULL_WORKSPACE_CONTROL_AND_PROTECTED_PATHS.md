# Full External MCP Workspace Control with Protected Paths

**Repository:** `bhadrik/VSCode-Operator`  
**Status:** Proposed implementation specification  
**Audience:** maintainers implementing full external-MCP workspace access safely

---

## 1. Decision

Extend the existing VSCode Operator extension. Do **not** create a separate extension and do **not** try to fabricate VS Code/Copilot invocation tokens.

The extension already has:

- a local MCP proxy and per-workspace bridge;
- workspace registration and routing through `workspacePath`;
- direct VS Code editor, diagnostics, command, and debugger capabilities;
- a running Extension Host with access to the opened workspace.

The missing layer is a **native external-MCP workspace controller**. It must provide file, editor, process, and UI operations directly from the extension, with one policy engine enforcing user-defined protected paths.

The final guarantee is:

> The external assistant can list, open, read, create, edit, move, rename, delete, search, and run approved commands for every path inside an authorized VS Code workspace, except paths explicitly protected by the user. Protected paths are hidden from discovery and blocked from every supported operation.

“Full access” in this document means **full access to the user-authorized VS Code workspace(s)**. It must not silently become unrestricted access to the whole operating system, user home directory, browser credentials, or unrelated projects.

---

## 2. Current Repository Behavior

### What already works

The current source already implements workspace awareness.

| Area | Existing source | Current capability |
|---|---|---|
| Workspace registration | `src/mcp/bridgeServer.ts` | Reads `vscode.workspace.workspaceFolders`, records a root, starts one bridge per workspace |
| Multi-workspace routing | `src/mcp/proxyServer.ts` | Routes MCP requests using `workspacePath`; provides single-workspace fallback |
| Workspace-aware editor operations | `src/features/commandTool.ts` | Resolves file paths relative to `workspacePath` or the current workspace |
| Workspace-aware debug operations | `src/features/debugTool.ts` | Resolves workspaces and files for debug actions |
| Generic VS Code commands | `src/features/commandTool.ts` | Invokes `vscode.commands.executeCommand(...)` |
| Existing VS Code tools | `src/extension.ts` | Registers diagnostics, editor, command, and debugger tools |

### Why terminal calls fail

`src/mcp/bridgeServer.ts` currently exposes tools discovered from the VS Code Language Model Tool registry and forwards calls through:

```ts
await vscode.lm.invokeTool(invokeTarget.targetName, {
  toolInvocationToken: undefined,
  input: toolInput
});
```

Some tools are token-free and work. Other tools—especially internal terminal/process tools—require a VS Code-issued invocation token and reject the external bridge call.

This is **not** a missing workspace problem. The workspace is already known and routed correctly. It is a mismatch between:

- an external MCP client, which has ordinary MCP tool arguments; and
- an internal VS Code/Copilot tool, which requires private host invocation state.

### What must not be done

Do not:

- generate, reuse, fake, or bypass `toolInvocationToken`;
- expose every tool in `vscode.lm.tools` to external clients;
- promise that a raw host shell can respect protected paths without a sandbox;
- expose arbitrary VS Code commands in strict protected-path mode;
- let the external assistant read or modify the access-policy file that controls its own access.

---

## 3. Target Architecture

```text
External MCP client
    |
    v
MCP proxy on loopback
    |
    +--> route by workspacePath
             |
             v
VSCode Operator bridge in the target Extension Host
    |
    +--> External MCP Tool Registry (new)
    |      +--> Workspace file controller
    |      +--> Editor/UI controller
    |      +--> Search controller
    |      +--> Git/task/debug controller
    |      +--> Sandboxed command controller
    |      +--> Access-policy evaluator
    |
    +--> Explicit allowlist of existing safe LM tools (optional)
```

### Core rule

Every external operation must pass through one shared authorization function before touching a path, executing a command, or invoking a VS Code command.

```ts
authorize(operation, workspaceRoot, requestedPathOrTarget)
```

No external tool may access the filesystem, editor, terminal, command API, Git API, or debug API before policy evaluation.

---

## 4. Required Changes

### 4.1 Replace generic external LM-tool discovery

**Current behavior to remove from the external MCP surface**

- `ListToolsRequestSchema` returns a broad catalog based on discovered VS Code LM tools.
- `CallToolRequestSchema` accepts arbitrary discovered names and calls `vscode.lm.invokeTool(...)`.
- Token-gated tools such as terminal/process tools appear available but cannot run.

**Replacement**

Create an explicit external catalog. It must describe only tools that the extension can support from an external MCP client.

```text
src/mcp/external/
  externalToolRegistry.ts
  externalToolTypes.ts
  workspaceTools.ts
  editorTools.ts
  searchTools.ts
  commandTools.ts
  gitTools.ts
  accessTools.ts
```

In `src/mcp/bridgeServer.ts`:

1. Ask the external registry for tools in `tools/list`.
2. Dispatch external calls to native handlers first.
3. Only proxy an existing LM tool when it is on a reviewed allowlist.
4. Reject everything else with a clear, stable error.

```ts
const nativeResult = await externalToolRegistry.invoke({
  toolName,
  input,
  workspaceContext
});

if (nativeResult) {
  return nativeResult;
}

if (!EXTERNALLY_PROXYABLE_LM_TOOLS.has(invokeTarget.targetName)) {
  return unsupportedExternalToolResult(invokeTarget.targetName);
}

return vscode.lm.invokeTool(invokeTarget.targetName, {
  toolInvocationToken: undefined,
  input: toolInput
});
```

The allowlist is optional. The safe first release can expose only native external tools.

### 4.2 Keep existing workspace proxy and routing

Retain:

- `src/mcp/proxyServer.ts`
- bridge registration by workspace root
- `workspacePath` routing
- single-workspace fallback

For every workspace-specific tool:

- use `workspacePath` when supplied;
- require it if more than one workspace is registered;
- normalize before comparison;
- reject a path that does not match a registered, open workspace root.

### 4.3 Replace the external generic command executor

`vscodeOperator_executeCommand` is valuable for an internal agent but too broad for strict external mode. A generic VS Code command may invoke an extension that can read protected files, open the policy file, or write outside the intended target.

Keep the feature for internal VS Code/Copilot use if desired, but remove it from the strict external MCP catalog.

Replace it with:

- typed editor operations;
- typed workspace operations;
- a small reviewed UI-command allowlist;
- an explicit sandboxed command runner.

---

## 5. Protected-Path Policy

### 5.1 User-facing behavior

The user must be able to mark files or folders as unavailable to the external assistant.

Examples:

- `.env`
- `.env.production`
- `secrets/**`
- `private-notes/**`
- `clients/acme/credentials.json`
- `docs/legal/**`

When a path is protected, the external assistant must not be able to:

- list it or infer it from directory listings;
- search its name or contents;
- open it in VS Code;
- read, write, create, delete, rename, copy, move, or patch it;
- request metadata, hashes, diagnostics, Git diff, or symbols for it;
- reach it through a symlink;
- access it through a command-runner workspace;
- alter the policy that protects it.

### 5.2 Policy storage

Use a workspace-local policy file:

```text
.vscode/vscode-operator.access.json
```

The policy file itself is **always protected from external MCP operations**. The user edits it manually in VS Code, through a dedicated extension command, or with an Explorer context menu. The external assistant must never read, write, open, search, or reveal it.

Optionally mirror the effective policy in Extension `globalStorage` for audit/rollback, but do not depend on an assistant-controlled location for authorization.

### 5.3 Recommended policy file

```json
{
  "$schema": "vscode-operator://schemas/access-policy/v1",
  "version": 1,

  "defaultAccess": "allow",

  "deny": [
    ".env",
    ".env.*",
    "secrets/**",
    "private/**",
    "clients/acme/credentials.json",
    "docs/legal/**"
  ],

  "readOnly": [
    "infra/production/**"
  ],

  "commands": {
    "mode": "sandboxed",
    "network": false,
    "applyChanges": "review",
    "maxRuntimeMs": 60000,
    "maxOutputBytes": 1048576
  }
}
```

### 5.4 Rule precedence

Evaluate rules in exactly this order:

1. **Intrinsic deny**  
   The policy file, its backups, extension authorization state, and any configured internal-secret locations are never externally accessible.

2. **Deny rules**  
   A matching `deny` pattern rejects every operation.

3. **Read-only rules**  
   A matching `readOnly` pattern permits metadata/list/read/search but rejects any mutation.

4. **Default access**  
   `defaultAccess: "allow"` permits remaining paths. `defaultAccess: "deny"` requires a separate reviewed allow rule if a future version adds allowlists.

5. **Operation-level policy**  
   Global limits may still block an otherwise allowed path, for example when command execution is disabled.

A deny always wins. Do not implement negative glob rules such as `!private/public.txt` in the first version; they complicate review and can accidentally weaken protection.

### 5.5 Pattern rules

- Patterns are workspace-root relative and use normalized `/` separators.
- Reject absolute patterns, `..`, and malformed globs.
- `folder/**` protects the folder and all descendants.
- Exact file patterns protect only that file.
- Denied files must be omitted from results, not merely marked “denied,” unless the user opts into verbose auditing.
- Do not reveal protected paths in tool errors.

### 5.6 User controls in VS Code

Add extension commands:

```text
VSCode Operator: Open External MCP Access Policy
VSCode Operator: Protect Selected Explorer Item
VSCode Operator: Remove Protection from Selected Explorer Item
VSCode Operator: Show External MCP Access Status
VSCode Operator: Set External MCP Command Mode
```

Add an Explorer context-menu action:

```text
Protect from External MCP
```

The status UI should show:

- policy loaded or invalid;
- number of denied/read-only rules;
- command mode;
- workspace trust status;
- last policy reload time.

It must not expose protected filenames to an external MCP caller.

---

## 6. Path Authorization Engine

Create:

```text
src/security/accessPolicy.ts
src/security/pathGuard.ts
src/security/workspaceResolver.ts
```

### Required API

```ts
type AccessOperation =
  | "list"
  | "stat"
  | "read"
  | "search"
  | "open"
  | "write"
  | "create"
  | "delete"
  | "rename"
  | "copy"
  | "patch"
  | "command-input"
  | "command-output"
  | "git"
  | "ui-command";

type AccessDecision =
  | { allowed: true; canonicalPath: string; relativePath: string }
  | { allowed: false; reason: "outside-workspace" | "protected" | "read-only" | "invalid-path" };
```

### Required checks

For every file or directory target:

1. Resolve the selected workspace root.
2. Resolve the requested relative path against that root.
3. Canonicalize existing path segments using `realpath`.
4. For new paths, canonicalize the closest existing parent.
5. Confirm the canonical target remains inside the canonical workspace root.
6. Convert to a normalized workspace-relative path.
7. Apply intrinsic deny, deny, read-only, and operation policies.
8. Apply the same check to both source and destination for move/copy/rename.
9. Re-check immediately before mutation to reduce time-of-check/time-of-use races.

### Symlink rule

A symlink that resolves outside the workspace is always denied.

A symlink that resolves inside the workspace still receives policy evaluation against its canonical target. This prevents a link such as `public/link-to-secrets` from bypassing `secrets/**`.

### Directory listing rule

When listing a directory:

- silently exclude denied descendants;
- do not disclose denied names, counts, byte sizes, timestamps, or errors;
- ensure recursive search and glob expansion use the same filter.

---

## 7. Native External MCP Tool Catalog

All tools below must enforce workspace selection and path policy.

### 7.1 Workspace and file tools

| Tool | Purpose | Required controls |
|---|---|---|
| `vscode_workspace_status` | Show available workspace roots and non-sensitive access status | No protected-path names |
| `vscode_workspace_list_files` | List allowed files/folders | Denied descendants filtered |
| `vscode_workspace_stat` | Allowed file metadata | Deny/read-only enforcement |
| `vscode_workspace_read_file` | Read text or bytes | Size limit; `utf8` or `base64` encoding |
| `vscode_workspace_write_file` | Overwrite/create an allowed file | Read-only/deny checks; expected hash/version |
| `vscode_workspace_apply_patch` | Apply a unified diff or structured edit | Check every target; preimage hash |
| `vscode_workspace_create` | Create file/folder | Canonical parent check |
| `vscode_workspace_delete` | Delete allowed file/folder | Explicit recursive flag; audit entry |
| `vscode_workspace_move` | Move/rename | Validate source and destination |
| `vscode_workspace_copy` | Copy allowed content | Validate source and destination |
| `vscode_workspace_search_text` | Search allowed text files | Ignore denied paths and binary files by default |

### 7.2 Editor and UI tools

| Tool | Purpose | Required controls |
|---|---|---|
| `vscode_editor_list_open_documents` | List allowed open documents | Filter protected documents |
| `vscode_editor_get_active_context` | Active file, selection, cursor, language | Return nothing if active file is protected |
| `vscode_editor_open_file` | Open and reveal an allowed file | Reject protected target |
| `vscode_editor_apply_text_edits` | Edit an open/closed allowed file through VS Code | Version check + write policy |
| `vscode_editor_save_file` | Save allowed file | Write policy |
| `vscode_editor_close_file` | Close allowed document | Path policy |
| `vscode_workspace_read_problems` | Problems in allowed files | Filter diagnostics in protected paths |
| `vscode_workspace_get_symbols` | Symbols in allowed files | Path policy |

### 7.3 Git and task tools

Expose typed APIs instead of direct `.git` manipulation.

| Tool | Purpose | Required controls |
|---|---|---|
| `vscode_git_status` | Status excluding protected paths | Filter every returned path |
| `vscode_git_diff` | Diff for explicitly allowed files | Never include protected content |
| `vscode_git_stage` | Stage allowed paths | Policy-check each path |
| `vscode_task_list` | List trusted workspace tasks | Workspace trust required |
| `vscode_task_run` | Run selected task | Use sandbox/command policy when feasible |

### 7.4 Command tools

| Tool | Purpose | Required controls |
|---|---|---|
| `vscode_workspace_run_command` | Run a structured command in an isolated workspace view | Sandbox; no raw host shell |
| `vscode_workspace_get_command_output` | Fetch bounded stdout/stderr | Execution-ID access |
| `vscode_workspace_list_command_changes` | Inspect changes made in sandbox | Filter policy |
| `vscode_workspace_apply_command_changes` | Apply allowed sandbox changes to real workspace | Re-check every output path |

---

## 8. The Terminal Problem: Privacy and Arbitrary Commands

This is the most important security constraint:

> A raw terminal process running as the same OS user can read any file that the OS user can read. Therefore a protected-path policy is not real if the external assistant can run arbitrary host commands directly.

For example, a shell command could bypass file-tool checks with:

```text
cat .env
find . -type f
python -c "..."
git show HEAD:secrets/token.txt
```

No argument parser can reliably prove that an arbitrary shell command will not touch a protected path.

### Required command modes

```text
off        No external command execution.
sandboxed  Commands run in a sanitized workspace view. Required for protected-path guarantees.
trusted    Direct host command execution. Only permitted when there are no protected paths and the user explicitly opts in.
```

**Do not permit `trusted` mode while any deny/read-only rule exists.** Otherwise the extension would falsely claim that protected files are inaccessible.

### Recommended first implementation: sanitized workspace view

For `sandboxed` mode:

1. Create a temporary work directory owned by the extension.
2. Materialize only allowed workspace content into that directory.
3. Omit all denied paths and the policy file.
4. Do not copy user secrets, global configuration, credentials, browser data, or unrelated home directories.
5. Run the command with CWD inside the sanitized root.
6. Provide a minimal environment allowlist.
7. Disable network by default where platform support exists.
8. Capture bounded output, exit code, and a change manifest.
9. Compare the sanitized work tree with its initial state.
10. Apply only allowed changes back through the policy-enforced workspace file APIs.

The command can read/write files available in the sanitized view. It cannot access hidden paths because they are not present.

### Important implementation notes

- Do not use hard links for files that may be modified; a write could affect the original workspace.
- Prefer copy-on-write/reflinks where available, otherwise normal copies.
- Exclude `.git` from the first sandboxed implementation unless a separate sanitized Git strategy is built.
- Use a toolchain allowlist or controlled PATH.
- Expose command as executable plus arguments, not an arbitrary shell string.

Recommended input:

```json
{
  "workspacePath": "/absolute/path/to/project",
  "command": "npm",
  "args": ["test"],
  "cwd": ".",
  "timeoutMs": 60000
}
```

Avoid raw shell input:

```json
{
  "command": "npm test && cat .env"
}
```

### Network and environment policy

Network-enabled commands can exfiltrate any allowed workspace data. Keep network disabled by default in sandboxed mode.

Pass only an environment allowlist, for example:

```text
PATH
HOME=<temporary sandbox home>
TMPDIR=<sandbox temp>
LANG
LC_*
NODE_OPTIONS only when explicitly configured
```

Do not pass:

```text
API keys
cloud credentials
SSH_AUTH_SOCK
GITHUB_TOKEN
AWS_*
OPENAI_*
browser session data
user shell history paths
```

### Optional later optimization

A platform-specific sandbox may be faster than copying:

- Linux: bubblewrap or a container namespace with a sanitized mount view.
- macOS: container-based isolation.
- Windows: container/WSL/Windows Sandbox backend.

The cross-platform first release should use a materialized sanitized worktree because it is easier to reason about and test.

---

## 9. Workspace Trust and Bridge Security

### Workspace trust

Do not enable write, command, task, Git mutation, or debug-launch tools unless:

```ts
vscode.workspace.isTrusted === true
```

In untrusted workspaces, expose only narrow, read-only metadata where appropriate.

### MCP transport

The bridge must remain loopback-only by default:

```text
127.0.0.1
```

If remote binding is ever supported, require:

- authentication token stored in VS Code `SecretStorage`;
- TLS termination;
- explicit user opt-in;
- audit logging;
- no command execution by default.

### Audit log

Add a local audit log that records:

- timestamp;
- workspace ID;
- MCP tool name;
- allowed/denied result;
- target path only when safe for the local user;
- command executable and arguments;
- exit code and duration;
- change-application result.

Do not expose audit logs to the external assistant by default. The user can inspect them through VS Code.

---

## 10. Recommended Source Layout

```text
src/
  extension.ts
  mcp/
    bridgeServer.ts
    proxyServer.ts
    external/
      externalToolRegistry.ts
      externalToolTypes.ts
      workspaceTools.ts
      editorTools.ts
      searchTools.ts
      commandTools.ts
      gitTools.ts
      accessTools.ts
  security/
    accessPolicy.ts
    pathGuard.ts
    workspaceResolver.ts
    sandboxRunner.ts
    commandPolicy.ts
    auditLog.ts
  ui/
    accessPolicyCommands.ts
    explorerProtectionMenu.ts
```

### Responsibilities

| Module | Responsibility |
|---|---|
| `accessPolicy.ts` | Load, validate, watch, and evaluate policy |
| `pathGuard.ts` | Canonical path and symlink-safe authorization |
| `workspaceResolver.ts` | Resolve and validate `workspacePath` |
| `externalToolRegistry.ts` | Explicit MCP tool list + dispatch |
| `workspaceTools.ts` | Filesystem CRUD and patch operations |
| `editorTools.ts` | Editor/open-document/context operations |
| `commandTools.ts` | Structured command tool protocol |
| `sandboxRunner.ts` | Sanitized worktree creation and command lifecycle |
| `auditLog.ts` | Local append-only audit records |
| `accessPolicyCommands.ts` | Local VS Code user controls |

---

## 11. Changes by Existing File

### `src/mcp/bridgeServer.ts`

**Keep**

- HTTP bridge lifecycle;
- multi-workspace registration;
- proxy communication;
- resource endpoints;
- `workspacePath` routing behavior.

**Change**

- Replace broad `getExposedTools()` behavior with `externalToolRegistry.listTools(...)`.
- In `CallToolRequestSchema`, dispatch only explicit external tools and optional reviewed LM allowlist.
- Remove arbitrary discovery-to-invocation forwarding as the external default.
- Return useful error messages for tools unavailable to external MCP clients.

### `src/extension.ts`

**Add**

- creation/disposal of access-policy service;
- creation/disposal of external registry;
- policy reload watcher;
- UI commands and Explorer menu registrations;
- workspace trust state handling.

**Keep**

- existing diagnostic/editor/debug registration for internal VS Code use;
- bridge/proxy startup order.

### `src/features/commandTool.ts`

**Keep/reuse selectively**

- existing workspace resolution concepts;
- typed hover/completion/editor operations.

**Remove from strict external catalog**

- generic arbitrary `executeCommand` exposure.

### `src/features/debugTool.ts`

**Keep/reuse**

- workspace and file resolution helpers;
- debug controls.

**Add**

- path guard before file-specific debug operations;
- policy filtering for stack frame, source path, and variables that point to protected files.

### `package.json`

Add extension settings:

```json
{
  "vscodeOperator.externalMcp.enabled": true,
  "vscodeOperator.externalMcp.policyFile": ".vscode/vscode-operator.access.json",
  "vscodeOperator.externalMcp.commandMode": "sandboxed",
  "vscodeOperator.externalMcp.requireWorkspaceTrust": true,
  "vscodeOperator.externalMcp.maxReadBytes": 5242880,
  "vscodeOperator.externalMcp.maxSearchResults": 500,
  "vscodeOperator.externalMcp.maxCommandOutputBytes": 1048576,
  "vscodeOperator.externalMcp.maxCommandRuntimeMs": 60000
}
```

The policy file location setting must not allow the external MCP agent to move the policy outside the workspace or replace it.

---

## 12. Implementation Sequence

### Phase 1 — Correct the external catalog

1. Build `externalToolRegistry`.
2. Replace generic external LM-tool enumeration.
3. Hide token-gated tools such as generic terminal/process tools.
4. Return an explicit “not available through external MCP” error for blocked names.
5. Add a tool describing current workspace roots and policy status.

**Success condition:** `tools/list` advertises only tools that can actually run externally.

### Phase 2 — Read-only workspace control

1. Implement access-policy loader and validation.
2. Implement canonical path guard.
3. Implement list, stat, read, and search tools.
4. Filter Problems, symbols, and open documents.
5. Add local policy-editing commands and Explorer protection action.

**Success condition:** the agent can inspect every allowed path but cannot discover or read protected paths.

### Phase 3 — Write and editor control

1. Implement create, write, patch, delete, move, copy, rename.
2. Add expected-version/preimage checks.
3. Implement editor open, apply edits, save, and close.
4. Add audit log for every mutation.

**Success condition:** the agent can fully edit allowed workspace files while protected and read-only files remain unaffected.

### Phase 4 — Sandboxed process execution

1. Build sanitized-worktree materialization.
2. Add structured command runner with bounded output/timeout.
3. Capture changes and expose change summary.
4. Re-check each changed path before apply-back.
5. Add local command-mode UI.

**Success condition:** build/test commands work on the allowed workspace view and cannot read or modify protected files.

### Phase 5 — Git, tasks, and advanced VS Code controls

1. Add policy-aware Git status/diff/stage tools.
2. Add task/debug integration.
3. Add reviewed UI command allowlist.
4. Consider platform-specific sandbox performance backends.

---

## 13. Test Plan

The repository currently needs automated test coverage for this feature. Add unit and integration tests before enabling write or command operations by default.

### Unit tests

- Policy file validation.
- Intrinsic deny always wins.
- Deny overrides read-only/default access.
- Read-only permits read but rejects all mutations.
- Invalid globs and traversal paths reject.
- Paths outside workspace reject.
- Existing symlink escape rejects.
- New-file parent symlink escape rejects.
- Directory listing/search filters denied descendants.
- Move/copy validates both source and destination.
- Policy file is never externally readable/writable.
- Tool catalog excludes generic token-gated tools.

### Integration tests

Run against the local MCP bridge with two workspaces.

| Scenario | Expected result |
|---|---|
| `tools/list` | Shows explicit native catalog only |
| List workspace | Allowed files visible; denied files absent |
| Read denied file | Generic access-denied result; no content |
| Search workspace | No protected filename/content appears |
| Write allowed file | Success with audit record |
| Write read-only file | Rejected |
| Rename into denied folder | Rejected |
| Follow symlink to denied/outside file | Rejected |
| Open protected editor document | Rejected |
| Sandboxed command `find .` | Protected paths absent |
| Sandboxed command attempts protected path | Path missing/blocked; no real workspace leak |
| Command diff touches denied file | Never applied |
| Multiple workspaces | Tool requires/obeys correct `workspacePath` |

### Manual acceptance criteria

1. The user protects `.env` and `secrets/**`.
2. External MCP `list_files` does not show them.
3. External MCP `search_text` cannot find either file name or contents.
4. External MCP cannot read, open, modify, rename, delete, or stage them.
5. A sandboxed test command cannot see them.
6. All other workspace files remain fully usable.
7. The user can remove a rule locally and the change takes effect without restarting VS Code.
8. The external assistant cannot edit the policy file to remove protection.

---

## 14. Product Contract

Expose the following behavior to users:

```text
VSCode Operator grants an external MCP client full control over files and VS Code features inside the workspace you authorize. You can protect selected paths from that client. Protected paths are hidden and blocked from file, editor, search, Git, and sandboxed command operations.
```

Do **not** claim protected paths are safe if the user enables direct host command execution or exposes arbitrary VS Code commands. In that configuration, the protection boundary is no longer enforceable.

---

## 15. Final Recommendation

Implement this in the existing `VSCode-Operator` extension.

The smallest correct path is:

1. stop exposing all discovered internal VS Code LM tools;
2. create a native external-MCP tool registry;
3. add a workspace access-policy engine with deny/read-only rules;
4. make the policy file unmodifiable and unreadable from the external MCP surface;
5. implement file and editor tools through that policy engine;
6. use a sandboxed workspace view for commands;
7. only enable direct unrestricted command execution when no protected paths exist and the user explicitly chooses trusted mode.

This gives the external assistant broad, practical control of your authorized VS Code workspace while preserving a real, enforceable “do not touch these files” boundary.
