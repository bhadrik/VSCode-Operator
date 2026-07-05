import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_POLICY_RELATIVE_PATH,
  classifyAccess,
  loadAccessPolicy,
  type EffectiveAccessPolicy
} from "./accessPolicy.js";
import {
  isPathInsideOrEqual,
  resolveWorkspaceRoot,
  toWorkspaceRelative,
  type ResolvedWorkspaceRoot,
  type WorkspaceRoot
} from "./workspaceResolver.js";

export type AccessOperation =
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

export type AccessDecision =
  | {
    allowed: true;
    workspace: ResolvedWorkspaceRoot;
    policy: EffectiveAccessPolicy;
    requestedPath: string;
    canonicalPath: string;
    relativePath: string;
    canonicalRelativePath: string;
    access: "allow" | "read-only";
  }
  | {
    allowed: false;
    workspace?: ResolvedWorkspaceRoot;
    policy?: EffectiveAccessPolicy;
    reason: "outside-workspace" | "protected" | "read-only" | "invalid-path" | "not-found";
  };

export type AccessDeniedReason = Extract<AccessDecision, { allowed: false }>["reason"];

export class AccessDeniedError extends Error {
  constructor(
    readonly reason: AccessDeniedReason,
    message = "Access denied by external MCP policy."
  ) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

const READ_ONLY_OPERATIONS = new Set<AccessOperation>([
  "list",
  "stat",
  "read",
  "search",
  "open",
  "command-output",
  "git"
]);

export async function authorizePath(options: {
  roots: readonly WorkspaceRoot[];
  workspacePath?: unknown;
  operation: AccessOperation;
  targetPath?: unknown;
  mustExist?: boolean;
  policyRelativePath?: string;
}): Promise<AccessDecision> {
  const workspace = await resolveWorkspaceRoot(options.roots, options.workspacePath);
  const policy = await loadAccessPolicy(
    workspace.fsPath,
    options.policyRelativePath ?? DEFAULT_POLICY_RELATIVE_PATH
  );

  if (options.targetPath !== undefined && options.targetPath !== null && typeof options.targetPath !== "string") {
    return { allowed: false, workspace, policy, reason: "invalid-path" };
  }

  const rawTargetPath = typeof options.targetPath === "string" && options.targetPath.trim().length > 0
    ? options.targetPath.trim()
    : ".";

  const requestedPath = path.isAbsolute(rawTargetPath)
    ? path.resolve(rawTargetPath)
    : path.resolve(workspace.fsPath, rawTargetPath);

  if (!isPathInsideOrEqual(workspace.fsPath, requestedPath)) {
    return { allowed: false, workspace, policy, reason: "outside-workspace" };
  }

  const resolved = await resolveCanonicalTarget(workspace, requestedPath, options.mustExist ?? true);
  if (!resolved) {
    return { allowed: false, workspace, policy, reason: "not-found" };
  }

  if (!isPathInsideOrEqual(workspace.realPath, resolved.canonicalPath)) {
    return { allowed: false, workspace, policy, reason: "outside-workspace" };
  }

  const relativePath = toWorkspaceRelative(workspace.fsPath, requestedPath);
  const canonicalRelativePath = toWorkspaceRelative(workspace.realPath, resolved.canonicalPath);
  const access = mostRestrictiveAccess([
    classifyAccess(policy, relativePath),
    classifyAccess(policy, canonicalRelativePath)
  ]);

  if (access === "deny") {
    return { allowed: false, workspace, policy, reason: "protected" };
  }

  if (access === "read-only" && !READ_ONLY_OPERATIONS.has(options.operation)) {
    return { allowed: false, workspace, policy, reason: "read-only" };
  }

  return {
    allowed: true,
    workspace,
    policy,
    requestedPath,
    canonicalPath: resolved.canonicalPath,
    relativePath,
    canonicalRelativePath,
    access
  };
}

export async function requireAuthorizedPath(
  options: Parameters<typeof authorizePath>[0]
): Promise<Extract<AccessDecision, { allowed: true }>> {
  const decision = await authorizePath(options);
  if (!decision.allowed) {
    throw new AccessDeniedError(decision.reason);
  }

  return decision;
}

export function isAccessDenied(error: unknown): error is AccessDeniedError {
  return error instanceof AccessDeniedError;
}

export function externalAccessErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof AccessDeniedError) {
    return {
      error: {
        code: error.reason,
        message: error.message
      }
    };
  }

  return {
    error: {
      code: "external-tool-error",
      message: error instanceof Error ? error.message : String(error)
    }
  };
}

async function resolveCanonicalTarget(
  workspace: ResolvedWorkspaceRoot,
  requestedPath: string,
  mustExist: boolean
): Promise<{ canonicalPath: string } | undefined> {
  try {
    return { canonicalPath: await fs.realpath(requestedPath) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (mustExist || code !== "ENOENT") {
      return undefined;
    }
  }

  const parent = await findClosestExistingParent(workspace.fsPath, requestedPath);
  if (!parent) {
    return undefined;
  }

  const realParent = await fs.realpath(parent);
  if (!isPathInsideOrEqual(workspace.realPath, realParent)) {
    return undefined;
  }

  const suffix = path.relative(parent, requestedPath);
  return {
    canonicalPath: path.resolve(realParent, suffix)
  };
}

async function findClosestExistingParent(rootPath: string, requestedPath: string): Promise<string | undefined> {
  let current = path.dirname(requestedPath);
  const root = path.resolve(rootPath);

  while (isPathInsideOrEqual(root, current)) {
    try {
      const stat = await fs.stat(current);
      if (stat.isDirectory()) {
        return current;
      }
    } catch {
      // Keep walking upward.
    }

    const next = path.dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }

  return undefined;
}

function mostRestrictiveAccess(values: Array<"allow" | "deny" | "read-only">): "allow" | "deny" | "read-only" {
  if (values.includes("deny")) {
    return "deny";
  }
  if (values.includes("read-only")) {
    return "read-only";
  }
  return "allow";
}
