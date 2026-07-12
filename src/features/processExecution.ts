import * as path from "node:path";

export const DEFAULT_ALLOWED_EXECUTABLES = [
  "npm",
  "npx",
  "node",
  "yarn",
  "pnpm",
  "vite",
  "tsc",
  "eslint",
  "git",
  "adb",
  "gradlew",
  "gradlew.bat",
  "python",
  "python3"
];

const STRIPPABLE_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".ps1"];

export function normalizeExecutableName(executable: string): string {
  const base = path.basename(executable.trim());
  const lower = base.toLowerCase();
  for (const extension of STRIPPABLE_EXECUTABLE_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return lower.slice(0, -extension.length);
    }
  }
  return lower;
}

export function isExecutableAllowed(executable: unknown, allowlist: readonly string[]): boolean {
  if (typeof executable !== "string" || executable.trim().length === 0) {
    return false;
  }

  const normalizedTarget = normalizeExecutableName(executable);
  return allowlist.some((entry) => normalizeExecutableName(entry) === normalizedTarget);
}

/**
 * Node resolves a relative `command` against `process.cwd()`, not the spawn
 * `cwd` option, so relative executables like "./gradlew" need to be resolved
 * against the authorized working directory ourselves before spawning.
 */
export function resolveExecutablePath(executable: string, cwdAbsolutePath: string): string {
  if (path.isAbsolute(executable)) {
    return executable;
  }

  if (executable.includes("/") || executable.includes("\\")) {
    return path.resolve(cwdAbsolutePath, executable);
  }

  return executable;
}

export function clampTimeoutMs(value: unknown, defaultMs: number, maxMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.min(defaultMs, maxMs);
  }

  return Math.min(Math.floor(value), maxMs);
}

export function clampOutputBytes(value: unknown, defaultBytes: number, maxBytes: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.min(defaultBytes, maxBytes);
  }

  return Math.min(Math.floor(value), maxBytes);
}

export type CappedAppendResult = {
  text: string;
  truncated: boolean;
};

export function appendCapped(
  current: string,
  chunk: string,
  maxBytes: number,
  alreadyTruncated: boolean
): CappedAppendResult {
  if (alreadyTruncated) {
    return { text: current, truncated: true };
  }

  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return { text: combined, truncated: false };
  }

  const truncatedBuffer = Buffer.from(combined, "utf8").subarray(0, maxBytes);
  return { text: `${truncatedBuffer.toString("utf8")}\n... (truncated)`, truncated: true };
}

export function validateArgs(args: unknown): string[] | undefined {
  if (args === undefined) {
    return [];
  }

  if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) {
    return undefined;
  }

  return args;
}
