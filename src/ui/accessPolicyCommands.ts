import * as vscode from "vscode";
import {
  DEFAULT_POLICY_RELATIVE_PATH,
  addDenyRule,
  ensureAccessPolicyFile,
  getAccessPolicyStatus,
  loadAccessPolicy,
  removeDenyRule
} from "../security/accessPolicy.js";
import { isPathInsideOrEqual, toWorkspaceRelative } from "../security/workspaceResolver.js";

export function registerAccessPolicyCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeOperator.externalMcp.openAccessPolicy", openAccessPolicy),
    vscode.commands.registerCommand("vscodeOperator.externalMcp.protectSelectedExplorerItem", protectSelectedExplorerItem),
    vscode.commands.registerCommand("vscodeOperator.externalMcp.removeProtectionFromSelectedExplorerItem", removeProtectionFromSelectedExplorerItem),
    vscode.commands.registerCommand("vscodeOperator.externalMcp.showAccessStatus", showAccessStatus),
    vscode.commands.registerCommand("vscodeOperator.externalMcp.setCommandMode", setCommandMode)
  );
}

async function openAccessPolicy(uri?: vscode.Uri): Promise<void> {
  const folder = resolveWorkspaceFolderForUri(uri);
  if (!folder) {
    await vscode.window.showWarningMessage("Open a workspace folder before editing the VSCode Operator external MCP access policy.");
    return;
  }

  const filePath = await ensureAccessPolicyFile(folder.uri.fsPath, getPolicyRelativePath());
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document);
}

async function protectSelectedExplorerItem(uri?: vscode.Uri): Promise<void> {
  const target = resolveWorkspaceRelativeTarget(uri);
  if (!target) {
    await vscode.window.showWarningMessage("Select a file or folder inside an open workspace to protect from external MCP.");
    return;
  }

  const pattern = await patternForTarget(target);
  await addDenyRule(target.workspaceRoot, pattern, getPolicyRelativePath());
  await vscode.window.showInformationMessage("Selected path is now protected from external MCP.");
}

async function removeProtectionFromSelectedExplorerItem(uri?: vscode.Uri): Promise<void> {
  const target = resolveWorkspaceRelativeTarget(uri);
  if (!target) {
    await vscode.window.showWarningMessage("Select a file or folder inside an open workspace to remove external MCP protection.");
    return;
  }

  const pattern = await patternForTarget(target);
  const removed = await removeDenyRule(target.workspaceRoot, pattern, getPolicyRelativePath());
  await vscode.window.showInformationMessage(
    removed
      ? "Selected path protection was removed from the external MCP policy."
      : "No matching protection rule was found for the selected path."
  );
}

async function showAccessStatus(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    await vscode.window.showInformationMessage("VSCode Operator external MCP access: no workspace folders are open.");
    return;
  }

  const lines = [
    `Workspace trusted: ${vscode.workspace.isTrusted ? "yes" : "no"}`,
    `Policy file: ${getPolicyRelativePath()}`,
    `Configured command mode: ${getConfiguredCommandMode()}`
  ];

  for (const folder of folders) {
    const policy = await loadAccessPolicy(folder.uri.fsPath, getPolicyRelativePath());
    const status = getAccessPolicyStatus(policy);
    lines.push([
      "",
      `Workspace: ${folder.name}`,
      `Policy loaded: ${status.loaded ? "yes" : "no"}`,
      `Policy valid: ${status.valid ? "yes" : "no"}`,
      `Default access: ${status.defaultAccess}`,
      `Deny rules: ${status.denyRuleCount}`,
      `Read-only rules: ${status.readOnlyRuleCount}`,
      `Policy command mode: ${status.commandMode}`
    ].join("\n"));
  }

  await vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
}

async function setCommandMode(): Promise<void> {
  const mode = await vscode.window.showQuickPick(
    [
      { label: "off", description: "No external command execution." },
      { label: "sandboxed", description: "Commands run in a sanitized workspace view when command tools are implemented." },
      { label: "trusted", description: "Direct host commands; refused when protected/read-only rules exist." }
    ],
    { title: "Set VSCode Operator External MCP Command Mode" }
  );

  if (!mode) {
    return;
  }

  if (mode.label === "trusted" && await hasUserProtectionRules()) {
    await vscode.window.showWarningMessage("Trusted command mode is not available while deny or read-only policy rules exist.");
    return;
  }

  await vscode.workspace
    .getConfiguration("vscodeOperator.externalMcp")
    .update("commandMode", mode.label, vscode.ConfigurationTarget.Workspace);
  await vscode.window.showInformationMessage(`External MCP command mode set to ${mode.label}.`);
}

function resolveWorkspaceFolderForUri(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  if (uri) {
    return vscode.workspace.getWorkspaceFolder(uri);
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    return vscode.workspace.getWorkspaceFolder(activeUri);
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length === 1 ? folders[0] : undefined;
}

function resolveWorkspaceRelativeTarget(uri?: vscode.Uri): { workspaceRoot: string; relativePath: string; absolutePath: string } | undefined {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri || targetUri.scheme !== "file") {
    return undefined;
  }

  const folder = vscode.workspace.getWorkspaceFolder(targetUri);
  if (!folder) {
    return undefined;
  }

  const workspaceRoot = folder.uri.fsPath;
  const absolutePath = targetUri.fsPath;
  if (!isPathInsideOrEqual(workspaceRoot, absolutePath)) {
    return undefined;
  }

  return {
    workspaceRoot,
    absolutePath,
    relativePath: toWorkspaceRelative(workspaceRoot, absolutePath)
  };
}

async function patternForTarget(target: { relativePath: string; absolutePath: string }): Promise<string> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(target.absolutePath));
    if (stat.type & vscode.FileType.Directory) {
      return `${target.relativePath.replace(/\/$/, "")}/**`;
    }
  } catch {
    // Fall through to exact file-style rule.
  }

  return target.relativePath;
}

async function hasUserProtectionRules(): Promise<boolean> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const policy = await loadAccessPolicy(folder.uri.fsPath, getPolicyRelativePath());
    if (policy.deny.length > 0 || policy.readOnly.length > 0) {
      return true;
    }
  }

  return false;
}

function getPolicyRelativePath(): string {
  return vscode.workspace
    .getConfiguration("vscodeOperator.externalMcp")
    .get<string>("policyFile", DEFAULT_POLICY_RELATIVE_PATH);
}

function getConfiguredCommandMode(): string {
  return vscode.workspace
    .getConfiguration("vscodeOperator.externalMcp")
    .get<string>("commandMode", "sandboxed");
}
