import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  buildWorkspaceStatus,
  mergeProxyToolCatalogs,
  PROXY_WORKSPACE_STATUS_TOOL,
  ProxyRoutingError,
  selectHeaderlessProxySession,
  selectWorkspaceBridge,
  type BridgeRegistration
} from "../../mcp/proxyRouting.js";

const WORKSPACE_A: BridgeRegistration = {
  workspacePath: "D:\\Projects\\ProjectA",
  host: "127.0.0.1",
  port: 19192
};

const WORKSPACE_B: BridgeRegistration = {
  workspacePath: "D:\\Projects\\ProjectB",
  host: "127.0.0.1",
  port: 19193
};

const EMPTY_SCHEMA = {
  type: "object",
  properties: {}
} as const;

test("proxy workspace status reports zero, one, and multiple registered bridges", () => {
  assert.deepEqual(buildWorkspaceStatus([]), { workspaces: [], count: 0 });
  assert.deepEqual(buildWorkspaceStatus([WORKSPACE_B]), {
    workspaces: [{ workspacePath: WORKSPACE_B.workspacePath }],
    count: 1
  });
  assert.deepEqual(buildWorkspaceStatus([WORKSPACE_B, WORKSPACE_A]), {
    workspaces: [
      { workspacePath: WORKSPACE_A.workspacePath },
      { workspacePath: WORKSPACE_B.workspacePath }
    ],
    count: 2
  });
});

test("proxy catalog replaces bridge-local workspace status and unions bridge tools", () => {
  const bridgeStatus: Tool = {
    name: "vscode_workspace_status",
    description: "Bridge-local status",
    inputSchema: EMPTY_SCHEMA
  };
  const catalog = mergeProxyToolCatalogs([
    [bridgeStatus, { name: "vscodeOperator_readFile", description: "Read A", inputSchema: EMPTY_SCHEMA }],
    [{ name: "vscode_workspace_read_file", description: "Read B", inputSchema: EMPTY_SCHEMA }]
  ]);

  assert.deepEqual(catalog.map((tool) => tool.name), [
    "vscode_workspace_read_file",
    "vscode_workspace_status",
    "vscodeOperator_readFile"
  ]);
  assert.equal(catalog.filter((tool) => tool.name === "vscode_workspace_status").length, 1);
  assert.deepEqual(
    catalog.find((tool) => tool.name === "vscode_workspace_status"),
    PROXY_WORKSPACE_STATUS_TOOL
  );
  assert.deepEqual(mergeProxyToolCatalogs([]), [PROXY_WORKSPACE_STATUS_TOOL]);
});

test("explicit workspacePath wins over an existing session route", () => {
  const route = selectWorkspaceBridge({
    bridges: [WORKSPACE_A, WORKSPACE_B],
    workspacePath: "d:/projects/projectb",
    sessionWorkspacePath: WORKSPACE_A.workspacePath
  });

  assert.equal(route.bridge.workspacePath, WORKSPACE_B.workspacePath);
  assert.equal(route.source, "workspacePath");
});

test("single workspace fallback remains available without workspacePath", () => {
  const route = selectWorkspaceBridge({ bridges: [WORKSPACE_A] });

  assert.equal(route.bridge.workspacePath, WORKSPACE_A.workspacePath);
  assert.equal(route.source, "single-workspace");
});

test("headerless proxy requests reuse a peer session or the only live session", () => {
  const sessions = new Map([
    ["session-a", {}],
    ["session-b", {}]
  ]);
  assert.equal(selectHeaderlessProxySession(sessions, "session-b"), "session-b");
  assert.equal(selectHeaderlessProxySession(sessions), undefined);
  assert.equal(selectHeaderlessProxySession(new Map([["session-a", {}]])), "session-a");
  assert.equal(selectHeaderlessProxySession(new Map(), "expired-session"), undefined);
});

test("ambiguous and unregistered workspace routes return useful MCP errors", () => {
  assert.throws(
    () => selectWorkspaceBridge({ bridges: [WORKSPACE_A, WORKSPACE_B] }),
    (error: unknown) => error instanceof ProxyRoutingError
      && error.code === -32602
      && /Multiple workspaces/.test(error.message)
  );
  assert.throws(
    () => selectWorkspaceBridge({ bridges: [WORKSPACE_A], workspacePath: "D:\\Projects\\Missing" }),
    (error: unknown) => error instanceof ProxyRoutingError
      && error.code === -32602
      && /No bridge is registered/.test(error.message)
  );
});

test("a stale session route cannot select a different workspace after its bridge disconnects", () => {
  assert.throws(
    () => selectWorkspaceBridge({
      bridges: [WORKSPACE_B, { ...WORKSPACE_B, workspacePath: "D:\\Projects\\ProjectC", port: 19194 }],
      sessionWorkspacePath: WORKSPACE_A.workspacePath
    }),
    (error: unknown) => error instanceof ProxyRoutingError && error.code === -32602
  );
});
