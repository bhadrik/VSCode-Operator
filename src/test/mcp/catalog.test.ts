import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  buildExternalToolCatalog,
  filterExternalAliases,
  filterExternalLmTools,
  getUnsupportedExternalLmToolMessage,
  isKnownUnsupportedExternalLmTool,
  isLmToolExternallyProxyable,
  sanitizeExternalLmToolInput,
  sanitizeExternalLmToolSchema
} from "../../mcp/external/externalToolCatalog.js";

const EMPTY_SCHEMA = {
  type: "object",
  properties: {}
} as const;

test("external catalog includes native tools and only allowlisted LM tools", () => {
  const nativeTools: Tool[] = [
    {
      name: "vscode_workspace_read_file",
      description: "Read file",
      inputSchema: EMPTY_SCHEMA
    }
  ];
  const lmTools = [
    { name: "vscodeOperator_readProblems" },
    { name: "vscodeOperator_executeCommand" },
    { name: "vscodeOperator_debugControl" }
  ];
  const aliases = [
    { name: "get_problems", targetName: "vscodeOperator_readProblems" },
    { name: "run_command", targetName: "vscodeOperator_executeCommand" }
  ];

  const catalog = buildExternalToolCatalog(
    nativeTools,
    lmTools,
    aliases,
    (tool) => ({
      name: tool.name,
      description: tool.name,
      inputSchema: EMPTY_SCHEMA
    }),
    (alias) => ({
      name: alias.name,
      description: alias.targetName,
      inputSchema: EMPTY_SCHEMA
    })
  );

  assert.deepEqual(
    catalog.map((tool) => tool.name),
    [
      "vscode_workspace_read_file",
      "vscodeOperator_readProblems",
      "get_problems"
    ]
  );
});

test("LM filter includes only token-free allowlisted tools", () => {
  const tools = filterExternalLmTools([
    { name: "vscodeOperator_completionAt" },
    { name: "vscodeOperator_executeCommand" },
    { name: "vscodeOperator_debugEvaluate" }
  ]);

  assert.deepEqual(tools.map((tool) => tool.name), ["vscodeOperator_completionAt"]);
  assert.equal(isLmToolExternallyProxyable("vscodeOperator_completionAt"), true);
  assert.equal(isLmToolExternallyProxyable("vscodeOperator_executeCommand"), false);
  assert.equal(isLmToolExternallyProxyable("run_in_terminal"), false);
});

test("alias filter exposes aliases only when their target is allowlisted", () => {
  const aliases = filterExternalAliases([
    { name: "get_diagnostics", targetName: "vscodeOperator_readProblems" },
    { name: "evaluate", targetName: "vscodeOperator_debugEvaluate" }
  ]);

  assert.deepEqual(aliases.map((alias) => alias.name), ["get_diagnostics"]);
});

test("unsupported LM tool message explains external bridge limitation", () => {
  const message = getUnsupportedExternalLmToolMessage("vscodeOperator_executeCommand");

  assert.match(message, /requires an internal VS Code invocation context/);
  assert.match(message, /not available through the external MCP bridge/);
  assert.match(message, /native external MCP workspace tools/);
});

test("known token-gated and mutation tools are explicitly unsupported", () => {
  assert.equal(isKnownUnsupportedExternalLmTool("run_in_terminal"), true);
  assert.equal(isKnownUnsupportedExternalLmTool("vscodeOperator_executeCommand"), true);
  assert.equal(isKnownUnsupportedExternalLmTool("vscodeOperator_debugControl"), true);
  assert.equal(isKnownUnsupportedExternalLmTool("vscodeOperator_readProblems"), false);
});

test("debug snapshot external schema and input do not expose expression evaluation", () => {
  const schema = sanitizeExternalLmToolSchema("vscodeOperator_debugSnapshot", {
    type: "object",
    required: ["evaluateExpressions", "compact"],
    properties: {
      evaluateExpressions: { type: "array", items: { type: "string" } },
      evaluateContext: { type: "string" },
      compact: { type: "boolean" }
    }
  });

  assert.deepEqual(schema, {
    type: "object",
    required: ["compact"],
    properties: {
      compact: { type: "boolean" }
    }
  });

  assert.deepEqual(
    sanitizeExternalLmToolInput("vscodeOperator_debugSnapshot", {
      evaluateExpressions: ["this"],
      evaluateContext: "watch",
      compact: true
    }),
    { compact: true }
  );
});
