import { promises as fs } from "node:fs";
import * as path from "node:path";

export const DEFAULT_POLICY_RELATIVE_PATH = ".vscode/vscode-operator.access.json";

export type DefaultAccess = "allow" | "deny";
export type ExternalMcpCommandMode = "off" | "sandboxed" | "trusted";

export type AccessPolicyDocument = {
  $schema?: string;
  version?: number;
  defaultAccess?: DefaultAccess;
  deny?: string[];
  readOnly?: string[];
  commands?: {
    mode?: ExternalMcpCommandMode;
    network?: boolean;
    applyChanges?: "review" | "never";
    maxRuntimeMs?: number;
    maxOutputBytes?: number;
  };
};

export type EffectiveAccessPolicy = {
  filePath: string;
  relativePath: string;
  loaded: boolean;
  valid: boolean;
  loadedAt: string;
  errors: string[];
  defaultAccess: DefaultAccess;
  deny: string[];
  readOnly: string[];
  intrinsicDeny: string[];
  commandMode: ExternalMcpCommandMode;
};

export type AccessClass = "allow" | "deny" | "read-only";

const DEFAULT_COMMAND_MODE: ExternalMcpCommandMode = "sandboxed";
const POLICY_SCHEMA = "vscode-operator://schemas/access-policy/v1";

export async function loadAccessPolicy(
  workspaceRoot: string,
  policyRelativePath = DEFAULT_POLICY_RELATIVE_PATH
): Promise<EffectiveAccessPolicy> {
  const relativePath = normalizePolicyFilePath(policyRelativePath);
  const filePath = path.resolve(workspaceRoot, relativePath);
  const intrinsicDeny = getIntrinsicDenyPatterns(relativePath);
  const loadedAt = new Date().toISOString();

  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        filePath,
        relativePath,
        loaded: false,
        valid: true,
        loadedAt,
        errors: [],
        defaultAccess: "allow",
        deny: [],
        readOnly: [],
        intrinsicDeny,
        commandMode: DEFAULT_COMMAND_MODE
      };
    }

    return invalidPolicy(filePath, relativePath, intrinsicDeny, loadedAt, "Cannot read access policy file.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidPolicy(filePath, relativePath, intrinsicDeny, loadedAt, "Access policy must be valid JSON.");
  }

  const validation = normalizePolicyDocument(parsed);
  if (!validation.valid) {
    return invalidPolicy(filePath, relativePath, intrinsicDeny, loadedAt, validation.errors.join(" "));
  }

  return {
    filePath,
    relativePath,
    loaded: true,
    valid: true,
    loadedAt,
    errors: [],
    defaultAccess: validation.policy.defaultAccess ?? "allow",
    deny: validation.policy.deny ?? [],
    readOnly: validation.policy.readOnly ?? [],
    intrinsicDeny,
    commandMode: validation.policy.commands?.mode ?? DEFAULT_COMMAND_MODE
  };
}

export async function ensureAccessPolicyFile(
  workspaceRoot: string,
  policyRelativePath = DEFAULT_POLICY_RELATIVE_PATH
): Promise<string> {
  const relativePath = normalizePolicyFilePath(policyRelativePath);
  const filePath = path.resolve(workspaceRoot, relativePath);

  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(createDefaultPolicyDocument(), null, 2)}\n`, "utf8");
  }

  return filePath;
}

export async function addDenyRule(
  workspaceRoot: string,
  pattern: string,
  policyRelativePath = DEFAULT_POLICY_RELATIVE_PATH
): Promise<void> {
  const document = await readEditablePolicyDocument(workspaceRoot, policyRelativePath);
  const normalized = normalizePolicyPattern(pattern, "deny");
  const deny = new Set(document.deny ?? []);
  deny.add(normalized);
  document.deny = [...deny].sort((a, b) => a.localeCompare(b));
  await writePolicyDocument(workspaceRoot, document, policyRelativePath);
}

export async function removeDenyRule(
  workspaceRoot: string,
  pattern: string,
  policyRelativePath = DEFAULT_POLICY_RELATIVE_PATH
): Promise<boolean> {
  const document = await readEditablePolicyDocument(workspaceRoot, policyRelativePath);
  const normalized = normalizePolicyPattern(pattern, "deny");
  const next = (document.deny ?? []).filter((item) => item !== normalized);
  const removed = next.length !== (document.deny ?? []).length;
  document.deny = next;
  await writePolicyDocument(workspaceRoot, document, policyRelativePath);
  return removed;
}

export function classifyAccess(policy: EffectiveAccessPolicy, relativePath: string): AccessClass {
  const normalized = normalizeRelativePath(relativePath);
  if (!policy.valid) {
    return "deny";
  }

  if (matchesAnyPolicyPattern(normalized, policy.intrinsicDeny)) {
    return "deny";
  }

  if (matchesAnyPolicyPattern(normalized, policy.deny)) {
    return "deny";
  }

  if (matchesAnyPolicyPattern(normalized, policy.readOnly)) {
    return "read-only";
  }

  return policy.defaultAccess === "allow" ? "allow" : "deny";
}

export function getAccessPolicyStatus(policy: EffectiveAccessPolicy): Record<string, unknown> {
  return {
    loaded: policy.loaded,
    valid: policy.valid,
    loadedAt: policy.loadedAt,
    policyFile: policy.relativePath,
    defaultAccess: policy.defaultAccess,
    denyRuleCount: policy.deny.length,
    readOnlyRuleCount: policy.readOnly.length,
    intrinsicDenyRuleCount: policy.intrinsicDeny.length,
    commandMode: policy.commandMode,
    errors: policy.errors
  };
}

export function normalizePolicyFilePath(value: string): string {
  const normalized = normalizeRelativePath(value);
  if (!normalized || isAbsolutePattern(normalized) || hasTraversal(normalized)) {
    return DEFAULT_POLICY_RELATIVE_PATH;
  }

  return normalized;
}

export function normalizePolicyPattern(pattern: string, fieldName: string): string {
  if (typeof pattern !== "string" || pattern.trim().length === 0) {
    throw new Error(`${fieldName} pattern must be a non-empty string.`);
  }

  if (pattern.includes("\\")) {
    throw new Error(`${fieldName} pattern is invalid: ${pattern}`);
  }

  const normalized = normalizeRelativePath(pattern);
  if (
    normalized.startsWith("!")
    || isAbsolutePattern(normalized)
    || hasTraversal(normalized)
  ) {
    throw new Error(`${fieldName} pattern is invalid: ${pattern}`);
  }

  return normalized;
}

function createDefaultPolicyDocument(): AccessPolicyDocument {
  return {
    $schema: POLICY_SCHEMA,
    version: 1,
    defaultAccess: "allow",
    deny: [
      ".env",
      ".env.*",
      "secrets/**",
      "private/**"
    ],
    readOnly: [],
    commands: {
      mode: DEFAULT_COMMAND_MODE,
      network: false,
      applyChanges: "review",
      maxRuntimeMs: 60000,
      maxOutputBytes: 1048576
    }
  };
}

async function readEditablePolicyDocument(
  workspaceRoot: string,
  policyRelativePath: string
): Promise<AccessPolicyDocument> {
  const filePath = await ensureAccessPolicyFile(workspaceRoot, policyRelativePath);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as AccessPolicyDocument;
  const validation = normalizePolicyDocument(parsed);
  if (!validation.valid) {
    throw new Error(`Cannot edit invalid access policy: ${validation.errors.join(" ")}`);
  }
  return parsed;
}

async function writePolicyDocument(
  workspaceRoot: string,
  document: AccessPolicyDocument,
  policyRelativePath: string
): Promise<void> {
  const relativePath = normalizePolicyFilePath(policyRelativePath);
  const filePath = path.resolve(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function normalizePolicyDocument(parsed: unknown): { valid: true; policy: AccessPolicyDocument } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, errors: ["Access policy must be a JSON object."] };
  }

  const policy = parsed as AccessPolicyDocument;
  if (policy.version !== undefined && policy.version !== 1) {
    errors.push("Access policy version must be 1.");
  }
  if (policy.defaultAccess !== undefined && policy.defaultAccess !== "allow" && policy.defaultAccess !== "deny") {
    errors.push("defaultAccess must be 'allow' or 'deny'.");
  }

  const deny = normalizePatternArray(policy.deny, "deny", errors);
  const readOnly = normalizePatternArray(policy.readOnly, "readOnly", errors);
  const commandMode = policy.commands?.mode;
  if (commandMode !== undefined && commandMode !== "off" && commandMode !== "sandboxed" && commandMode !== "trusted") {
    errors.push("commands.mode must be 'off', 'sandboxed', or 'trusted'.");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    policy: {
      ...policy,
      defaultAccess: policy.defaultAccess ?? "allow",
      deny,
      readOnly,
      commands: {
        ...policy.commands,
        mode: commandMode ?? DEFAULT_COMMAND_MODE
      }
    }
  };
}

function normalizePatternArray(value: unknown, fieldName: string, errors: string[]): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    errors.push(`${fieldName} must be an array of strings.`);
    return [];
  }

  const normalized: string[] = [];
  for (const item of value) {
    try {
      normalized.push(normalizePolicyPattern(item, fieldName));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return normalized;
}

function invalidPolicy(
  filePath: string,
  relativePath: string,
  intrinsicDeny: string[],
  loadedAt: string,
  error: string
): EffectiveAccessPolicy {
  return {
    filePath,
    relativePath,
    loaded: true,
    valid: false,
    loadedAt,
    errors: [error],
    defaultAccess: "deny",
    deny: ["**/*"],
    readOnly: [],
    intrinsicDeny,
    commandMode: "off"
  };
}

function getIntrinsicDenyPatterns(policyRelativePath: string): string[] {
  return [
    policyRelativePath,
    `${policyRelativePath}.*`,
    `${policyRelativePath}~`
  ];
}

function matchesAnyPolicyPattern(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPolicyPattern(relativePath, pattern));
}

function matchesPolicyPattern(relativePath: string, pattern: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  const normalizedPattern = normalizeRelativePath(pattern);

  if (normalizedPattern.endsWith("/**")) {
    const folder = normalizedPattern.slice(0, -3);
    if (normalizedPath === folder || normalizedPath.startsWith(`${folder}/`)) {
      return true;
    }
  }

  return globToRegExp(normalizedPattern).test(normalizedPath);
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      const isDoubleStar = pattern[index + 1] === "*";
      if (isDoubleStar) {
        const followedBySlash = pattern[index + 2] === "/";
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
  return new RegExp(regex);
}

function normalizeRelativePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").replace(/\/$/, "");
}

function hasTraversal(value: string): boolean {
  return normalizeRelativePath(value).split("/").includes("..");
}

function isAbsolutePattern(value: string): boolean {
  return path.posix.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
