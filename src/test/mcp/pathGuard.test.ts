import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_POLICY_RELATIVE_PATH } from "../../security/accessPolicy.js";
import { authorizePath, requireAuthorizedPath } from "../../security/pathGuard.js";
import type { WorkspaceRoot } from "../../security/workspaceResolver.js";

test("authorizePath rejects traversal outside the workspace", async (t) => {
  const workspace = await makeTempWorkspace(t);
  const decision = await authorizePath({
    roots: [toRoot(workspace)],
    operation: "read",
    targetPath: "../outside.txt"
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "outside-workspace");
});

test("authorizePath rejects symlink escape", async (t) => {
  const workspace = await makeTempWorkspace(t);
  const outside = await makeTempWorkspace(t);
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");

  try {
    await fs.symlink(path.join(outside, "secret.txt"), path.join(workspace, "escape.txt"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      t.skip("symlink creation is not permitted in this environment");
      return;
    }
    throw error;
  }

  const decision = await authorizePath({
    roots: [toRoot(workspace)],
    operation: "read",
    targetPath: "escape.txt"
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "outside-workspace");
});

test("authorizePath evaluates canonical symlink target against policy", async (t) => {
  const workspace = await makeTempWorkspace(t);
  await fs.mkdir(path.join(workspace, "public"));
  await fs.mkdir(path.join(workspace, "secrets"));
  await fs.writeFile(path.join(workspace, "secrets", "token.txt"), "secret");
  await writePolicy(workspace, {
    version: 1,
    defaultAccess: "allow",
    deny: ["secrets/**"]
  });

  try {
    await fs.symlink(path.join(workspace, "secrets", "token.txt"), path.join(workspace, "public", "link.txt"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      t.skip("symlink creation is not permitted in this environment");
      return;
    }
    throw error;
  }

  const decision = await authorizePath({
    roots: [toRoot(workspace)],
    operation: "read",
    targetPath: "public/link.txt"
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "protected");
});

test("read-only policy permits read and rejects mutation", async (t) => {
  const workspace = await makeTempWorkspace(t);
  await fs.mkdir(path.join(workspace, "infra"));
  await fs.writeFile(path.join(workspace, "infra", "prod.tf"), "resource");
  await writePolicy(workspace, {
    version: 1,
    defaultAccess: "allow",
    readOnly: ["infra/**"]
  });

  const readDecision = await requireAuthorizedPath({
    roots: [toRoot(workspace)],
    operation: "read",
    targetPath: "infra/prod.tf"
  });
  assert.equal(readDecision.access, "read-only");

  const writeDecision = await authorizePath({
    roots: [toRoot(workspace)],
    operation: "write",
    targetPath: "infra/prod.tf"
  });
  assert.equal(writeDecision.allowed, false);
  assert.equal(writeDecision.reason, "read-only");
});

test("new file authorization checks closest existing parent", async (t) => {
  const workspace = await makeTempWorkspace(t);
  await fs.mkdir(path.join(workspace, "src"));
  await writePolicy(workspace, {
    version: 1,
    defaultAccess: "allow",
    deny: ["secrets/**"]
  });

  const allowed = await authorizePath({
    roots: [toRoot(workspace)],
    operation: "create",
    targetPath: "src/new.ts",
    mustExist: false
  });
  assert.equal(allowed.allowed, true);

  const denied = await authorizePath({
    roots: [toRoot(workspace)],
    operation: "create",
    targetPath: "secrets/new.txt",
    mustExist: false
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "protected");
});

test("new file authorization rejects symlink parent escape", async (t) => {
  const workspace = await makeTempWorkspace(t);
  const outside = await makeTempWorkspace(t);

  try {
    await fs.symlink(outside, path.join(workspace, "linked-outside"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      t.skip("symlink creation is not permitted in this environment");
      return;
    }
    throw error;
  }

  const decision = await authorizePath({
    roots: [toRoot(workspace)],
    operation: "create",
    targetPath: "linked-outside/new.txt",
    mustExist: false
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "not-found");
});

async function makeTempWorkspace(t: import("node:test").TestContext): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-operator-guard-test-"));
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
