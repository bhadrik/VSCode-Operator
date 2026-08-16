import * as path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface BridgeRegistration {
  workspacePath: string;
  host: string;
  port: number;
}

export const PROXY_WORKSPACE_STATUS_TOOL: Tool = {
  name: "vscode_workspace_status",
  description: "List every workspace bridge currently registered with the VSCode Operator proxy.",
  inputSchema: {
    type: "object",
    properties: {}
  },
  _meta: {
    "vscodeOperator/proxyOwned": true
  }
};

export type ProxyWorkspaceStatus = {
  workspaces: Array<{ workspacePath: string }>;
  count: number;
};

export type BridgeRouteSource = "workspacePath" | "session" | "single-workspace";

export type BridgeRoute = {
  bridge: BridgeRegistration;
  source: BridgeRouteSource;
};

export class ProxyRoutingError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
    this.name = "ProxyRoutingError";
  }
}

export function normalizeWorkspacePathForCompare(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Preserve the raw value for a useful registered-workspace error.
  }

  const trimmed = decoded.trim();
  if (/^[a-zA-Z]:/.test(trimmed)) {
    // Windows path compare: case-insensitive + slash-insensitive.
    return path.win32.normalize(trimmed.replace(/\//g, "\\")).toLowerCase();
  }

  return path.posix.normalize(trimmed.replace(/\\/g, "/"));
}

export function findBridgeByWorkspacePath(
  bridges: Iterable<BridgeRegistration>,
  workspacePath: string
): BridgeRegistration | undefined {
  const normalizedInput = normalizeWorkspacePathForCompare(workspacePath);
  for (const bridge of bridges) {
    if (normalizeWorkspacePathForCompare(bridge.workspacePath) === normalizedInput) {
      return bridge;
    }
  }

  return undefined;
}

export function getRegisteredBridges(bridges: Iterable<BridgeRegistration>): BridgeRegistration[] {
  return [...bridges].sort((a, b) => a.workspacePath.localeCompare(b.workspacePath));
}

export function buildWorkspaceStatus(bridges: Iterable<BridgeRegistration>): ProxyWorkspaceStatus {
  const workspaces = getRegisteredBridges(bridges).map((bridge) => ({
    workspacePath: bridge.workspacePath
  }));

  return {
    workspaces,
    count: workspaces.length
  };
}

export function selectWorkspaceBridge(options: {
  bridges: Iterable<BridgeRegistration>;
  workspacePath?: string | null;
  sessionWorkspacePath?: string | null;
}): BridgeRoute {
  const bridges = [...options.bridges];

  if (options.workspacePath) {
    const bridge = findBridgeByWorkspacePath(bridges, options.workspacePath);
    if (!bridge) {
      throw new ProxyRoutingError(
        -32602,
        `No bridge is registered for workspacePath: ${options.workspacePath}. Call vscode_workspace_status to list registered workspaces.`
      );
    }
    return { bridge, source: "workspacePath" };
  }

  if (options.sessionWorkspacePath) {
    const bridge = findBridgeByWorkspacePath(bridges, options.sessionWorkspacePath);
    if (bridge) {
      return { bridge, source: "session" };
    }
  }

  if (bridges.length === 1) {
    return { bridge: bridges[0], source: "single-workspace" };
  }

  if (bridges.length === 0) {
    throw new ProxyRoutingError(
      -32000,
      "No VS Code workspace bridge is connected. Call vscode_workspace_status to inspect current registrations."
    );
  }

  throw new ProxyRoutingError(
    -32602,
    "Multiple workspaces are registered. Provide workspacePath in the tool arguments, resource URI query, or /mcp?workspacePath=<absolute-path>."
  );
}

/**
 * Some HTTP MCP dispatchers make a new local HTTP request for every JSON-RPC
 * message but fail to replay the mcp-session-id header after initialize. Keep
 * this fallback deliberately narrow: use the session associated with the same
 * peer when possible, otherwise only use the sole live proxy session.
 */
export function selectHeaderlessProxySession<T>(
  sessions: ReadonlyMap<string, T>,
  peerSessionId?: string
): string | undefined {
  if (peerSessionId && sessions.has(peerSessionId)) {
    return peerSessionId;
  }

  if (sessions.size !== 1) {
    return undefined;
  }

  return sessions.keys().next().value;
}

export function mergeProxyToolCatalogs(catalogs: Iterable<readonly Tool[]>): Tool[] {
  const toolsByName = new Map<string, Tool>();

  for (const catalog of catalogs) {
    for (const tool of catalog) {
      if (!tool || typeof tool.name !== "string" || tool.name === "vscode_workspace_status") {
        continue;
      }
      toolsByName.set(tool.name, toolsByName.get(tool.name) ?? tool);
    }
  }

  toolsByName.set(PROXY_WORKSPACE_STATUS_TOOL.name, PROXY_WORKSPACE_STATUS_TOOL);
  return [...toolsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
