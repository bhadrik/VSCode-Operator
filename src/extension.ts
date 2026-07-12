import * as vscode from "vscode";
import {
  ActiveEditorSummaryTool,
  ApplyTextEditsTool,
  CompletionAtTool,
  CreateDirectoryTool,
  DebugClearBreakpointsTool,
  DebugControlTool,
  DebugGetExceptionInfoTool,
  DebugEvaluateTool,
  DebugGetScopesTool,
  DebugSnapshotTool,
  DebugGetStackTraceTool,
  DebugGetTopFrameTool,
  DebugGetThreadsTool,
  DebugGetVariablesTool,
  DebugSetBreakpointsTool,
  DebugStartTool,
  DebugStatusTool,
  DeleteFileTool,
  ExecuteCommandTool,
  HoverAtPositionTool,
  HoverTopVisibleTool,
  ListProcessesTool,
  MovePathTool,
  ProcessRegistry,
  ReadFileTool,
  ReadProblemsTool,
  ReadProcessOutputTool,
  RunCommandTool,
  SaveAllDocumentsTool,
  SaveDocumentTool,
  StartBackgroundProcessTool,
  StopProcessTool,
  WriteFileTool
} from "./features";
import { LmToolsMcpBridgeServer } from "./mcp/bridgeServer";
import { McpProxyServer } from "./mcp/proxyServer";
import { registerAccessPolicyCommands } from "./ui/accessPolicyCommands.js";

export function activate(context: vscode.ExtensionContext): void {
  const mcpProxy = new McpProxyServer();
  const mcpBridge = new LmToolsMcpBridgeServer();
  const processRegistry = new ProcessRegistry();

  registerAccessPolicyCommands(context);

  context.subscriptions.push(
    mcpProxy,
    mcpBridge,
    processRegistry,
    vscode.lm.registerTool("vscodeOperator_readProblems", new ReadProblemsTool()),
    vscode.lm.registerTool("vscodeOperator_activeEditorSummary", new ActiveEditorSummaryTool()),
    vscode.lm.registerTool("vscodeOperator_hoverTopVisible", new HoverTopVisibleTool()),
    vscode.lm.registerTool("vscodeOperator_hoverAtPosition", new HoverAtPositionTool()),
    vscode.lm.registerTool("vscodeOperator_completionAt", new CompletionAtTool()),
    vscode.lm.registerTool("vscodeOperator_debugStart", new DebugStartTool()),
    vscode.lm.registerTool("vscodeOperator_debugSetBreakpoints", new DebugSetBreakpointsTool()),
    vscode.lm.registerTool("vscodeOperator_debugClearBreakpoints", new DebugClearBreakpointsTool()),
    vscode.lm.registerTool("vscodeOperator_debugControl", new DebugControlTool()),
    vscode.lm.registerTool("vscodeOperator_debugGetThreads", new DebugGetThreadsTool()),
    vscode.lm.registerTool("vscodeOperator_debugGetTopFrame", new DebugGetTopFrameTool()),
    vscode.lm.registerTool("vscodeOperator_debugSnapshot", new DebugSnapshotTool()),
    vscode.lm.registerTool("vscodeOperator_debugGetExceptionInfo", new DebugGetExceptionInfoTool()),
    vscode.lm.registerTool("vscodeOperator_debugGetStackTrace", new DebugGetStackTraceTool()),
    vscode.lm.registerTool("vscodeOperator_debugGetScopes", new DebugGetScopesTool()),
    vscode.lm.registerTool("vscodeOperator_debugGetVariables", new DebugGetVariablesTool()),
    vscode.lm.registerTool("vscodeOperator_debugEvaluate", new DebugEvaluateTool()),
    vscode.lm.registerTool("vscodeOperator_debugStatus", new DebugStatusTool()),
    vscode.lm.registerTool("vscodeOperator_executeCommand", new ExecuteCommandTool()),
    vscode.lm.registerTool("vscodeOperator_readFile", new ReadFileTool()),
    vscode.lm.registerTool("vscodeOperator_writeFile", new WriteFileTool()),
    vscode.lm.registerTool("vscodeOperator_applyTextEdits", new ApplyTextEditsTool()),
    vscode.lm.registerTool("vscodeOperator_deleteFile", new DeleteFileTool()),
    vscode.lm.registerTool("vscodeOperator_createDirectory", new CreateDirectoryTool()),
    vscode.lm.registerTool("vscodeOperator_movePath", new MovePathTool()),
    vscode.lm.registerTool("vscodeOperator_saveDocument", new SaveDocumentTool()),
    vscode.lm.registerTool("vscodeOperator_saveAllDocuments", new SaveAllDocumentsTool()),
    vscode.lm.registerTool("vscodeOperator_runCommand", new RunCommandTool()),
    vscode.lm.registerTool("vscodeOperator_startBackgroundProcess", new StartBackgroundProcessTool(processRegistry)),
    vscode.lm.registerTool("vscodeOperator_readProcessOutput", new ReadProcessOutputTool(processRegistry)),
    vscode.lm.registerTool("vscodeOperator_stopProcess", new StopProcessTool(processRegistry)),
    vscode.lm.registerTool("vscodeOperator_listProcesses", new ListProcessesTool(processRegistry)),
    vscode.commands.registerCommand("vscodeOperator.mcpBridge.showStatus", async () => {
      await vscode.window.showInformationMessage(mcpBridge.getStatus());
    }),
    vscode.commands.registerCommand("vscodeOperator.mcpBridge.restart", async () => {
      await mcpBridge.restart();
      await vscode.window.showInformationMessage(mcpBridge.getStatus());
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("vscodeOperator.mcpBridge")) {
        void mcpBridge.reloadFromConfiguration();
      }
    })
  );

  // Start proxy first (if port is occupied another instance is acting as proxy, that's OK),
  // then always start the bridge regardless of proxy outcome.
  void mcpProxy.start().finally(() => mcpBridge.start());
}

export function deactivate(): void {
  // No long-running resources to dispose.
}
