import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_POLICY_RELATIVE_PATH } from "../../security/accessPolicy.js";
import type { WorkspaceRoot } from "../../security/workspaceResolver.js";
import {
  listWorkspaceEntries,
  readWorkspaceFile,
  searchWorkspaceText,
  statWorkspacePath
} from "../../mcp/external/workspaceTools.js";

const LIMITS = {
  maxReadBytes: 1024 * 1024,
  maxSearchResults: 100
};

test("listWorkspaceEntries omits protected paths and the policy file", async (t) => {
  const workspace = await makeTempWorkspace(t);
  await fs.mkdir(path.join(workspace, "src"));
  await fs.mkdir(path.join(workspace, "secrets"));
  await fs.writeFile(path.join(workspace, "src", "index.ts"), "export const ok = true;");
  await fs.writeFile(path.join(workspace, "secrets", "token.txt"), "hidden-token");
  await writePolicy(workspace, {
    version: 1,
    defaultAccess: "allow",
    deny: ["secrets/**"]
  });

  const result = await listWorkspaceEntries({
    roots: [toRoot(workspace)],
    policyRelativePath: DEFAULT_POLICY_RELATIVE_PATH
  });
  const entries = result.entries as Array<{ path: string }>;
  const names = entries.map((entry) => entry.path);

  assert.equal(names.includes("src/index.ts"), true);
  assert.equal(names.some((name) => name.includes("secrets")), false);
  assert.equal(names.some((name) => name.includes("vscode-operator.access.json")), false);
});

test("searchWorkspaceText omits protected file names and contents", async (t) => {
  const workspace = await makeTempWorkspace(t);
  await fs.mkdir(path.join(workspace, "src"));
  await fs.mkdir(path.join(workspace, "secrets"));
  await fs.writeFile(path.join(workspace, "src", "visible.txt"), "needle visible");
  await fs.writeFile(path.join(workspace, "secrets", "token.txt"), "needle secret");
  await writePolicy(workspace, {
    version: 1,
    defaultAccess: "allow",
    deny: ["secrets/**"]
  });

  const result = await searchWorkspaceText({
    roots: [toRoot(workspace)],
    query: "needle",
    policyRelativePath: DEFAULT_POLICY_RELATIVE_PATH,
    limits: LIMITS
  });
  const matches = result.results as Array<{ file: string; preview: string }>;

  assert.deepEqual(matches.map((match) => match.file), ["src/visible.txt"]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("readWorkspaceFile and statWorkspacePath reject protected files with generic denial", async (t) => {
  const workspace = await makeTempWorkspace(t);
  await fs.writeFile(path.join(workspace, ".env"), "SECRET=value");
  await writePolicy(workspace, {
    version: 1,
    defaultAccess: "allow",
    deny: [".env"]
  });

  await assert.rejects(
    () => readWorkspaceFile({
      roots: [toRoot(workspace)],
      path: ".env",
      policyRelativePath: DEFAULT_POLICY_RELATIVE_PATH,
      limits: LIMITS
    }),
    /Access denied by external MCP policy/
  );

  await assert.rejects(
    () => statWorkspacePath({
      roots: [toRoot(workspace)],
      path: ".env",
      policyRelativePath: DEFAULT_POLICY_RELATIVE_PATH
    }),
    /Access denied by external MCP policy/
  );
});

test("readWorkspaceFile rejects the policy file intrinsically", async (t) => {
  const workspace = await makeTempWorkspace(t);
  await writePolicy(workspace, {
    version: 1,
    defaultAccess: "allow"
  });

  await assert.rejects(
    () => readWorkspaceFile({
      roots: [toRoot(workspace)],
      path: DEFAULT_POLICY_RELATIVE_PATH,
      policyRelativePath: DEFAULT_POLICY_RELATIVE_PATH,
      limits: LIMITS
    }),
    /Access denied by external MCP policy/
  );
});

test("listWorkspaceEntries avoids recursive symlink loops", async (t) => {
  const workspace = await makeTempWorkspace(t);
  await fs.mkdir(path.join(workspace, "src"));
  await fs.writeFile(path.join(workspace, "src", "index.ts"), "ok");

  try {
    await fs.symlink(workspace, path.join(workspace, "src", "loop"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      t.skip("symlink creation is not permitted in this environment");
      return;
    }
    throw error;
  }

  const result = await listWorkspaceEntries({
    roots: [toRoot(workspace)],
    maxItems: 20,
    policyRelativePath: DEFAULT_POLICY_RELATIVE_PATH
  });
  const entries = result.entries as Array<{ path: string }>;

  assert.equal(entries.filter((entry) => entry.path.endsWith("index.ts")).length, 1);
});

async function makeTempWorkspace(t: import("node:test").TestContext): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-operator-tools-test-"));
  t.after(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });
  return workspace;
}

function toRoot(fsPath: string): WorkspaceRoot {
  return {
    name: path.basename(fsPath),
    scheme: "file",
    fsPath
  };
}

async function writePolicy(workspace: string, policy: unknown): Promise<void> {
  const filePath = path.join(workspace, DEFAULT_POLICY_RELATIVE_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
}
