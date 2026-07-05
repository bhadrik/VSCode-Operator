import * as vscode from "vscode";
import { requireAuthorizedPath } from "../../security/pathGuard.js";
import type { WorkspaceRoot } from "../../security/workspaceResolver.js";

export async function listOpenDocuments(options: {
  roots: readonly WorkspaceRoot[];
  workspacePath?: unknown;
  policyRelativePath: string;
}): Promise<Record<string, unknown>> {
  const documents = [];
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== "file") {
      continue;
    }

    try {
      const decision = await requireAuthorizedPath({
        roots: options.roots,
        workspacePath: options.workspacePath,
        operation: "read",
        targetPath: document.uri.fsPath,
        policyRelativePath: options.policyRelativePath
      });
      documents.push({
        path: decision.relativePath,
        languageId: document.languageId,
        isDirty: document.isDirty,
        lineCount: document.lineCount
      });
    } catch {
      // Protected or out-of-workspace documents are intentionally hidden.
    }
  }

  return {
    count: documents.length,
    documents
  };
}

export async function readProblems(options: {
  roots: readonly WorkspaceRoot[];
  workspacePath?: unknown;
  maxItems?: unknown;
  minSeverity?: unknown;
  policyRelativePath: string;
}): Promise<Record<string, unknown>> {
  const maxItems = normalizePositiveInteger(options.maxItems, 200, 500, "maxItems");
  const minSeverity = normalizeSeverity(options.minSeverity);
  const minRank = SEVERITY_RANK[minSeverity];
  const diagnostics = [];

  for (const [uri, uriDiagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file") {
      continue;
    }

    let relativePath = "";
    try {
      const decision = await requireAuthorizedPath({
        roots: options.roots,
        workspacePath: options.workspacePath,
        operation: "read",
        targetPath: uri.fsPath,
        policyRelativePath: options.policyRelativePath
      });
      relativePath = decision.relativePath;
    } catch {
      continue;
    }

    for (const diagnostic of uriDiagnostics) {
      const severity = toSeverity(diagnostic.severity);
      if (SEVERITY_RANK[severity] < minRank) {
        continue;
      }

      diagnostics.push({
        file: relativePath,
        severity,
        message: diagnostic.message,
        source: diagnostic.source,
        code: diagnosticCodeToString(diagnostic.code),
        startLine: diagnostic.range.start.line + 1,
        startColumn: diagnostic.range.start.character + 1,
        endLine: diagnostic.range.end.line + 1,
        endColumn: diagnostic.range.end.character + 1
      });

      if (diagnostics.length >= maxItems) {
        return {
          filter: { minSeverity },
          count: diagnostics.length,
          truncated: true,
          problems: diagnostics
        };
      }
    }
  }

  return {
    filter: { minSeverity },
    count: diagnostics.length,
    truncated: false,
    problems: diagnostics
  };
}

export async function getWorkspaceSymbols(options: {
  roots: readonly WorkspaceRoot[];
  workspacePath?: unknown;
  path?: unknown;
  policyRelativePath: string;
}): Promise<Record<string, unknown>> {
  if (typeof options.path !== "string" || options.path.trim().length === 0) {
    throw new Error("path must be a non-empty string.");
  }

  const decision = await requireAuthorizedPath({
    roots: options.roots,
    workspacePath: options.workspacePath,
    operation: "read",
    targetPath: options.path,
    policyRelativePath: options.policyRelativePath
  });
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(decision.requestedPath));
  const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
    "vscode.executeDocumentSymbolProvider",
    document.uri
  );

  return {
    path: decision.relativePath,
    symbols: (symbols ?? []).map(symbolToPayload)
  };
}

type SeverityName = "error" | "warning" | "information" | "hint";

const SEVERITY_RANK: Record<SeverityName, number> = {
  error: 4,
  warning: 3,
  information: 2,
  hint: 1
};

function normalizeSeverity(value: unknown): SeverityName {
  if (typeof value !== "string") {
    return "warning";
  }

  switch (value.trim().toLowerCase()) {
    case "error":
      return "error";
    case "warning":
    case "warn":
      return "warning";
    case "information":
    case "info":
      return "information";
    case "hint":
      return "hint";
    default:
      return "warning";
  }
}

function toSeverity(severity: vscode.DiagnosticSeverity): SeverityName {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    default:
      return "hint";
  }
}

function diagnosticCodeToString(code: vscode.Diagnostic["code"]): string | undefined {
  if (code === undefined) {
    return undefined;
  }

  if (typeof code === "string" || typeof code === "number") {
    return String(code);
  }

  return String(code.value);
}

function symbolToPayload(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): Record<string, unknown> {
  if (symbol instanceof vscode.SymbolInformation) {
    return {
      name: symbol.name,
      kind: vscode.SymbolKind[symbol.kind],
      containerName: symbol.containerName,
      range: rangeToPayload(symbol.location.range)
    };
  }

  return {
    name: symbol.name,
    detail: symbol.detail,
    kind: vscode.SymbolKind[symbol.kind],
    range: rangeToPayload(symbol.range),
    selectionRange: rangeToPayload(symbol.selectionRange),
    children: symbol.children.map(symbolToPayload)
  };
}

function rangeToPayload(range: vscode.Range): Record<string, number> {
  return {
    startLine: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1
  };
}

function normalizePositiveInteger(value: unknown, defaultValue: number, hardMax: number, fieldName: string): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${fieldName} must be an integer >= 1.`);
  }

  return Math.min(value as number, hardMax);
}
