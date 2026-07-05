import { promises as fs } from "node:fs";
import * as path from "node:path";

export type WorkspaceRoot = {
  name?: string;
  scheme: string;
  fsPath: string;
};

export type ResolvedWorkspaceRoot = WorkspaceRoot & {
  realPath: string;
};

export class WorkspaceResolverError extends Error {
  constructor(
    readonly code: "workspace-missing" | "workspace-not-open" | "workspace-ambiguous" | "workspace-non-file" | "workspace-unreadable" | "invalid-input",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceResolverError";
  }
}

export async function resolveWorkspaceRoot(
  roots: readonly WorkspaceRoot[],
  workspacePath?: unknown
): Promise<ResolvedWorkspaceRoot> {
  if (roots.length === 0) {
    throw new WorkspaceResolverError("workspace-missing", "No workspace folder is open.");
  }

  if (workspacePath !== undefined && workspacePath !== null && typeof workspacePath !== "string") {
    throw new WorkspaceResolverError("invalid-input", "workspacePath must be a string when provided.");
  }

  const requestedPath = typeof workspacePath === "string" ? workspacePath.trim() : "";
  let selected: WorkspaceRoot | undefined;

  if (requestedPath.length > 0) {
    const normalizedRequested = normalizeForCompare(requestedPath);
    selected = roots.find((root) => normalizeForCompare(root.fsPath) === normalizedRequested);
    if (!selected) {
      throw new WorkspaceResolverError("workspace-not-open", "workspacePath must match an open workspace folder.");
    }
  } else if (roots.length === 1) {
    selected = roots[0];
  } else {
    throw new WorkspaceResolverError("workspace-ambiguous", "Multiple workspace folders are open. Provide workspacePath.");
  }

  if (selected.scheme !== "file") {
    throw new WorkspaceResolverError("workspace-non-file", "External MCP workspace file tools require a file workspace root.");
  }

  const rootPath = path.resolve(selected.fsPath);
  let realPath: string;
  try {
    realPath = await fs.realpath(rootPath);
  } catch {
    throw new WorkspaceResolverError("workspace-unreadable", "Cannot access workspace root.");
  }

  return {
    ...selected,
    fsPath: rootPath,
    realPath
  };
}

export function normalizeForCompare(value: string): string {
  const trimmed = value.trim();
  if (/^[a-zA-Z]:/.test(trimmed)) {
    return path.win32.normalize(trimmed.replace(/\//g, "\\")).toLowerCase();
  }
  return path.posix.normalize(trimmed.replace(/\\/g, "/"));
}

export function isPathInsideOrEqual(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function toWorkspaceRelative(rootPath: string, absolutePath: string): string {
  return path.relative(rootPath, absolutePath).replace(/\\/g, "/");
}
