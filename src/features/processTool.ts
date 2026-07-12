import { type ChildProcess, spawn } from "node:child_process";
import * as vscode from "vscode";
import { AccessDeniedError, requireAuthorizedPath } from "../security/pathGuard.js";
import { getConfiguredPolicyRelativePath, getOpenWorkspaceRoots } from "../security/runtimeConfig.js";
import { escapeMarkdownInline, formatAccessDeniedMessage } from "./toolErrors.js";
import {
  DEFAULT_ALLOWED_EXECUTABLES,
  appendCapped,
  clampOutputBytes,
  clampTimeoutMs,
  isExecutableAllowed,
  resolveExecutablePath,
  validateArgs
} from "./processExecution.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_BYTES = 1_000_000;
const HARD_MAX_OUTPUT_BYTES = 5_000_000;
const KILL_GRACE_MS = 5_000;

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function jsonResult(value: unknown): vscode.LanguageModelToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function commandLineFor(executable: unknown, args: unknown): string {
  const argList = Array.isArray(args) ? args.filter((item): item is string => typeof item === "string") : [];
  return [typeof executable === "string" ? executable : "", ...argList].join(" ").trim();
}

function getProcessToolsConfig(): {
  enabled: boolean;
  allowedExecutables: string[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
} {
  const config = vscode.workspace.getConfiguration("vscodeOperator.processTools");
  return {
    enabled: config.get<boolean>("enabled", true),
    allowedExecutables: config.get<string[]>("allowedExecutables", DEFAULT_ALLOWED_EXECUTABLES),
    defaultTimeoutMs: config.get<number>("defaultTimeoutMs", DEFAULT_TIMEOUT_MS),
    maxTimeoutMs: config.get<number>("maxTimeoutMs", MAX_TIMEOUT_MS),
    maxOutputBytes: config.get<number>("maxOutputBytes", DEFAULT_OUTPUT_BYTES)
  };
}

type PreparedCommand = {
  command: string;
  args: string[];
  cwdAbsolutePath: string;
  cwdRelativePath: string;
  env: NodeJS.ProcessEnv;
};

type CommandLikeInput = {
  executable?: unknown;
  args?: unknown;
  cwd?: unknown;
  workspacePath?: unknown;
  env?: unknown;
};

async function prepareCommand(
  toolName: string,
  input: CommandLikeInput
): Promise<{ prepared: PreparedCommand; message?: undefined } | { prepared?: undefined; message: string }> {
  const config = getProcessToolsConfig();
  if (!config.enabled) {
    return { message: `${toolName} is disabled (vscodeOperator.processTools.enabled is false).` };
  }

  if (typeof input.executable !== "string" || input.executable.trim().length === 0) {
    return { message: `${toolName} requires a non-empty 'executable'.` };
  }

  const args = validateArgs(input.args);
  if (!args) {
    return { message: `${toolName}: 'args' must be an array of strings when provided.` };
  }

  if (!isExecutableAllowed(input.executable, config.allowedExecutables)) {
    return {
      message: `${toolName}: executable '${input.executable}' is not in vscodeOperator.processTools.allowedExecutables (${config.allowedExecutables.join(", ")}).`
    };
  }

  let envOverrides: Record<string, string> | undefined;
  if (input.env !== undefined) {
    if (typeof input.env !== "object" || input.env === null || Array.isArray(input.env)) {
      return { message: `${toolName}: 'env' must be an object of string values when provided.` };
    }
    for (const value of Object.values(input.env as Record<string, unknown>)) {
      if (typeof value !== "string") {
        return { message: `${toolName}: all 'env' values must be strings.` };
      }
    }
    envOverrides = input.env as Record<string, string>;
  }

  let cwdDecision: Awaited<ReturnType<typeof requireAuthorizedPath>>;
  try {
    cwdDecision = await requireAuthorizedPath({
      roots: getOpenWorkspaceRoots(),
      workspacePath: input.workspacePath,
      operation: "command-input",
      targetPath: input.cwd ?? ".",
      mustExist: true,
      policyRelativePath: getConfiguredPolicyRelativePath()
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return { message: formatAccessDeniedMessage(toolName, error) };
    }
    throw error;
  }

  if (cwdDecision.policy.commandMode === "off") {
    return { message: `${toolName}: command execution is disabled by the workspace access policy (commands.mode is "off").` };
  }

  const cwdAbsolutePath = cwdDecision.requestedPath;
  const command = resolveExecutablePath(input.executable, cwdAbsolutePath);

  return {
    prepared: {
      command,
      args,
      cwdAbsolutePath,
      cwdRelativePath: cwdDecision.relativePath,
      env: { ...process.env, ...envOverrides }
    }
  };
}

type RunCommandToolInput = {
  executable: string;
  args?: string[];
  cwd?: string;
  workspacePath?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export class RunCommandTool implements vscode.LanguageModelTool<RunCommandToolInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunCommandToolInput>
  ): Promise<vscode.PreparedToolInvocation> {
    const commandLine = commandLineFor(options.input.executable, options.input.args);
    const cwd = options.input.cwd ?? ".";
    return {
      invocationMessage: `Running: ${commandLine}`,
      confirmationMessages: {
        title: "Run Command",
        message: new vscode.MarkdownString(
          `Run \`${escapeMarkdownInline(commandLine)}\` in \`${escapeMarkdownInline(cwd)}\`?`
        )
      }
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunCommandToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    const prep = await prepareCommand("vscodeOperator_runCommand", input);
    if (!prep.prepared) {
      return textResult(prep.message);
    }

    const config = getProcessToolsConfig();
    const timeoutMs = clampTimeoutMs(input.timeoutMs, config.defaultTimeoutMs, config.maxTimeoutMs);
    const maxOutputBytes = clampOutputBytes(undefined, config.maxOutputBytes, HARD_MAX_OUTPUT_BYTES);
    const { command, args, cwdAbsolutePath, cwdRelativePath, env } = prep.prepared;
    const startedAt = Date.now();

    const result = await new Promise<{
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      truncated: boolean;
      timedOut: boolean;
    }>((resolve) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let termTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(command, args, { cwd: cwdAbsolutePath, env, shell: false });

      const clearTimers = (): void => {
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
      };

      termTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        const appended = appendCapped(stdout, chunk.toString("utf8"), maxOutputBytes, truncated);
        stdout = appended.text;
        truncated = truncated || appended.truncated;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const appended = appendCapped(stderr, chunk.toString("utf8"), maxOutputBytes, truncated);
        stderr = appended.text;
        truncated = truncated || appended.truncated;
      });

      child.on("error", (error) => {
        clearTimers();
        resolve({ exitCode: null, signal: null, stdout, stderr: `${stderr}\n${error.message}`, truncated, timedOut });
      });

      child.on("close", (code, signal) => {
        clearTimers();
        resolve({ exitCode: code, signal, stdout, stderr, truncated, timedOut });
      });
    });

    return jsonResult({
      executable: command,
      args,
      cwd: cwdRelativePath,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      truncated: result.truncated,
      durationMs: Date.now() - startedAt,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
}

type TrackedProcessStatus = "running" | "exited" | "error";

type TrackedProcess = {
  id: string;
  command: string;
  args: string[];
  cwdAbsolutePath: string;
  cwdRelativePath: string;
  startedAt: string;
  child: ChildProcess;
  status: TrackedProcessStatus;
  exitCode: number | null;
  signal: string | null;
  output: string;
  truncated: boolean;
  readCursor: number;
  maxOutputBytes: number;
};

export class ProcessRegistry implements vscode.Disposable {
  private readonly processes = new Map<string, TrackedProcess>();
  private counter = 0;

  start(options: {
    command: string;
    args: string[];
    cwdAbsolutePath: string;
    cwdRelativePath: string;
    env: NodeJS.ProcessEnv;
    maxOutputBytes: number;
  }): TrackedProcess {
    this.counter += 1;
    const id = `proc-${Date.now()}-${this.counter}`;
    const child = spawn(options.command, options.args, {
      cwd: options.cwdAbsolutePath,
      env: options.env,
      shell: false
    });

    const tracked: TrackedProcess = {
      id,
      command: options.command,
      args: options.args,
      cwdAbsolutePath: options.cwdAbsolutePath,
      cwdRelativePath: options.cwdRelativePath,
      startedAt: new Date().toISOString(),
      child,
      status: "running",
      exitCode: null,
      signal: null,
      output: "",
      truncated: false,
      readCursor: 0,
      maxOutputBytes: options.maxOutputBytes
    };

    const appendChunk = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const appended = appendCapped(tracked.output, text, tracked.maxOutputBytes, tracked.truncated);
      tracked.output = appended.text;
      tracked.truncated = tracked.truncated || appended.truncated;
    };

    child.stdout?.on("data", appendChunk);
    child.stderr?.on("data", appendChunk);
    child.on("error", (error) => {
      tracked.status = "error";
      appendChunk(`\n[process error] ${error.message}\n`);
    });
    child.on("close", (code, signal) => {
      tracked.status = tracked.status === "error" ? "error" : "exited";
      tracked.exitCode = code;
      tracked.signal = signal;
    });

    this.processes.set(id, tracked);
    return tracked;
  }

  get(id: string): TrackedProcess | undefined {
    return this.processes.get(id);
  }

  list(): TrackedProcess[] {
    return [...this.processes.values()];
  }

  stop(id: string): { ok: true } | { ok: false; message: string } {
    const tracked = this.processes.get(id);
    if (!tracked) {
      return { ok: false, message: `No tracked process with id '${id}'.` };
    }
    if (tracked.status !== "running") {
      return { ok: true };
    }

    tracked.child.kill("SIGTERM");
    setTimeout(() => {
      if (tracked.status === "running") {
        tracked.child.kill("SIGKILL");
      }
    }, KILL_GRACE_MS);
    return { ok: true };
  }

  dispose(): void {
    for (const tracked of this.processes.values()) {
      if (tracked.status === "running") {
        tracked.child.kill("SIGKILL");
      }
    }
    this.processes.clear();
  }
}

type StartBackgroundProcessToolInput = {
  executable: string;
  args?: string[];
  cwd?: string;
  workspacePath?: string;
  env?: Record<string, string>;
};

export class StartBackgroundProcessTool implements vscode.LanguageModelTool<StartBackgroundProcessToolInput> {
  constructor(private readonly registry: ProcessRegistry) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<StartBackgroundProcessToolInput>
  ): Promise<vscode.PreparedToolInvocation> {
    const commandLine = commandLineFor(options.input.executable, options.input.args);
    const cwd = options.input.cwd ?? ".";
    return {
      invocationMessage: `Starting background process: ${commandLine}`,
      confirmationMessages: {
        title: "Start Background Process",
        message: new vscode.MarkdownString(
          `Start \`${escapeMarkdownInline(commandLine)}\` in \`${escapeMarkdownInline(cwd)}\` and leave it running in the background?`
        )
      }
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<StartBackgroundProcessToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const prep = await prepareCommand("vscodeOperator_startBackgroundProcess", options.input);
    if (!prep.prepared) {
      return textResult(prep.message);
    }

    const config = getProcessToolsConfig();
    const maxOutputBytes = clampOutputBytes(undefined, config.maxOutputBytes, HARD_MAX_OUTPUT_BYTES);
    const { command, args, cwdAbsolutePath, cwdRelativePath, env } = prep.prepared;

    const tracked = this.registry.start({ command, args, cwdAbsolutePath, cwdRelativePath, env, maxOutputBytes });

    return jsonResult({
      processId: tracked.id,
      executable: command,
      args,
      cwd: cwdRelativePath,
      startedAt: tracked.startedAt,
      status: tracked.status
    });
  }
}

type ReadProcessOutputToolInput = {
  processId: string;
  fromStart?: boolean;
};

export class ReadProcessOutputTool implements vscode.LanguageModelTool<ReadProcessOutputToolInput> {
  constructor(private readonly registry: ProcessRegistry) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ReadProcessOutputToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (typeof input.processId !== "string" || input.processId.trim().length === 0) {
      return textResult("vscodeOperator_readProcessOutput requires a non-empty 'processId'.");
    }

    const tracked = this.registry.get(input.processId);
    if (!tracked) {
      return textResult(`vscodeOperator_readProcessOutput: no tracked process with id '${input.processId}'.`);
    }

    const start = input.fromStart === true ? 0 : tracked.readCursor;
    const chunk = tracked.output.slice(start);
    tracked.readCursor = tracked.output.length;

    return jsonResult({
      processId: tracked.id,
      status: tracked.status,
      exitCode: tracked.exitCode,
      signal: tracked.signal,
      truncated: tracked.truncated,
      output: chunk
    });
  }
}

type StopProcessToolInput = {
  processId: string;
};

export class StopProcessTool implements vscode.LanguageModelTool<StopProcessToolInput> {
  constructor(private readonly registry: ProcessRegistry) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<StopProcessToolInput>
  ): Promise<vscode.PreparedToolInvocation> {
    const processId = options.input.processId ?? "";
    return {
      invocationMessage: `Stopping process ${processId}`,
      confirmationMessages: {
        title: "Stop Process",
        message: new vscode.MarkdownString(`Stop background process \`${escapeMarkdownInline(processId)}\`?`)
      }
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<StopProcessToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (typeof input.processId !== "string" || input.processId.trim().length === 0) {
      return textResult("vscodeOperator_stopProcess requires a non-empty 'processId'.");
    }

    const result = this.registry.stop(input.processId);
    if (!result.ok) {
      return textResult(`vscodeOperator_stopProcess: ${result.message}`);
    }

    return jsonResult({ processId: input.processId, stopping: true });
  }
}

type ListProcessesToolInput = Record<string, never>;

export class ListProcessesTool implements vscode.LanguageModelTool<ListProcessesToolInput> {
  constructor(private readonly registry: ProcessRegistry) {}

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    const processes = this.registry.list().map((tracked) => ({
      processId: tracked.id,
      executable: tracked.command,
      args: tracked.args,
      cwd: tracked.cwdRelativePath,
      status: tracked.status,
      exitCode: tracked.exitCode,
      startedAt: tracked.startedAt
    }));

    return jsonResult({ count: processes.length, processes });
  }
}
