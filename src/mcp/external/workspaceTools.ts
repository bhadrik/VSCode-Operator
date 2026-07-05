import { promises as fs } from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import {
  AccessDeniedError,
  authorizePath,
  requireAuthorizedPath
} from "../../security/pathGuard.js";
import type { WorkspaceRoot } from "../../security/workspaceResolver.js";

export type WorkspaceToolLimits = {
  maxReadBytes: number;
  maxSearchResults: number;
};

export type WorkspaceEntry = {
  path: string;
  type: "file" | "directory";
  bytes?: number;
};

export type WorkspaceStat = WorkspaceEntry & {
  modifiedAt: string;
};

export type WorkspaceSearchResult = {
  file: string;
  line: number;
  column: number;
  preview: string;
};

const DEFAULT_LIST_MAX_ITEMS = 200;
const LIST_HARD_MAX_ITEMS = 1000;
const DEFAULT_READ_MAX_BYTES = 5 * 1024 * 1024;
const READ_HARD_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_SEARCH_MAX_RESULTS = 500;
const SEARCH_HARD_MAX_RESULTS = 2000;
const SEARCH_FILE_MAX_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export async function getWorkspaceStatus(options: {
  roots: readonly WorkspaceRoot[];
  workspaceTrusted: boolean;
  policyRelativePath: string;
  commandMode: string;
}): Promise<Record<string, unknown>> {
  const roots = [];
  for (const root of options.roots) {
    if (root.scheme !== "file") {
      roots.push({
        name: root.name,
        scheme: root.scheme,
        path: root.fsPath,
        policy: {
          loaded: false,
          valid: false,
          errors: ["Only file workspace roots are supported by external MCP workspace tools."]
        }
      });
      continue;
    }

    const decision = await authorizePath({
      roots: [root],
      operation: "list",
      targetPath: ".",
      policyRelativePath: options.policyRelativePath
    });

    roots.push({
      name: root.name,
      scheme: root.scheme,
      path: root.fsPath,
      policy: decision.policy
        ? {
          loaded: decision.policy.loaded,
          valid: decision.policy.valid,
          loadedAt: decision.policy.loadedAt,
          policyFile: decision.policy.relativePath,
          defaultAccess: decision.policy.defaultAccess,
          denyRuleCount: decision.policy.deny.length,
          readOnlyRuleCount: decision.policy.readOnly.length,
          intrinsicDenyRuleCount: decision.policy.intrinsicDeny.length,
          commandMode: decision.policy.commandMode,
          errors: decision.policy.errors
        }
        : undefined
    });
  }

  return {
    workspaceTrusted: options.workspaceTrusted,
    configuredPolicyFile: options.policyRelativePath,
    configuredCommandMode: options.commandMode,
    roots
  };
}

export async function listWorkspaceEntries(options: {
  roots: readonly WorkspaceRoot[];
  workspacePath?: unknown;
  path?: unknown;
  pattern?: unknown;
  recursive?: unknown;
  maxItems?: unknown;
  policyRelativePath: string;
}): Promise<Record<string, unknown>> {
  const maxItems = normalizePositiveInteger(options.maxItems, DEFAULT_LIST_MAX_ITEMS, LIST_HARD_MAX_ITEMS, "maxItems");
  const recursive = options.recursive !== false;
  if (options.recursive !== undefined && typeof options.recursive !== "boolean") {
    throw new Error("recursive must be a boolean when provided.");
  }

  const pattern = normalizeOptionalString(options.pattern, "**/*", "pattern");
  const matcher = createGlobMatcher(pattern);
  const rootDecision = await requireAuthorizedPath({
    roots: options.roots,
    workspacePath: options.workspacePath,
    operation: "list",
    targetPath: options.path,
    policyRelativePath: options.policyRelativePath
  });

  const start = rootDecision.requestedPath;
  const entries: WorkspaceEntry[] = [];
  let truncated = false;
  let unreadable = 0;
  const visitedDirectories = new Set<string>();

  async function visit(absolutePath: string): Promise<"continue" | "stop"> {
    try {
      const realDirectory = await fs.realpath(absolutePath);
      if (visitedDirectories.has(realDirectory)) {
        return "continue";
      }
      visitedDirectories.add(realDirectory);
    } catch {
      unreadable++;
      return "continue";
    }

    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    } catch {
      unreadable++;
      return "continue";
    }

    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      const entryPath = path.join(absolutePath, dirent.name);
      const decision = await authorizePath({
        roots: [rootDecision.workspace],
        operation: "list",
        targetPath: entryPath,
        policyRelativePath: options.policyRelativePath
      });
      if (!decision.allowed) {
        continue;
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(entryPath);
      } catch {
        unreadable++;
        continue;
      }

      const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : undefined;
      if (!type) {
        continue;
      }

      const displayPath = decision.relativePath;
      if (matcher(displayPath)) {
        entries.push({
          path: displayPath,
          type,
          bytes: type === "file" ? statSizeToNumber(stat.size) : undefined
        });
      }

      if (entries.length >= maxItems) {
        truncated = true;
        return "stop";
      }

      if (recursive && type === "directory") {
        const nested = await visit(entryPath);
        if (nested === "stop") {
          return "stop";
        }
      }
    }

    return "continue";
  }

  const startStat = await fs.stat(start);
  if (startStat.isDirectory()) {
    await visit(start);
  } else if (startStat.isFile()) {
    const relativePath = rootDecision.relativePath;
    if (matcher(relativePath)) {
      entries.push({
        path: relativePath,
        type: "file",
        bytes: statSizeToNumber(startStat.size)
      });
    }
  }

  return {
    root: rootDecision.workspace.fsPath,
    path: rootDecision.relativePath,
    pattern,
    recursive,
    count: entries.length,
    truncated,
    skipped: { unreadable },
    entries
  };
}

export async function statWorkspacePath(options: {
  roots: readonly WorkspaceRoot[];
  workspacePath?: unknown;
  path?: unknown;
  policyRelativePath: string;
}): Promise<Record<string, unknown>> {
  const decision = await requireAuthorizedPath({
    roots: options.roots,
    workspacePath: options.workspacePath,
    operation: "stat",
    targetPath: options.path,
    policyRelativePath: options.policyRelativePath
  });
  const stat = await fs.stat(decision.requestedPath);
  const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";

  return {
    root: decision.workspace.fsPath,
    path: decision.relativePath,
    type,
    bytes: type === "file" ? statSizeToNumber(stat.size) : undefined,
    modifiedAt: stat.mtime.toISOString(),
    readOnly: decision.access === "read-only"
  };
}

export async function readWorkspaceFile(options: {
  roots: readonly WorkspaceRoot[];
  workspacePath?: unknown;
  path?: unknown;
  encoding?: unknown;
  maxBytes?: unknown;
  policyRelativePath: string;
  limits: WorkspaceToolLimits;
}): Promise<Record<string, unknown>> {
  const requestedPath = requireString(options.path, "path");
  const encoding = normalizeEncoding(options.encoding);
  const defaultMaxBytes = Math.min(options.limits.maxReadBytes || DEFAULT_READ_MAX_BYTES, READ_HARD_MAX_BYTES);
  const maxBytes = normalizePositiveInteger(options.maxBytes, defaultMaxBytes, READ_HARD_MAX_BYTES, "maxBytes");
  const decision = await requireAuthorizedPath({
    roots: options.roots,
    workspacePath: options.workspacePath,
    operation: "read",
    targetPath: requestedPath,
    policyRelativePath: options.policyRelativePath
  });
  const stat = await fs.stat(decision.requestedPath);
  if (!stat.isFile()) {
    throw new AccessDeniedError("invalid-path", "Requested path is not a file.");
  }

  const size = statSizeToNumber(stat.size);
  if (size > maxBytes) {
    throw new AccessDeniedError("protected", "Requested file exceeds the external MCP read limit.");
  }

  const buffer = await fs.readFile(decision.requestedPath);
  if (buffer.byteLength > maxBytes) {
    throw new AccessDeniedError("protected", "Requested file exceeds the external MCP read limit.");
  }

  return {
    root: decision.workspace.fsPath,
    path: decision.relativePath,
    encoding,
    bytes: buffer.byteLength,
    content: encoding === "base64" ? buffer.toString("base64") : decodeUtf8(buffer)
  };
}

export async function searchWorkspaceText(options: {
  roots: readonly WorkspaceRoot[];
  workspacePath?: unknown;
  query?: unknown;
  include?: unknown;
  exclude?: unknown;
  caseSensitive?: unknown;
  maxResults?: unknown;
  policyRelativePath: string;
  limits: WorkspaceToolLimits;
}): Promise<Record<string, unknown>> {
  const query = requireString(options.query, "query");
  const include = normalizePatternList(options.include, ["**/*"], "include");
  const exclude = normalizePatternList(options.exclude, [], "exclude");
  const caseSensitive = options.caseSensitive === true;
  if (options.caseSensitive !== undefined && typeof options.caseSensitive !== "boolean") {
    throw new Error("caseSensitive must be a boolean when provided.");
  }

  const defaultMaxResults = Math.min(options.limits.maxSearchResults || DEFAULT_SEARCH_MAX_RESULTS, SEARCH_HARD_MAX_RESULTS);
  const maxResults = normalizePositiveInteger(options.maxResults, defaultMaxResults, SEARCH_HARD_MAX_RESULTS, "maxResults");
  const rootDecision = await requireAuthorizedPath({
    roots: options.roots,
    workspacePath: options.workspacePath,
    operation: "search",
    targetPath: ".",
    policyRelativePath: options.policyRelativePath
  });
  const includeMatchers = include.map(createGlobMatcher);
  const excludeMatchers = exclude.map(createGlobMatcher);
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const results: WorkspaceSearchResult[] = [];
  let truncated = false;
  const skipped = {
    unreadable: 0,
    oversizedFiles: 0,
    binaryFiles: 0
  };
  const visitedDirectories = new Set<string>();

  async function visit(directory: string): Promise<"continue" | "stop"> {
    try {
      const realDirectory = await fs.realpath(directory);
      if (visitedDirectories.has(realDirectory)) {
        return "continue";
      }
      visitedDirectories.add(realDirectory);
    } catch {
      skipped.unreadable++;
      return "continue";
    }

    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      skipped.unreadable++;
      return "continue";
    }

    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      const absolutePath = path.join(directory, dirent.name);
      const decision = await authorizePath({
        roots: [rootDecision.workspace],
        operation: "search",
        targetPath: absolutePath,
        policyRelativePath: options.policyRelativePath
      });
      if (!decision.allowed) {
        continue;
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(absolutePath);
      } catch {
        skipped.unreadable++;
        continue;
      }

      if (stat.isDirectory()) {
        const nested = await visit(absolutePath);
        if (nested === "stop") {
          return "stop";
        }
        continue;
      }

      if (!stat.isFile()) {
        continue;
      }

      const relativePath = decision.relativePath;
      if (!includeMatchers.some((matcher) => matcher(relativePath)) || excludeMatchers.some((matcher) => matcher(relativePath))) {
        continue;
      }

      if (statSizeToNumber(stat.size) > SEARCH_FILE_MAX_BYTES) {
        skipped.oversizedFiles++;
        continue;
      }

      let buffer: Buffer;
      try {
        buffer = await fs.readFile(absolutePath);
      } catch {
        skipped.unreadable++;
        continue;
      }

      let text: string;
      try {
        text = decodeUtf8(buffer);
      } catch {
        skipped.binaryFiles++;
        continue;
      }

      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index].replace(/\r$/, "");
        const haystack = caseSensitive ? line : line.toLocaleLowerCase();
        const columnIndex = haystack.indexOf(needle);
        if (columnIndex < 0) {
          continue;
        }

        results.push({
          file: relativePath,
          line: index + 1,
          column: columnIndex + 1,
          preview: truncatePreview(line)
        });

        if (results.length >= maxResults) {
          truncated = true;
          return "stop";
        }
      }
    }

    return "continue";
  }

  await visit(rootDecision.workspace.fsPath);

  return {
    root: rootDecision.workspace.fsPath,
    query,
    include,
    exclude,
    caseSensitive,
    maxResults,
    count: results.length,
    truncated,
    skipped,
    results
  };
}

function normalizeEncoding(value: unknown): "utf8" | "base64" {
  if (value === undefined || value === null) {
    return "utf8";
  }

  if (value === "utf8" || value === "base64") {
    return value;
  }

  throw new Error("encoding must be 'utf8' or 'base64'.");
}

function normalizeOptionalString(value: unknown, defaultValue: string, fieldName: string): string {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  return requireString(value, fieldName);
}

function normalizePatternList(value: unknown, defaultValue: string[], fieldName: string): string[] {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => requireString(item, fieldName).split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }

  return value.trim();
}

function normalizePositiveInteger(value: unknown, defaultValue: number, hardMax: number, fieldName: string): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${fieldName} must be an integer >= 1.`);
  }

  return Math.min(value as number, hardMax);
}

function statSizeToNumber(size: number | bigint): number {
  return typeof size === "bigint" ? Number(size) : size;
}

function decodeUtf8(buffer: Buffer): string {
  if (!isLikelyTextBuffer(buffer)) {
    throw new Error("File is not valid UTF-8 text.");
  }

  return UTF8_DECODER.decode(buffer);
}

function isLikelyTextBuffer(buffer: Buffer): boolean {
  if (buffer.byteLength === 0) {
    return true;
  }

  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 4096));
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
  }
  return true;
}

function truncatePreview(line: string): string {
  const maxLength = 240;
  return line.length <= maxLength ? line : `${line.slice(0, maxLength)}...`;
}

function createGlobMatcher(pattern: string): (relativePath: string) => boolean {
  const normalized = pattern.replace(/\\/g, "/");
  let regex = "^";
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === "*") {
      const isDoubleStar = normalized[index + 1] === "*";
      if (isDoubleStar) {
        const followedBySlash = normalized[index + 2] === "/";
        regex += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 2 : 1;
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += escapeRegex(char);
  }
  regex += "$";
  const matcher = new RegExp(regex);
  return (relativePath: string) => matcher.test(relativePath.replace(/\\/g, "/"));
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
