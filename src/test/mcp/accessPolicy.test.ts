import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_POLICY_RELATIVE_PATH,
  classifyAccess,
  loadAccessPolicy,
  normalizePolicyPattern
} from "../../security/accessPolicy.js";

test("missing policy defaults to allow while intrinsically denying the policy file", async (t) => {
  const workspace = await makeTempWorkspace(t);
  const policy = await loadAccessPolicy(workspace);

  assert.equal(policy.loaded, false);
  assert.equal(policy.valid, true);
  assert.equal(classifyAccess(policy, "src/index.ts"), "allow");
  assert.equal(classifyAccess(policy, DEFAULT_POLICY_RELATIVE_PATH), "deny");
  assert.equal(classifyAccess(policy, `${DEFAULT_POLICY_RELATIVE_PATH}.bak`), "deny");
});

test("deny overrides read-only and default access", async (t) => {
  const workspace = await makeTempWorkspace(t);
  await writePolicy(workspace, {
    version: 1,
    defaultAccess: "allow",
    deny: ["secrets/**"],
    readOnly: ["secrets/readme.md", "docs/**"]
  });

  const policy = await loadAccessPolicy(workspace);
  assert.equal(classifyAccess(policy, "secrets/readme.md"), "deny");
  assert.equal(classifyAccess(policy, "docs/guide.md"), "read-only");
  assert.equal(classifyAccess(policy, "src/index.ts"), "allow");
});

test("default deny blocks unlisted paths while read-only still permits read-like access", async (t) => {
  const workspace = await makeTempWorkspace(t);
  await writePolicy(workspace, {
    version: 1,
    defaultAccess: "deny",
    readOnly: ["docs/**"]
  });

  const policy = await loadAccessPolicy(workspace);
  assert.equal(classifyAccess(policy, "docs/guide.md"), "read-only");
  assert.equal(classifyAccess(policy, "src/index.ts"), "deny");
});

test("invalid policy patterns fail closed", async (t) => {
  const workspace = await makeTempWorkspace(t);
  await writePolicy(workspace, {
    version: 1,
    defaultAccess: "allow",
    deny: ["../outside"]
  });

  const policy = await loadAccessPolicy(workspace);
  assert.equal(policy.valid, false);
  assert.equal(classifyAccess(policy, "src/index.ts"), "deny");
});

test("malformed patterns are rejected", () => {
  assert.throws(() => normalizePolicyPattern("/absolute/path", "deny"));
  assert.throws(() => normalizePolicyPattern("!secret.txt", "deny"));
  assert.throws(() => normalizePolicyPattern("../secret.txt", "deny"));
  assert.throws(() => normalizePolicyPattern("secret\\token.txt", "deny"));
});

async function makeTempWorkspace(t: import("node:test").TestContext): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-operator-policy-test-"));
  t.after(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });
  return workspace;
}

async function writePolicy(workspace: string, policy: unknown): Promise<void> {
  const filePath = path.join(workspace, DEFAULT_POLICY_RELATIVE_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
}
