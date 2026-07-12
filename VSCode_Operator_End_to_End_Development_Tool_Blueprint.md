# VSCode Operator — End-to-End Development Tool Blueprint

## Goal

Build a **native external MCP control layer** for VS Code that allows an AI agent to inspect, modify, build, test, debug, run, validate, and maintain projects without relying on token-gated internal VS Code/Copilot LM tools.

Target stacks:

- Web: Node.js, React, Next.js, Vue, Angular, backend APIs
- Android: Kotlin, Java, Gradle, Flutter, React Native
- Native: C, C++, CMake, Ninja, Make
- Rust/Cargo, Python, Go, .NET, Java, monorepos
- Docker, Compose, local services, databases

---

# 1. Architecture Rules

## 1.1 Native tools first

Implement core MCP tools directly in the extension using VS Code APIs, filesystem APIs, language-server APIs, task APIs, debugger APIs, Git APIs, and controlled process execution.

Do **not** proxy every `vscode.lm.tools` tool through `vscode.lm.invokeTool()`. Some internal tools require a private invocation token and are unavailable to external MCP callers.

## 1.2 Structured tools, not shell text

Prefer structured requests:

```json
{
  "workspacePath": "/project",
  "path": "src",
  "query": "TODO",
  "include": "**/*.{ts,tsx}"
}
```

Avoid a generic opaque shell command API for normal operations:

```json
{ "command": "find src -type f | xargs grep TODO" }
```

## 1.3 Native workspace edits

Use `WorkspaceEdit` for changes where possible. It preserves undo/redo, respects open editors and dirty files, updates file watchers, and allows a precise modified-file summary.

## 1.4 Permission levels

| Mode | Allowed actions |
|---|---|
| `read` | List/read/search files, diagnostics, symbols, Git status |
| `write` | Create/edit/move/delete files |
| `execute` | Build/test/lint/run project commands |
| `privileged` | Git push, publish, destructive Docker, migrations, emulator reset |

All paths must stay inside an approved workspace root.

---

# 2. Shared API Contract

## Common input

```ts
interface WorkspaceScopedInput {
  workspacePath?: string;
  rootId?: string;
  dryRun?: boolean;
  requestId?: string;
}
```

## Common output

```ts
interface ToolResult<T> {
  ok: boolean;
  data?: T;
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: {
    workspacePath?: string;
    truncated?: boolean;
    nextCursor?: string;
    durationMs?: number;
  };
}
```

## Standard errors

```text
WORKSPACE_NOT_FOUND
WORKSPACE_AMBIGUOUS
PATH_OUTSIDE_WORKSPACE
PATH_DENIED
PATH_NOT_FOUND
PATH_IS_DIRECTORY
FILE_TOO_LARGE
BINARY_FILE
VERSION_CONFLICT
READ_ONLY_POLICY
COMMAND_DENIED
COMMAND_TIMEOUT
PROCESS_NOT_FOUND
TOOL_NOT_SUPPORTED
CONFIRMATION_REQUIRED
```

---

# 3. P0 — Workspace and File Control

## Existing read tools to keep

- `vscode_workspace_status`
- `vscode_workspace_list_roots`
- `vscode_workspace_list_files`
- `vscode_workspace_stat`
- `vscode_workspace_read_file`
- `vscode_workspace_search_text`
- `vscode_workspace_read_problems`
- `vscode_workspace_get_symbols`
- `vscode_editor_list_open_documents`

## Required specifications

### `vscode_workspace_status`

**Purpose:** Return roots, trust state, policy, command mode, and available capabilities.

```ts
{}
```

```ts
{
  workspaceTrusted: boolean;
  roots: Array<{
    id: string;
    name: string;
    path: string;
    scheme: string;
    policy: {
      loaded: boolean;
      defaultAccess: "allow" | "deny";
      commandMode: "disabled" | "sandboxed" | "full";
      denyRuleCount: number;
      readOnlyRuleCount: number;
    };
  }>;
  capabilities: string[];
}
```

### `vscode_workspace_list_files`

**Purpose:** List files/folders without terminal commands.

```ts
{
  workspacePath?: string;
  path?: string;
  pattern?: string;
  recursive?: boolean;
  maxItems?: number;
  cursor?: string;
  includeHidden?: boolean;
}
```

**Rules**

- `path` is workspace-relative.
- Default recursive mode: `false`.
- Default `maxItems`: around 200. Hard cap: 1,000.
- Support pagination.
- Omit protected paths and secrets.
- Return `path`, `type`, `bytes`, and `modifiedAt` when available.

### `vscode_workspace_read_file`

**Purpose:** Read a safe project file with range support.

```ts
{
  workspacePath?: string;
  path: string;
  encoding?: "utf8" | "base64";
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
}
```

**Rules**

- Return `version` / content hash.
- Detect binary files.
- Default maximum size: about 256 KB.
- Return `truncated: true` rather than silently cutting content.
- Respect secrets and protected-path policy.

### `vscode_workspace_search_text`

**Purpose:** Literal text search across allowed workspace files.

```ts
{
  workspacePath?: string;
  query: string;
  include?: string | string[];
  exclude?: string | string[];
  caseSensitive?: boolean;
  maxResults?: number;
  cursor?: string;
}
```

**Result fields:** `path`, `line`, `column`, `preview`, pagination metadata.

---

# 4. P0 — Native Writing and File Operations

These are the highest-priority missing capabilities.

## `vscode_workspace_write_file`

**Purpose:** Create or replace one text file.

```ts
{
  workspacePath?: string;
  path: string;
  content: string;
  expectedVersion?: string;
  overwrite?: boolean;
  createParents?: boolean;
  dryRun?: boolean;
}
```

**Rules**

- Require `expectedVersion` to overwrite an existing file unless force is explicitly approved.
- Reject outside-root paths.
- Return diff summary: insertions, deletions, old/new versions.
- Prefer VS Code workspace APIs over direct raw filesystem writes.

## `vscode_workspace_apply_edit`

**Purpose:** Atomically apply multiple edits. This should be the AI's main editing tool.

```ts
{
  workspacePath?: string;
  label: string;
  edits: Array<
    | {
        kind: "replace";
        path: string;
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
        text: string;
        expectedVersion?: string;
      }
    | { kind: "create"; path: string; content: string }
    | { kind: "delete"; path: string }
    | { kind: "rename"; from: string; to: string; overwrite?: boolean }
  >;
  dryRun?: boolean;
}
```

**Rules**

- Validate every path before changing anything.
- Apply all changes or none.
- Use `WorkspaceEdit`.
- Return every modified file with created/deleted/insertions/deletions.
- Cap edit count and total content size.

## `vscode_workspace_create_directory`

```ts
{
  workspacePath?: string;
  path: string;
  createParents?: boolean;
}
```

## `vscode_workspace_move`

```ts
{
  workspacePath?: string;
  from: string;
  to: string;
  overwrite?: boolean;
  dryRun?: boolean;
}
```

**Rules:** Never silently overwrite; report potentially affected imports/references when language services can determine them.

## `vscode_workspace_delete`

```ts
{
  workspacePath?: string;
  path: string;
  recursive?: boolean;
  useTrash?: boolean;
  dryRun?: boolean;
  confirmationToken?: string;
}
```

**Rules:** Require confirmation, default to trash, block workspace root, `.git`, protected paths, and policy-denied paths.

---

# 5. P0/P1 — Editor and Language Intelligence

## `vscode_editor_read_document`

**Purpose:** Read in-memory editor content, including unsaved changes.

```ts
{
  workspacePath?: string;
  path: string;
  startLine?: number;
  endLine?: number;
}
```

## `vscode_editor_open_file`

```ts
{
  workspacePath?: string;
  path: string;
  line?: number;
  column?: number;
  preview?: boolean;
}
```

## Language service tools

Build these with VS Code language-provider APIs:

| Tool | Purpose |
|---|---|
| `vscode_language_hover` | Type/docs at a source location |
| `vscode_language_completion` | Completion candidates |
| `vscode_language_definition` | Find definition |
| `vscode_language_references` | Find usages |
| `vscode_language_implementations` | Find trait/interface/abstract implementations |
| `vscode_language_call_hierarchy` | Incoming/outgoing callers |
| `vscode_language_rename_preview` | Preview semantic rename |
| `vscode_language_rename_apply` | Apply approved semantic rename |
| `vscode_language_code_actions` | List quick fixes/refactors |
| `vscode_language_apply_code_action` | Apply selected action |
| `vscode_language_format` | Format document or range |
| `vscode_workspace_get_symbols` | Document/workspace symbols |
| `vscode_workspace_read_problems` | Diagnostics |

### Standard source location input

```ts
{
  workspacePath?: string;
  path: string;
  line: number;
  column: number;
}
```

### `vscode_language_references`

```ts
{
  workspacePath?: string;
  path: string;
  line: number;
  column: number;
  includeDeclaration?: boolean;
  maxResults?: number;
}
```

### `vscode_language_call_hierarchy`

```ts
{
  workspacePath?: string;
  path: string;
  line: number;
  column: number;
  direction: "incoming" | "outgoing";
  maxDepth?: number;
  maxItems?: number;
}
```

### `vscode_language_rename_preview`

```ts
{
  workspacePath?: string;
  path: string;
  line: number;
  column: number;
  newName: string;
}
```

Return affected file count, occurrences, and edit preview. Require explicit confirmation before applying rename.

---

# 6. P1 — Detect, Build, Run, Test

## `vscode_project_detect`

**Purpose:** Detect project type, manifests, package manager, build/test/lint/format commands, and debug configs.

```ts
{
  workspacePath?: string;
  refresh?: boolean;
}
```

**Detect common manifests**

```text
package.json
pnpm-lock.yaml
yarn.lock
bun.lock
Cargo.toml
Cargo.lock
CMakeLists.txt
Makefile
meson.build
build.gradle
build.gradle.kts
settings.gradle
settings.gradle.kts
pubspec.yaml
requirements.txt
pyproject.toml
go.mod
*.sln
*.csproj
pom.xml
Dockerfile
docker-compose.yml
compose.yaml
```

## `vscode_task_list`

List detected VS Code tasks and generated project tasks.

```ts
{ workspacePath?: string }
```

## `vscode_task_run`

```ts
{
  workspacePath?: string;
  taskId: string;
  mode?: "foreground" | "background";
}
```

## `vscode_task_output`

```ts
{
  executionId: string;
  tailLines?: number;
  cursor?: string;
}
```

## `vscode_task_cancel`

```ts
{ executionId: string }
```

---

# 7. P1 — Native Controlled Process Runner

## `vscode_process_run`

**Purpose:** Run build/test/lint/run commands without proxying a token-gated terminal LM tool.

```ts
{
  workspacePath?: string;
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  mode?: "sync" | "background";
  purpose: "build" | "test" | "lint" | "format" | "run" | "migration" | "custom";
}
```

Good:

```json
{
  "program": "npm",
  "args": ["run", "build"],
  "cwd": ".",
  "purpose": "build"
}
```

Avoid:

```json
{ "command": "npm run build && rm -rf dist" }
```

**Rules**

- Resolve `cwd` only inside the workspace root.
- Use a command allowlist or policy mode.
- Redact apparent secret values from logs.
- Return `executionId` for background processes.
- Capture stdout/stderr separately.
- Support timeouts and cancellation.
- Return resolved program, args, cwd, and environment keys (not secret values).

## `vscode_process_output`

```ts
{
  executionId: string;
  stream?: "stdout" | "stderr" | "combined";
  tailLines?: number;
  cursor?: string;
}
```

## `vscode_process_input`

```ts
{
  executionId: string;
  input: string;
}
```

Never use this to collect passwords, tokens, keys, or other secrets through the AI.

## `vscode_process_stop`

```ts
{
  executionId: string;
  force?: boolean;
}
```

---

# 8. P1 — Test and Debug

## Test tools

| Tool | Purpose |
|---|---|
| `vscode_test_discover` | Discover tests through VS Code Test Explorer/adapters |
| `vscode_test_run` | Run all tests, selected tests, paths, or coverage |
| `vscode_test_results` | Return passed/failed/skipped results and failure details |

### `vscode_test_run`

```ts
{
  workspacePath?: string;
  paths?: string[];
  testIds?: string[];
  mode?: "run" | "debug" | "coverage";
}
```

### `vscode_test_results`

```ts
{
  executionId: string;
  includeLogs?: boolean;
}
```

Return failure `path`, `line`, assertion message, stack trace, and captured logs.

## Debugger tool set

Keep and standardize:

```text
vscode_debug_list_configurations
vscode_debug_start
vscode_debug_status
vscode_debug_set_breakpoints
vscode_debug_clear_breakpoints
vscode_debug_continue
vscode_debug_pause
vscode_debug_step_over
vscode_debug_step_into
vscode_debug_step_out
vscode_debug_stop
vscode_debug_threads
vscode_debug_stack_trace
vscode_debug_scopes
vscode_debug_variables
vscode_debug_evaluate
vscode_debug_exception_info
vscode_debug_snapshot
```

### `vscode_debug_evaluate`

```ts
{
  sessionId: string;
  frameId?: number;
  expression: string;
  context: "watch" | "repl" | "hover";
}
```

### `vscode_debug_snapshot`

Return paused file/line, exception context, current stack, scopes, and selected variables in one call.

---

# 9. P2 — Git and Code Review

| Tool | Purpose |
|---|---|
| `vscode_git_status` | Branch, staged/unstaged/untracked/conflicts/ahead-behind |
| `vscode_git_diff` | Working/staged/file/ref diff |
| `vscode_git_log` | Recent commits |
| `vscode_git_branch` | List/create/switch/delete local branches |
| `vscode_git_stage` | Stage/unstage selected paths |
| `vscode_git_commit` | Create local commit |
| `vscode_git_sync` | Fetch/pull/push/sync |

## Key contracts

```ts
// vscode_git_diff
{
  workspacePath?: string;
  path?: string;
  scope: "working" | "staged" | "commit" | "refs";
  fromRef?: string;
  toRef?: string;
  maxBytes?: number;
}

// vscode_git_stage
{
  workspacePath?: string;
  action: "stage" | "unstage";
  paths: string[];
}

// vscode_git_commit
{
  workspacePath?: string;
  message: string;
  amend?: boolean;
  confirmationToken?: string;
}

// vscode_git_sync
{
  workspacePath?: string;
  action: "fetch" | "pull" | "push" | "sync";
  remote?: string;
  branch?: string;
  confirmationToken: string;
}
```

**Rule:** `push`, force actions, remote branch deletion, and history rewriting always require confirmation.

---

# 10. P3 — Browser and Web Validation

An agent cannot be end-to-end for web development unless it can verify the running app.

Use a controlled Playwright/CDP/browser backend.

| Tool | Purpose |
|---|---|
| `vscode_browser_start_session` | Start/attach browser |
| `vscode_browser_navigate` | Open URL |
| `vscode_browser_snapshot` | Accessible DOM and visible text |
| `vscode_browser_action` | Click/fill/select/check/press/hover |
| `vscode_browser_screenshot` | Visual validation |
| `vscode_browser_console` | Browser console logs |
| `vscode_browser_network` | Failed requests/API traffic |
| `vscode_browser_wait` | Wait for selector/text/URL/network idle |

### `vscode_browser_start_session`

```ts
{
  workspacePath?: string;
  browser?: "chromium" | "chrome" | "edge";
  headless?: boolean;
  baseUrl?: string;
}
```

### `vscode_browser_action`

```ts
{
  sessionId: string;
  action: "click" | "fill" | "select" | "check" | "uncheck" | "press" | "hover";
  selector: string;
  value?: string;
}
```

### `vscode_browser_network`

```ts
{
  sessionId: string;
  onlyFailures?: boolean;
  urlContains?: string;
  maxItems?: number;
}
```

---

# 11. P3 — Android Tools

Generic build tools are not enough for Android. Add focused Android support.

| Tool | Purpose |
|---|---|
| `vscode_android_devices` | Connected physical devices/emulators |
| `vscode_android_emulator` | List/start/stop AVDs |
| `vscode_android_build` | Gradle tasks/variants |
| `vscode_android_install` | Install APK/app variant |
| `vscode_android_logcat` | Filtered Android logs |
| `vscode_android_ui_snapshot` | Current Android UI hierarchy |
| `vscode_android_ui_action` | Tap/type/swipe/back/home/launch |

### `vscode_android_build`

```ts
{
  workspacePath?: string;
  module?: string;
  task: string;
  variant?: "debug" | "release";
  mode?: "sync" | "background";
}
```

### `vscode_android_install`

```ts
{
  workspacePath?: string;
  deviceId: string;
  apkPath?: string;
  module?: string;
  variant?: "debug";
  reinstall?: boolean;
}
```

### `vscode_android_ui_action`

```ts
{
  deviceId: string;
  action: "tap" | "type" | "swipe" | "back" | "home" | "launch";
  selector?: {
    text?: string;
    resourceId?: string;
    contentDescription?: string;
  };
  value?: string;
}
```

---

# 12. P4 — Docker, Services, and Local Infrastructure

| Tool | Purpose |
|---|---|
| `vscode_services_list` | Discover project processes, ports, Docker services, URLs |
| `vscode_port_forward` | Forward/expose local port where supported |
| `vscode_docker_list` | Containers/images/Compose projects |
| `vscode_docker_compose` | Controlled Compose operations |
| `vscode_docker_logs` | Container/service logs |

### `vscode_docker_compose`

```ts
{
  workspacePath?: string;
  action: "up" | "down" | "restart" | "logs" | "ps";
  services?: string[];
  detach?: boolean;
  confirmationToken?: string;
}
```

Require privileged confirmation for `down --volumes`, prune, image removal, and container deletion.

---

# 13. Security Tools

## `vscode_security_policy_status`

Return allowed roots, denied/read-only paths, command restrictions, and policy configuration.

## `vscode_security_scan_secrets`

```ts
{
  workspacePath?: string;
  paths?: string[];
  mode?: "quick" | "full";
}
```

Rules:

- Never return raw secret values.
- Return masked values only.
- Ignore vendor/dependency folders by default.

## `vscode_security_confirm`

```ts
{
  action: string;
  summary: string;
  affectedPaths?: string[];
}
```

Use for:

```text
delete folder
overwrite many files
git push / force push
publish package
database migration
Docker destructive action
Android emulator reset
arbitrary shell mode
```

---

# 14. Naming Standard

Use canonical namespaces:

```text
vscode_workspace_*
vscode_editor_*
vscode_language_*
vscode_task_*
vscode_process_*
vscode_test_*
vscode_debug_*
vscode_git_*
vscode_browser_*
vscode_android_*
vscode_docker_*
vscode_security_*
```

Keep legacy aliases temporarily for compatibility, but do not expand them further:

```text
vscodeOperator_*
get_problems
hover
get_hover_info
```

---

# 15. Implementation Order

## Phase 1 — Core project control

```text
vscode_workspace_write_file
vscode_workspace_apply_edit
vscode_workspace_create_directory
vscode_workspace_move
vscode_workspace_delete
vscode_editor_read_document
vscode_editor_open_file
vscode_project_detect
vscode_process_run
vscode_process_output
vscode_process_stop
vscode_task_list
vscode_task_run
vscode_test_discover
vscode_test_run
vscode_test_results
```

## Phase 2 — Coding intelligence

```text
vscode_language_definition
vscode_language_references
vscode_language_implementations
vscode_language_call_hierarchy
vscode_language_rename_preview
vscode_language_rename_apply
vscode_language_code_actions
vscode_language_apply_code_action
vscode_language_format
```

## Phase 3 — Product validation

```text
vscode_browser_start_session
vscode_browser_navigate
vscode_browser_snapshot
vscode_browser_action
vscode_browser_screenshot
vscode_browser_console
vscode_browser_network
vscode_browser_wait
```

## Phase 4 — Stack adapters

```text
vscode_android_*
vscode_docker_*
vscode_git_*
vscode_services_*
vscode_port_forward
vscode_security_scan_secrets
```

---

# 16. Required Acceptance Tests

Every tool should have tests for:

```text
single-root workspace
multi-root workspace
relative and absolute path handling
path traversal attempt: ../../
symlink escape outside workspace root
policy-denied file
protected secret file
large file truncation
binary file handling
dirty unsaved editor content
concurrent file modification/version conflict
read-only workspace
command timeout
background process output
process cancellation
malformed tool input
MCP tools/list visibility
MCP tools/call routing
```

Critical end-to-end acceptance test:

```text
An external MCP client can:
1. list workspace files
2. read a source file
3. modify multiple files atomically
4. inspect diagnostics
5. run a build
6. read build output
7. run tests
8. inspect failed tests
9. debug a failure
10. validate a web page or Android screen

...without relying on `vscode.lm.invokeTool()` or token-gated internal tools.
```

---

# 17. Final Recommendation

Do not build only one giant `run_in_terminal` tool and call the integration complete.

That leads to weak automation, unsafe command handling, unreliable output parsing, poor observability, and repeated failures from internal VS Code invocation-context restrictions.

Build around these five primitives:

```text
1. Safe workspace read/write tools
2. VS Code language-service tools
3. Controlled native process/task execution
4. Structured test/debug tools
5. Browser/mobile validation tools
```

With these primitives, the AI can handle almost any development stack. Stack-specific support becomes an adapter layer rather than a separate architecture.
