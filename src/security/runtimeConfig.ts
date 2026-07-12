import * as vscode from "vscode";
import { DEFAULT_POLICY_RELATIVE_PATH } from "./accessPolicy.js";
import type { WorkspaceRoot } from "./workspaceResolver.js";

/**
 * Shared by both the external MCP bridge and internal write/execute LM tools so
 * every entry point resolves the same open workspace roots and the same
 * protected-path policy file.
 */
export function getOpenWorkspaceRoots(): WorkspaceRoot[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    scheme: folder.uri.scheme,
    fsPath: folder.uri.fsPath
  }));
}

export function getConfiguredPolicyRelativePath(): string {
  return vscode.workspace
    .getConfiguration("vscodeOperator.externalMcp")
    .get<string>("policyFile", DEFAULT_POLICY_RELATIVE_PATH);
}
