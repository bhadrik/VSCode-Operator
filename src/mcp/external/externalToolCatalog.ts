import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const EXTERNALLY_PROXYABLE_LM_TOOLS = new Set<string>([
  "vscodeOperator_readProblems",
  "vscodeOperator_activeEditorSummary",
  "vscodeOperator_hoverTopVisible",
  "vscodeOperator_hoverAtPosition",
  "vscodeOperator_completionAt",
  "vscodeOperator_debugStatus",
  "vscodeOperator_debugGetThreads",
  "vscodeOperator_debugGetTopFrame",
  "vscodeOperator_debugGetStackTrace",
  "vscodeOperator_debugGetScopes",
  "vscodeOperator_debugGetVariables",
  "vscodeOperator_debugGetExceptionInfo",
  "vscodeOperator_debugSnapshot"
]);

export const KNOWN_UNSUPPORTED_EXTERNAL_LM_TOOLS = new Set<string>([
  "run_in_terminal",
  "vscodeOperator_executeCommand",
  "vscodeOperator_debugStart",
  "vscodeOperator_debugSetBreakpoints",
  "vscodeOperator_debugClearBreakpoints",
  "vscodeOperator_debugControl",
  "vscodeOperator_debugEvaluate"
]);

export type NamedTool = {
  name: string;
};

export type AliasTarget = {
  targetName: string;
};

const DEBUG_SNAPSHOT_EXTERNAL_BLOCKED_INPUTS = ["evaluateExpressions", "evaluateContext"] as const;

export function isLmToolExternallyProxyable(name: string): boolean {
  return EXTERNALLY_PROXYABLE_LM_TOOLS.has(name);
}

export function isKnownUnsupportedExternalLmTool(name: string): boolean {
  return KNOWN_UNSUPPORTED_EXTERNAL_LM_TOOLS.has(name);
}

export function getUnsupportedExternalLmToolMessage(toolName: string): string {
  return [
    `This tool requires an internal VS Code invocation context and is not available through the external MCP bridge: ${toolName}.`,
    "Use native external MCP workspace tools for file listing, file reading, and text search.",
    "External terminal/process support must be implemented as a native controlled command runner instead of proxying VS Code's internal LM terminal tool."
  ].join(" ");
}

export function sanitizeExternalLmToolSchema(toolName: string, inputSchema: Tool["inputSchema"]): Tool["inputSchema"] {
  if (toolName !== "vscodeOperator_debugSnapshot") {
    return inputSchema;
  }

  if (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema)) {
    return inputSchema;
  }

  const schema = inputSchema as Record<string, unknown>;
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return inputSchema;
  }

  const nextProperties = { ...(properties as Record<string, unknown>) };
  for (const key of DEBUG_SNAPSHOT_EXTERNAL_BLOCKED_INPUTS) {
    delete nextProperties[key];
  }

  const nextSchema: Record<string, unknown> = {
    ...schema,
    properties: nextProperties
  };

  if (Array.isArray(schema.required)) {
    nextSchema.required = schema.required.filter(
      (key) => !DEBUG_SNAPSHOT_EXTERNAL_BLOCKED_INPUTS.includes(key as typeof DEBUG_SNAPSHOT_EXTERNAL_BLOCKED_INPUTS[number])
    );
  }

  return nextSchema as Tool["inputSchema"];
}

export function sanitizeExternalLmToolInput<T extends Record<string, unknown>>(toolName: string, input: T): T {
  if (toolName !== "vscodeOperator_debugSnapshot") {
    return input;
  }

  let changed = false;
  const next = { ...input };
  for (const key of DEBUG_SNAPSHOT_EXTERNAL_BLOCKED_INPUTS) {
    if (key in next) {
      delete next[key];
      changed = true;
    }
  }

  return changed ? next as T : input;
}

export function filterExternalLmTools<T extends NamedTool>(tools: readonly T[]): T[] {
  return tools.filter((tool) => isLmToolExternallyProxyable(tool.name));
}

export function filterExternalAliases<T extends AliasTarget>(aliases: readonly T[]): T[] {
  return aliases.filter((alias) => isLmToolExternallyProxyable(alias.targetName));
}

export function buildExternalToolCatalog<T extends NamedTool, A extends AliasTarget>(
  nativeTools: readonly Tool[],
  lmTools: readonly T[],
  aliases: readonly A[],
  toLmTool: (tool: T) => Tool,
  toAliasTool: (alias: A) => Tool
): Tool[] {
  return [
    ...nativeTools,
    ...filterExternalLmTools(lmTools).map(toLmTool),
    ...filterExternalAliases(aliases).map(toAliasTool)
  ];
}
