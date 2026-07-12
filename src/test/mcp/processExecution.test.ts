import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
  appendCapped,
  clampOutputBytes,
  clampTimeoutMs,
  isExecutableAllowed,
  normalizeExecutableName,
  resolveExecutablePath,
  validateArgs
} from "../../features/processExecution.js";

test("normalizeExecutableName strips known extensions and lowercases", () => {
  assert.equal(normalizeExecutableName("npm"), "npm");
  assert.equal(normalizeExecutableName("NPM"), "npm");
  assert.equal(normalizeExecutableName("gradlew.bat"), "gradlew");
  assert.equal(normalizeExecutableName("./gradlew"), "gradlew");
  assert.equal(normalizeExecutableName("tools/node.exe"), "node");
});

test("isExecutableAllowed matches allowlist entries regardless of path/extension", () => {
  const allowlist = ["npm", "gradlew", "gradlew.bat", "adb"];
  assert.equal(isExecutableAllowed("npm", allowlist), true);
  assert.equal(isExecutableAllowed("./gradlew", allowlist), true);
  assert.equal(isExecutableAllowed("gradlew.bat", allowlist), true);
  assert.equal(isExecutableAllowed("/usr/local/bin/adb", allowlist), true);
  assert.equal(isExecutableAllowed("rm", allowlist), false);
  assert.equal(isExecutableAllowed("", allowlist), false);
  assert.equal(isExecutableAllowed(undefined, allowlist), false);
});

test("resolveExecutablePath only rewrites path-like executables", () => {
  const cwd = path.resolve("/workspace/project");
  assert.equal(resolveExecutablePath("npm", cwd), "npm");
  assert.equal(resolveExecutablePath("./gradlew", cwd), path.resolve(cwd, "./gradlew"));
  assert.equal(resolveExecutablePath("bin/tool", cwd), path.resolve(cwd, "bin/tool"));
  const absolute = path.resolve("/usr/bin/npm");
  assert.equal(resolveExecutablePath(absolute, cwd), absolute);
});

test("clampTimeoutMs falls back to default and enforces the max", () => {
  assert.equal(clampTimeoutMs(undefined, 120_000, 600_000), 120_000);
  assert.equal(clampTimeoutMs(-5, 120_000, 600_000), 120_000);
  assert.equal(clampTimeoutMs(5_000, 120_000, 600_000), 5_000);
  assert.equal(clampTimeoutMs(10_000_000, 120_000, 600_000), 600_000);
});

test("clampOutputBytes falls back to default and enforces the max", () => {
  assert.equal(clampOutputBytes(undefined, 1_000_000, 5_000_000), 1_000_000);
  assert.equal(clampOutputBytes(0, 1_000_000, 5_000_000), 1_000_000);
  assert.equal(clampOutputBytes(10_000_000, 1_000_000, 5_000_000), 5_000_000);
});

test("appendCapped accumulates until the byte cap then truncates once", () => {
  const first = appendCapped("", "hello ", 100, false);
  assert.equal(first.text, "hello ");
  assert.equal(first.truncated, false);

  const second = appendCapped(first.text, "world", 100, first.truncated);
  assert.equal(second.text, "hello world");
  assert.equal(second.truncated, false);

  const capped = appendCapped("", "x".repeat(20), 10, false);
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.endsWith("(truncated)"));

  const alreadyTruncated = appendCapped(capped.text, "more data", 10, true);
  assert.equal(alreadyTruncated.text, capped.text);
  assert.equal(alreadyTruncated.truncated, true);
});

test("validateArgs accepts string arrays and rejects everything else", () => {
  assert.deepEqual(validateArgs(undefined), []);
  assert.deepEqual(validateArgs(["run", "build"]), ["run", "build"]);
  assert.equal(validateArgs("run build"), undefined);
  assert.equal(validateArgs(["run", 1]), undefined);
  assert.equal(validateArgs(null), undefined);
});
