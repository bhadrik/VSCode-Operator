import type { AccessDeniedError, AccessDeniedReason } from "../security/pathGuard.js";

const REASON_TEXT: Record<AccessDeniedReason, string> = {
  "outside-workspace": "the target path is outside the open workspace",
  protected: "the target path is protected by the access policy (deny rule)",
  "read-only": "the target path is marked read-only by the access policy",
  "invalid-path": "the target path is invalid",
  "not-found": "the target path does not exist"
};

export function formatAccessDeniedMessage(toolName: string, error: AccessDeniedError): string {
  return `${toolName} was blocked: ${REASON_TEXT[error.reason] ?? error.reason}.`;
}

export function escapeMarkdownInline(value: string): string {
  return value.replace(/[`*_{}[\]()#+\-.!\\]/g, "\\$&");
}
