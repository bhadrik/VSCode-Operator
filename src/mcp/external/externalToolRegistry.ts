import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import * as vscode from "vscode";
import {
  DEFAULT_POLICY_RELATIVE_PATH,
  getAccessPolicyStatus,
  loadAccessPolicy
} from "../../security/accessPolicy.js";
import { externalAccessErrorPayload } from "../../security/pathGuard.js";
import type { WorkspaceRoot } from "../../security/workspaceResolver.js";
import {
  getWorkspaceSymbols,
  listOpenDocuments,
  readProblems
} from "./editorTools.js";
import {
  getWorkspaceStatus,
  listWorkspaceEntries,
  readWorkspaceFile,
  searchWorkspaceText,
  statWorkspacePath,
  type WorkspaceToolLimits
} from "./workspaceTools.js";

type JsonObject = Record<string, unknown>;

export type ExternalMcpTool = {
  definition: Tool;
  invoke(input: JsonObject): Promise<CallToolResult>;
};

const JSON_OBJECT_SCHEMA = {
  type: "object",
  properties: {}
} as const;

const EXTERNAL_TOOLS: ExternalMcpTool[] = [
  {
    definition: {
      name: "vscode_workspace_status",
      description: "Show open workspace roots and non-sensitive external MCP access-policy status.",
      inputSchema: JSON_OBJECT_SCHEMA,
      _meta: { "vscodeOperator/nativeExternalTool": true }
    },
    invoke: async () => jsonResult(await getWorkspaceStatus({
      roots: getWorkspaceRoots(),
      workspaceTrusted: vscode.workspace.isTrusted,
      policyRelativePath: getPolicyRelativePath(),
      commandMode: getConfiguredCommandMode()
    }))
  },
  {
    definition: {
      name: "vscode_workspace_list_roots",
      description: "Compatibility alias for vscode_workspace_status root discovery.",
      inputSchema: JSON_OBJECT_SCHEMA,
      _meta: { "vscodeOperator/nativeExternalTool": true }
    },
    invoke: async () => jsonResult({
      roots: getWorkspaceRoots().map((root) => ({
        name: root.name,
        scheme: root.scheme,
        path: root.fsPath
      }))
    })
  },
  {
    definition: {
      name: "vscode_workspace_list_files",
      description: "List allowed files and folders under an open workspace root. Protected paths are omitted.",
      inputSchema: {
        type: "object",
        properties: {
          workspacePath: {
            type: "string",
            description: "Optional absolute path to an open workspace root. Required when multiple roots are ambiguous."
          },
          path: {
            type: "string",
            description: "Optional file or folder path to list from. Defaults to the workspace root."
          },
          pattern: {
            type: "string",
            description: "Optional glob pattern, default **/*."
          },
          recursive: {
            type: "boolean",
            description: "Whether to recurse into folders. Default true."
          },
          maxItems: {
            type: "number",
            description: "Maximum entries to return, default 200, hard cap 1000."
          }
        }
      },
      _meta: { "vscodeOperator/nativeExternalTool": true }
    },
    invoke: async (input) => invokeWithPolicyErrors(async () => listWorkspaceEntries({
      roots: getWorkspaceRoots(),
      workspacePath: input.workspacePath,
      path: input.path,
      pattern: input.pattern,
      recursive: input.recursive,
      maxItems: input.maxItems,
      policyRelativePath: getPolicyRelativePath()
    }))
  },
  {
    definition: {
      name: "vscode_workspace_stat",
      description: "Read metadata for an allowed workspace file or folder.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          workspacePath: {
            type: "string",
            description: "Optional absolute path to an open workspace root. Required when multiple roots are ambiguous."
          },
          path: {
            type: "string",
            description: "File or folder path to inspect."
          }
        }
      },
      _meta: { "vscodeOperator/nativeExternalTool": true }
    },
    invoke: async (input) => invokeWithPolicyErrors(async () => statWorkspacePath({
      roots: getWorkspaceRoots(),
      workspacePath: input.workspacePath,
      path: input.path,
      policyRelativePath: getPolicyRelativePath()
    }))
  },
  {
    definition: {
      name: "vscode_workspace_read_file",
      description: "Read an allowed workspace file with utf8 or base64 encoding. Protected paths are blocked.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          workspacePath: {
            type: "string",
            description: "Optional absolute path to an open workspace root. Required when multiple roots are ambiguous."
          },
          path: {
            type: "string",
            description: "File path to read."
          },
          encoding: {
            type: "string",
            enum: ["utf8", "base64"],
            description: "Output encoding. Default utf8."
          },
          maxBytes: {
            type: "number",
            description: "Maximum bytes to read. Capped by extension settings."
          }
        }
      },
      _meta: { "vscodeOperator/nativeExternalTool": true }
    },
    invoke: async (input) => invokeWithPolicyErrors(async () => readWorkspaceFile({
      roots: getWorkspaceRoots(),
      workspacePath: input.workspacePath,
      path: input.path,
      encoding: input.encoding,
      maxBytes: input.maxBytes,
      policyRelativePath: getPolicyRelativePath(),
      limits: getWorkspaceToolLimits()
    }))
  },
  {
    definition: {
      name: "vscode_workspace_search_text",
      description: "Search allowed workspace text files for a literal string. Protected paths and contents are omitted.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          workspacePath: {
            type: "string",
            description: "Optional absolute path to an open workspace root. Required when multiple roots are ambiguous."
          },
          query: {
            type: "string",
            description: "Literal text to search for. This is not a regular expression."
          },
          include: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } }
            ],
            description: "Optional include glob or comma-separated/list of globs. Default **/*."
          },
          exclude: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } }
            ],
            description: "Optional exclude glob or comma-separated/list of globs."
          },
          caseSensitive: {
            type: "boolean",
            description: "When true, match case exactly. Default false."
          },
          maxResults: {
            type: "number",
            description: "Maximum matches to return. Capped by extension settings."
          }
        }
      },
      _meta: { "vscodeOperator/nativeExternalTool": true }
    },
    invoke: async (input) => invokeWithPolicyErrors(async () => searchWorkspaceText({
      roots: getWorkspaceRoots(),
      workspacePath: input.workspacePath,
      query: input.query,
      include: input.include,
      exclude: input.exclude,
      caseSensitive: input.caseSensitive,
      maxResults: input.maxResults,
      policyRelativePath: getPolicyRelativePath(),
      limits: getWorkspaceToolLimits()
    }))
  },
  {
    definition: {
      name: "vscode_workspace_read_problems",
      description: "Read VS Code diagnostics for allowed workspace files only.",
      inputSchema: {
        type: "object",
        properties: {
          workspacePath: {
            type: "string",
            description: "Optional absolute path to an open workspace root. Required when multiple roots are ambiguous."
          },
          maxItems: {
            type: "number",
            description: "Maximum diagnostics to return, default 200, hard cap 500."
          },
          minSeverity: {
            type: "string",
            enum: ["error", "warning", "information", "hint"],
            description: "Minimum severity to include. Default warning."
          }
        }
      },
      _meta: { "vscodeOperator/nativeExternalTool": true }
    },
    invoke: async (input) => invokeWithPolicyErrors(async () => readProblems({
      roots: getWorkspaceRoots(),
      workspacePath: input.workspacePath,
      maxItems: input.maxItems,
      minSeverity: input.minSeverity,
      policyRelativePath: getPolicyRelativePath()
    }))
  },
  {
    definition: {
      name: "vscode_editor_list_open_documents",
      description: "List open VS Code text documents that are allowed by the external MCP policy.",
      inputSchema: {
        type: "object",
        properties: {
          workspacePath: {
            type: "string",
            description: "Optional absolute path to an open workspace root."
          }
        }
      },
      _meta: { "vscodeOperator/nativeExternalTool": true }
    },
    invoke: async (input) => invokeWithPolicyErrors(async () => listOpenDocuments({
      roots: getWorkspaceRoots(),
      workspacePath: input.workspacePath,
      policyRelativePath: getPolicyRelativePath()
    }))
  },
  {
    definition: {
      name: "vscode_workspace_get_symbols",
      description: "Read document symbols for an allowed workspace file.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          workspacePath: {
            type: "string",
            description: "Optional absolute path to an open workspace root."
          },
          path: {
            type: "string",
            description: "File path to inspect."
          }
        }
      },
      _meta: { "vscodeOperator/nativeExternalTool": true }
    },
    invoke: async (input) => invokeWithPolicyErrors(async () => getWorkspaceSymbols({
      roots: getWorkspaceRoots(),
      workspacePath: input.workspacePath,
      path: input.path,
      policyRelativePath: getPolicyRelativePath()
    }))
  }
];

const TOOL_BY_NAME = new Map(EXTERNAL_TOOLS.map((tool) => [tool.definition.name, tool]));

export function getNativeExternalTools(): Tool[] {
  if (!isExternalMcpEnabled()) {
    return [];
  }

  return EXTERNAL_TOOLS.map((tool) => tool.definition);
}

export async function invokeNativeExternalTool(name: string, input: JsonObject): Promise<CallToolResult | undefined> {
  if (!isExternalMcpEnabled()) {
    return undefined;
  }

  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    return undefined;
  }

  return tool.invoke(input);
}

export async function getPolicyStatusForRoots(): Promise<Record<string, unknown>[]> {
  const policyRelativePath = getPolicyRelativePath();
  const statuses = [];
  for (const root of getWorkspaceRoots()) {
    const policy = await loadAccessPolicy(root.fsPath, policyRelativePath);
    statuses.push({
      root: root.fsPath,
      policy: getAccessPolicyStatus(policy)
    });
  }
  return statuses;
}

function getWorkspaceRoots(): WorkspaceRoot[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    scheme: folder.uri.scheme,
    fsPath: folder.uri.fsPath
  }));
}

function getPolicyRelativePath(): string {
  return vscode.workspace
    .getConfiguration("vscodeOperator.externalMcp")
    .get<string>("policyFile", DEFAULT_POLICY_RELATIVE_PATH);
}

function isExternalMcpEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("vscodeOperator.externalMcp")
    .get<boolean>("enabled", true);
}

function getConfiguredCommandMode(): string {
  return vscode.workspace
    .getConfiguration("vscodeOperator.externalMcp")
    .get<string>("commandMode", "sandboxed");
}

function getWorkspaceToolLimits(): WorkspaceToolLimits {
  const config = vscode.workspace.getConfiguration("vscodeOperator.externalMcp");
  return {
    maxReadBytes: config.get<number>("maxReadBytes", 5 * 1024 * 1024),
    maxSearchResults: config.get<number>("maxSearchResults", 500)
  };
}

async function invokeWithPolicyErrors(operation: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return jsonResult(await operation());
  } catch (error) {
    return errorResult(externalAccessErrorPayload(error));
  }
}

function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload
  };
}

function errorResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload,
    isError: true
  };
}
