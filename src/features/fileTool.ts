import * as path from "node:path";
import * as vscode from "vscode";
import { AccessDeniedError, requireAuthorizedPath } from "../security/pathGuard.js";
import { getConfiguredPolicyRelativePath, getOpenWorkspaceRoots } from "../security/runtimeConfig.js";
import { escapeMarkdownInline, formatAccessDeniedMessage } from "./toolErrors.js";

const DEFAULT_READ_MAX_BYTES = 200_000;
const READ_HARD_MAX_BYTES = 1_000_000;

type ReadFileToolInput = {
  path: string;
  workspacePath?: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
};

type WriteFileToolInput = {
  path: string;
  content: string;
  workspacePath?: string;
  createParents?: boolean;
  overwrite?: boolean;
  overwriteDirty?: boolean;
};

type TextEditInput = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newText: string;
};

type ApplyTextEditsToolInput = {
  path: string;
  workspacePath?: string;
  edits: TextEditInput[];
};

type DeleteFileToolInput = {
  path: string;
  workspacePath?: string;
  recursive?: boolean;
  permanent?: boolean;
};

type CreateDirectoryToolInput = {
  path: string;
  workspacePath?: string;
};

type MovePathToolInput = {
  sourcePath: string;
  targetPath: string;
  workspacePath?: string;
  overwrite?: boolean;
};

type SaveDocumentToolInput = {
  path: string;
  workspacePath?: string;
};

type SaveAllDocumentsToolInput = Record<string, never>;

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function jsonResult(value: unknown): vscode.LanguageModelToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

type AuthorizedTarget = Awaited<ReturnType<typeof requireAuthorizedPath>>;

async function authorizeOrExplain(
  toolName: string,
  options: Parameters<typeof requireAuthorizedPath>[0]
): Promise<{ decision: AuthorizedTarget; message?: undefined } | { decision?: undefined; message: string }> {
  try {
    return { decision: await requireAuthorizedPath(options) };
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return { message: formatAccessDeniedMessage(toolName, error) };
    }
    throw error;
  }
}

function clampMaxBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_READ_MAX_BYTES;
  }
  return Math.min(Math.floor(value), READ_HARD_MAX_BYTES);
}

function clampLine(value: number, lineCount: number): number {
  const n = Number.isInteger(value) ? value : Math.floor(value);
  return Math.max(1, Math.min(n, Math.max(1, lineCount)));
}

function truncateToBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return text;
  }
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n... (truncated)`;
}

function validateTextEdit(edit: TextEditInput): string | undefined {
  if (!Number.isInteger(edit.startLine) || edit.startLine < 1) return "startLine must be an integer >= 1.";
  if (!Number.isInteger(edit.endLine) || edit.endLine < 1) return "endLine must be an integer >= 1.";
  if (!Number.isInteger(edit.startColumn) || edit.startColumn < 1) return "startColumn must be an integer >= 1.";
  if (!Number.isInteger(edit.endColumn) || edit.endColumn < 1) return "endColumn must be an integer >= 1.";
  if (typeof edit.newText !== "string") return "newText must be a string.";
  return undefined;
}

export class ReadFileTool implements vscode.LanguageModelTool<ReadFileToolInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ReadFileToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      return textResult("vscodeOperator_readFile requires a non-empty 'path'.");
    }

    const authorized = await authorizeOrExplain("vscodeOperator_readFile", {
      roots: getOpenWorkspaceRoots(),
      workspacePath: input.workspacePath,
      operation: "read",
      targetPath: input.path,
      mustExist: true,
      policyRelativePath: getConfiguredPolicyRelativePath()
    });
    if (!authorized.decision) {
      return textResult(authorized.message);
    }

    const uri = vscode.Uri.file(authorized.decision.requestedPath);
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (error) {
      return textResult(
        `Cannot read ${authorized.decision.relativePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const maxBytes = clampMaxBytes(input.maxBytes);
    let startLine = 1;
    let endLine = document.lineCount;
    let text: string;

    if (input.startLine !== undefined || input.endLine !== undefined) {
      startLine = clampLine(input.startLine ?? 1, document.lineCount);
      endLine = clampLine(input.endLine ?? document.lineCount, document.lineCount);
      if (endLine < startLine) {
        [startLine, endLine] = [endLine, startLine];
      }
      const range = new vscode.Range(startLine - 1, 0, endLine - 1, document.lineAt(endLine - 1).text.length);
      text = document.getText(range);
    } else {
      text = document.getText();
    }

    const truncated = Buffer.byteLength(text, "utf8") > maxBytes;
    if (truncated) {
      text = truncateToBytes(text, maxBytes);
    }

    return jsonResult({
      path: authorized.decision.relativePath,
      startLine,
      endLine,
      totalLines: document.lineCount,
      isDirty: document.isDirty,
      truncated,
      content: text
    });
  }
}

export class WriteFileTool implements vscode.LanguageModelTool<WriteFileToolInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<WriteFileToolInput>
  ): Promise<vscode.PreparedToolInvocation> {
    const targetPath = options.input.path ?? "";
    return {
      invocationMessage: `Writing ${targetPath}`,
      confirmationMessages: {
        title: "Write File",
        message: new vscode.MarkdownString(`Allow writing to \`${escapeMarkdownInline(targetPath)}\`?`)
      }
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<WriteFileToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      return textResult("vscodeOperator_writeFile requires a non-empty 'path'.");
    }
    if (typeof input.content !== "string") {
      return textResult("vscodeOperator_writeFile requires 'content' to be a string.");
    }

    const authorized = await authorizeOrExplain("vscodeOperator_writeFile", {
      roots: getOpenWorkspaceRoots(),
      workspacePath: input.workspacePath,
      operation: "write",
      targetPath: input.path,
      mustExist: false,
      policyRelativePath: getConfiguredPolicyRelativePath()
    });
    if (!authorized.decision) {
      return textResult(authorized.message);
    }

    const absolutePath = authorized.decision.requestedPath;
    const uri = vscode.Uri.file(absolutePath);

    let existed = true;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      existed = false;
    }

    if (existed && input.overwrite !== true) {
      return textResult(
        `vscodeOperator_writeFile: ${authorized.decision.relativePath} already exists. Pass overwrite:true to replace it.`
      );
    }

    const openDocument = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === absolutePath);
    if (openDocument?.isDirty && input.overwriteDirty !== true) {
      return textResult(
        `vscodeOperator_writeFile: ${authorized.decision.relativePath} has unsaved editor changes. Pass overwriteDirty:true to discard them, or save/revert first.`
      );
    }

    if (input.createParents !== false) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(absolutePath)));
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(input.content, "utf8"));

    return jsonResult({
      path: authorized.decision.relativePath,
      created: !existed,
      bytesWritten: Buffer.byteLength(input.content, "utf8")
    });
  }
}

export class ApplyTextEditsTool implements vscode.LanguageModelTool<ApplyTextEditsToolInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ApplyTextEditsToolInput>
  ): Promise<vscode.PreparedToolInvocation> {
    const targetPath = options.input.path ?? "";
    const count = Array.isArray(options.input.edits) ? options.input.edits.length : 0;
    return {
      invocationMessage: `Applying ${count} edit(s) to ${targetPath}`,
      confirmationMessages: {
        title: "Apply Text Edits",
        message: new vscode.MarkdownString(
          `Allow applying ${count} edit(s) to \`${escapeMarkdownInline(targetPath)}\`?`
        )
      }
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ApplyTextEditsToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      return textResult("vscodeOperator_applyTextEdits requires a non-empty 'path'.");
    }
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      return textResult("vscodeOperator_applyTextEdits requires a non-empty 'edits' array.");
    }

    const authorized = await authorizeOrExplain("vscodeOperator_applyTextEdits", {
      roots: getOpenWorkspaceRoots(),
      workspacePath: input.workspacePath,
      operation: "patch",
      targetPath: input.path,
      mustExist: true,
      policyRelativePath: getConfiguredPolicyRelativePath()
    });
    if (!authorized.decision) {
      return textResult(authorized.message);
    }

    const uri = vscode.Uri.file(authorized.decision.requestedPath);
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (error) {
      return textResult(
        `Cannot open ${authorized.decision.relativePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const [index, edit] of input.edits.entries()) {
      const validation = validateTextEdit(edit);
      if (validation) {
        return textResult(`vscodeOperator_applyTextEdits: edits[${index}] invalid: ${validation}`);
      }

      const range = new vscode.Range(
        clampLine(edit.startLine, document.lineCount) - 1,
        Math.max(0, Math.floor(edit.startColumn) - 1),
        clampLine(edit.endLine, document.lineCount) - 1,
        Math.max(0, Math.floor(edit.endColumn) - 1)
      );
      workspaceEdit.replace(uri, range, edit.newText);
    }

    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) {
      return textResult(`vscodeOperator_applyTextEdits: VS Code rejected the edit for ${authorized.decision.relativePath}.`);
    }

    return jsonResult({
      path: authorized.decision.relativePath,
      editsApplied: input.edits.length,
      isDirty: document.isDirty
    });
  }
}

export class DeleteFileTool implements vscode.LanguageModelTool<DeleteFileToolInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<DeleteFileToolInput>
  ): Promise<vscode.PreparedToolInvocation> {
    const targetPath = options.input.path ?? "";
    return {
      invocationMessage: `Deleting ${targetPath}`,
      confirmationMessages: {
        title: "Delete Path",
        message: new vscode.MarkdownString(`Allow deleting \`${escapeMarkdownInline(targetPath)}\`?`)
      }
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<DeleteFileToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      return textResult("vscodeOperator_deleteFile requires a non-empty 'path'.");
    }

    const authorized = await authorizeOrExplain("vscodeOperator_deleteFile", {
      roots: getOpenWorkspaceRoots(),
      workspacePath: input.workspacePath,
      operation: "delete",
      targetPath: input.path,
      mustExist: true,
      policyRelativePath: getConfiguredPolicyRelativePath()
    });
    if (!authorized.decision) {
      return textResult(authorized.message);
    }

    const uri = vscode.Uri.file(authorized.decision.requestedPath);
    const stillDirty = vscode.workspace.textDocuments.some(
      (doc) => doc.uri.fsPath === authorized.decision!.requestedPath && doc.isDirty
    );

    await vscode.workspace.fs.delete(uri, {
      recursive: input.recursive === true,
      useTrash: input.permanent !== true
    });

    return jsonResult({
      path: authorized.decision.relativePath,
      recursive: input.recursive === true,
      movedToTrash: input.permanent !== true,
      hadUnsavedOpenBuffer: stillDirty
    });
  }
}

export class CreateDirectoryTool implements vscode.LanguageModelTool<CreateDirectoryToolInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CreateDirectoryToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      return textResult("vscodeOperator_createDirectory requires a non-empty 'path'.");
    }

    const authorized = await authorizeOrExplain("vscodeOperator_createDirectory", {
      roots: getOpenWorkspaceRoots(),
      workspacePath: input.workspacePath,
      operation: "create",
      targetPath: input.path,
      mustExist: false,
      policyRelativePath: getConfiguredPolicyRelativePath()
    });
    if (!authorized.decision) {
      return textResult(authorized.message);
    }

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(authorized.decision.requestedPath));

    return jsonResult({ path: authorized.decision.relativePath, created: true });
  }
}

export class MovePathTool implements vscode.LanguageModelTool<MovePathToolInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<MovePathToolInput>
  ): Promise<vscode.PreparedToolInvocation> {
    const from = options.input.sourcePath ?? "";
    const to = options.input.targetPath ?? "";
    return {
      invocationMessage: `Moving ${from} to ${to}`,
      confirmationMessages: {
        title: "Move Or Rename Path",
        message: new vscode.MarkdownString(
          `Allow moving \`${escapeMarkdownInline(from)}\` to \`${escapeMarkdownInline(to)}\`?`
        )
      }
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<MovePathToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (typeof input.sourcePath !== "string" || input.sourcePath.trim().length === 0) {
      return textResult("vscodeOperator_movePath requires a non-empty 'sourcePath'.");
    }
    if (typeof input.targetPath !== "string" || input.targetPath.trim().length === 0) {
      return textResult("vscodeOperator_movePath requires a non-empty 'targetPath'.");
    }

    const sourceAuthorized = await authorizeOrExplain("vscodeOperator_movePath", {
      roots: getOpenWorkspaceRoots(),
      workspacePath: input.workspacePath,
      operation: "rename",
      targetPath: input.sourcePath,
      mustExist: true,
      policyRelativePath: getConfiguredPolicyRelativePath()
    });
    if (!sourceAuthorized.decision) {
      return textResult(sourceAuthorized.message);
    }

    const targetAuthorized = await authorizeOrExplain("vscodeOperator_movePath", {
      roots: getOpenWorkspaceRoots(),
      workspacePath: input.workspacePath,
      operation: "rename",
      targetPath: input.targetPath,
      mustExist: false,
      policyRelativePath: getConfiguredPolicyRelativePath()
    });
    if (!targetAuthorized.decision) {
      return textResult(targetAuthorized.message);
    }

    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(targetAuthorized.decision.requestedPath))
    );

    await vscode.workspace.fs.rename(
      vscode.Uri.file(sourceAuthorized.decision.requestedPath),
      vscode.Uri.file(targetAuthorized.decision.requestedPath),
      { overwrite: input.overwrite === true }
    );

    return jsonResult({
      from: sourceAuthorized.decision.relativePath,
      to: targetAuthorized.decision.relativePath
    });
  }
}

export class SaveDocumentTool implements vscode.LanguageModelTool<SaveDocumentToolInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SaveDocumentToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      return textResult("vscodeOperator_saveDocument requires a non-empty 'path'.");
    }

    const authorized = await authorizeOrExplain("vscodeOperator_saveDocument", {
      roots: getOpenWorkspaceRoots(),
      workspacePath: input.workspacePath,
      operation: "write",
      targetPath: input.path,
      mustExist: true,
      policyRelativePath: getConfiguredPolicyRelativePath()
    });
    if (!authorized.decision) {
      return textResult(authorized.message);
    }

    const document = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.fsPath === authorized.decision!.requestedPath
    );
    if (!document) {
      return textResult(
        `vscodeOperator_saveDocument: ${authorized.decision.relativePath} is not currently open in the editor.`
      );
    }

    const saved = await document.save();
    return jsonResult({ path: authorized.decision.relativePath, saved, isDirty: document.isDirty });
  }
}

export class SaveAllDocumentsTool implements vscode.LanguageModelTool<SaveAllDocumentsToolInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SaveAllDocumentsToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const unsupportedKeys = Object.keys(options.input as Record<string, unknown>);
    if (unsupportedKeys.length > 0) {
      return textResult(
        `vscodeOperator_saveAllDocuments: unsupported fields: ${unsupportedKeys.join(", ")}.`
      );
    }

    const saved = await vscode.workspace.saveAll(false);
    return jsonResult({ saved });
  }
}
