import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { createServer, request as httpRequest } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  isInitializeRequest,
  type CallToolResult,
  type ListResourcesResult,
  type ReadResourceResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import * as vscode from "vscode";
import {
  buildWorkspaceStatus,
  findBridgeByWorkspacePath,
  getRegisteredBridges,
  mergeProxyToolCatalogs,
  normalizeWorkspacePathForCompare,
  PROXY_WORKSPACE_STATUS_TOOL,
  ProxyRoutingError,
  selectHeaderlessProxySession,
  selectWorkspaceBridge,
  type BridgeRegistration
} from "./proxyRouting.js";

export type { BridgeRegistration } from "./proxyRouting.js";

type JsonObject = Record<string, unknown>;

type BridgeHttpResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
};

type ProxySession = {
  id?: string;
  transport?: StreamableHTTPServerTransport;
  protocolServer?: Server;
  initializeRequest: JsonObject;
  defaultWorkspacePath?: string;
  initialized: boolean;
  /** Registered workspace path → bridge-local MCP session ID (undefined for stateless bridges). */
  bridgeSessions: Map<string, string | undefined>;
};

const TOOLS_RESOURCE_URI = "vscode-operator://tools";
const TOOL_SCHEMA_RESOURCE_URI = "vscode-operator://tool-schema";
const USAGE_GUIDE_RESOURCE_URI = "vscode-operator://usage";

const PROXY_SERVER_INSTRUCTIONS = [
  "You are connected to the VSCode Operator MCP proxy.",
  "Call vscode_workspace_status first to discover registered workspacePath values.",
  "Provide workspacePath for workspace-specific tool calls whenever multiple workspaces are registered.",
  "The same MCP session can target different workspaces by passing an explicit workspacePath on each call.",
  "Use tools/list and vscode-operator://tool-schema to discover exact tool schemas.",
  "The proxy exposes no secrets; workspace status only lists registered workspace paths."
].join(" ");

const PROXY_USAGE_GUIDE_TEXT = [
  "VSCode Operator proxy usage guide:",
  "1) Call vscode_workspace_status to list registered workspace bridges.",
  "2) Select a returned workspacePath for workspace-specific tool calls when more than one workspace is registered.",
  "3) Call tools/list for the union of tools currently available from registered bridges.",
  "4) Query a tool schema using vscode-operator://tool-schema?name=<toolName>.",
  "5) Workspace-independent protocol operations (initialize, tools/list, resources/list, prompts/list) do not require workspacePath.",
  "6) One external MCP session may call tools in different workspaces; an explicit workspacePath overrides session affinity."
].join("\n");

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getSingleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function asMcpError(error: unknown): McpError {
  if (error instanceof McpError) {
    return error;
  }
  if (error instanceof ProxyRoutingError) {
    return new McpError(error.code, error.message);
  }
  return new McpError(
    ErrorCode.InternalError,
    error instanceof Error ? error.message : String(error)
  );
}

/**
 * The fixed-port, externally visible MCP server. Workspace bridges register here
 * and are used only as executors for workspace-specific requests.
 */
export class McpProxyServer implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("VSCode Operator Proxy");
  private httpServer: HttpServer | undefined;
  private readonly bridges = new Map<string, BridgeRegistration>();
  /** External proxy session ID → proxy-owned protocol/session state. */
  private readonly sessions = new Map<string, ProxySession>();
  /** Local peer → session for headerless dispatcher compatibility. */
  private readonly headerlessSessionIdsByPeer = new Map<string, string>();
  private lastError: string | undefined;

  private summarizeText(value: string, max = 1200): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "<empty>";
    }
    return normalized.length > max ? `${normalized.slice(0, max)} ...[truncated ${normalized.length - max} chars]` : normalized;
  }

  private shouldLogPayloadPreview(): boolean {
    return vscode.workspace
      .getConfiguration("vscodeOperator.mcpBridge")
      .inspect<boolean>("logPayloadPreview")
      ?.globalValue === true;
  }

  private safePreviewJsonBody(body: string): string {
    if (!body.trim()) {
      return "<empty>";
    }

    if (!this.shouldLogPayloadPreview()) {
      return this.safeRedactedJsonBody(body);
    }

    try {
      const parsed = JSON.parse(body);
      if (!isJsonObject(parsed)) {
        return this.summarizeText(body);
      }
      return this.summarizeText(JSON.stringify({
        jsonrpc: parsed.jsonrpc,
        id: parsed.id,
        method: parsed.method,
        params: parsed.params
      }));
    } catch {
      return this.summarizeText(body);
    }
  }

  private safeRedactedJsonBody(body: string): string {
    try {
      const parsed = JSON.parse(body);
      if (!isJsonObject(parsed)) {
        return "<redacted invalid-json payload>";
      }
      const params = isJsonObject(parsed.params) ? parsed.params : undefined;
      const argumentsValue = params?.arguments;
      const argumentKeys = isJsonObject(argumentsValue)
        ? Object.keys(argumentsValue).sort()
        : [];
      return this.summarizeText(JSON.stringify({
        jsonrpc: parsed.jsonrpc,
        id: parsed.id,
        method: parsed.method,
        tool: typeof params?.name === "string" ? params.name : undefined,
        argumentKeys: argumentKeys.length > 0 ? argumentKeys : undefined,
        redacted: true
      }));
    } catch {
      return "<redacted invalid-json payload>";
    }
  }

  private getMcpPath(): string {
    const configured = vscode.workspace
      .getConfiguration("vscodeOperator.mcpBridge")
      .get<string>("path", "/mcp")
      .trim();
    if (!configured) {
      return "/mcp";
    }
    return configured.startsWith("/") ? configured : `/${configured}`;
  }

  private findBridgeByWorkspacePath(workspacePath: string): BridgeRegistration | undefined {
    const direct = this.bridges.get(workspacePath);
    return direct ?? findBridgeByWorkspacePath(this.bridges.values(), workspacePath);
  }

  private getPeerKey(req: IncomingMessage): string | undefined {
    const address = req.socket.remoteAddress;
    const port = req.socket.remotePort;
    return address && port ? `${address}:${port}` : undefined;
  }

  private findHeaderlessSessionId(req: IncomingMessage): string | undefined {
    const peerKey = this.getPeerKey(req);
    const peerSessionId = peerKey ? this.headerlessSessionIdsByPeer.get(peerKey) : undefined;
    const sessionId = selectHeaderlessProxySession(this.sessions, peerSessionId);
    if (!sessionId && peerKey && peerSessionId) {
      this.headerlessSessionIdsByPeer.delete(peerKey);
    }
    return sessionId;
  }

  private rememberHeaderlessSession(req: IncomingMessage, sessionId: string): void {
    const peerKey = this.getPeerKey(req);
    if (peerKey) {
      this.headerlessSessionIdsByPeer.set(peerKey, sessionId);
    }
  }

  private injectMcpSessionHeader(req: IncomingMessage, sessionId: string): void {
    req.headers["mcp-session-id"] = sessionId;
    const headerIndex = req.rawHeaders.findIndex((header, index) => index % 2 === 0 && header.toLowerCase() === "mcp-session-id");
    if (headerIndex >= 0) {
      req.rawHeaders[headerIndex + 1] = sessionId;
      return;
    }
    req.rawHeaders.push("mcp-session-id", sessionId);
  }

  private extractWorkspacePathFromPayload(parsed: JsonObject, workspacePathFromUrl: string | null): string | null {
    const params = isJsonObject(parsed.params) ? parsed.params : undefined;
    const args = isJsonObject(params?.arguments) ? params.arguments : undefined;
    const fromFields = workspacePathFromUrl
      ?? (typeof args?.workspacePath === "string" ? args.workspacePath : null)
      ?? (typeof params?.workspacePath === "string" ? params.workspacePath : null)
      ?? (typeof parsed.workspacePath === "string" ? parsed.workspacePath : null);
    if (fromFields) {
      return fromFields;
    }

    const uriRaw = typeof params?.uri === "string" ? params.uri : null;
    if (uriRaw) {
      try {
        return new URL(uriRaw).searchParams.get("workspacePath");
      } catch {
        // Resource validation will report malformed URIs normally.
      }
    }
    return null;
  }

  async start(): Promise<void> {
    if (this.httpServer) {
      return;
    }

    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    server.on("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.appendLine(`HTTP server error: ${this.lastError}`);
      if (err.code !== "EADDRINUSE") {
        void vscode.window.showWarningMessage(`VSCode Operator Proxy failed: ${this.lastError}`);
      }
    });

    const proxyPort = vscode.workspace.getConfiguration("vscodeOperator.mcpBridge").get<number>("port", 19191);
    let bound = false;
    await new Promise<void>((resolve) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          this.appendLine(`MCP proxy port ${proxyPort} already in use, another instance is acting as proxy.`);
        } else {
          this.lastError = error.message;
          this.appendLine(`HTTP server error: ${this.lastError}`);
        }
        server.close();
        resolve();
      });
      server.listen(proxyPort, "127.0.0.1", () => {
        bound = true;
        resolve();
      });
    });

    if (!bound) {
      return;
    }

    this.httpServer = server;
    this.lastError = undefined;
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "<no-workspace>";
    this.appendLine(`Proxy elected: current instance became proxy (pid=${process.pid}, workspace=${workspace})`);
    this.appendLine(`MCP proxy listening on http://127.0.0.1:${proxyPort}${this.getMcpPath()}`);
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.disposeSession(sessionId)));
    this.bridges.clear();

    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.appendLine("MCP proxy stopped.");
  }

  dispose(): void {
    void this.stop();
    this.output.dispose();
  }

  private appendLine(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          workspaces: getRegisteredBridges(this.bridges.values()).map((bridge) => bridge.workspacePath)
        }));
        return;
      }

      if (req.method === "GET" && req.url?.startsWith("/bridge-channel")) {
        this.handleBridgeRegistration(req, res);
        return;
      }

      if (req.url) {
        const requestUrl = new URL(req.url, "http://127.0.0.1");
        if (requestUrl.pathname === this.getMcpPath()) {
          await this.handleMcpHttpRequest(req, res, requestUrl);
          return;
        }
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      this.writeMcpError(res, 500, ErrorCode.InternalError, error instanceof Error ? error.message : String(error), null);
    }
  }

  private handleBridgeRegistration(req: IncomingMessage, res: ServerResponse): void {
    const urlObj = new URL(req.url ?? "/bridge-channel", "http://127.0.0.1");
    const workspacePath = urlObj.searchParams.get("workspacePath");
    const host = urlObj.searchParams.get("host") ?? "127.0.0.1";
    const port = parseInt(urlObj.searchParams.get("port") ?? "0", 10);
    if (!workspacePath || !port) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "workspacePath and port are required" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    const registration: BridgeRegistration = { workspacePath, host, port };
    const existing = this.findBridgeByWorkspacePath(workspacePath);
    if (existing) {
      for (const session of this.sessions.values()) {
        session.bridgeSessions.delete(existing.workspacePath);
        if (session.defaultWorkspacePath
          && normalizeWorkspacePathForCompare(session.defaultWorkspacePath) === normalizeWorkspacePathForCompare(existing.workspacePath)) {
          session.defaultWorkspacePath = undefined;
        }
      }
    }
    this.bridges.set(workspacePath, registration);
    this.appendLine(`Bridge connected: ${workspacePath} at ${host}:${port} (bridges=${this.bridges.size})`);

    const pingInterval = setInterval(() => {
      try {
        res.write("data: ping\n\n");
      } catch {
        clearInterval(pingInterval);
      }
    }, 15_000);

    req.on("close", () => {
      clearInterval(pingInterval);
      if (this.bridges.get(workspacePath) !== registration) {
        return;
      }
      this.bridges.delete(workspacePath);
      let removedSessions = 0;
      for (const session of this.sessions.values()) {
        if (session.bridgeSessions.delete(registration.workspacePath)) {
          removedSessions++;
        }
        if (session.defaultWorkspacePath
          && normalizeWorkspacePathForCompare(session.defaultWorkspacePath) === normalizeWorkspacePathForCompare(registration.workspacePath)) {
          session.defaultWorkspacePath = undefined;
        }
      }
      this.appendLine(`Bridge disconnected: ${workspacePath} (removedSessions=${removedSessions}, bridges=${this.bridges.size})`);
    });
  }

  private async handleMcpHttpRequest(req: IncomingMessage, res: ServerResponse, requestUrl: URL): Promise<void> {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const suppliedSessionId = getSingleHeader(req.headers["mcp-session-id"]);
    const body = await this.readRequestBody(req);
    let parsed: unknown;
    try {
      parsed = body.trim() ? JSON.parse(body) : undefined;
    } catch {
      this.writeMcpError(res, 400, ErrorCode.ParseError, "Parse error: Invalid JSON", null);
      return;
    }

    let sessionId = suppliedSessionId;
    const parsedRequestId = isJsonObject(parsed) ? parsed.id : null;
    const rpcMethod = isJsonObject(parsed) && typeof parsed.method === "string" ? parsed.method : "<unknown>";
    this.appendLine(`[${requestId}] Incoming MCP ${req.method ?? "POST"} method=${rpcMethod} sessionId=${sessionId ?? "<none>"} queryWorkspace=${requestUrl.searchParams.get("workspacePath") ?? "<none>"} payload=${this.safePreviewJsonBody(body)}`);

    if (!sessionId && req.method === "POST" && isJsonObject(parsed) && !isInitializeRequest(parsed)) {
      sessionId = this.findHeaderlessSessionId(req);
      if (sessionId) {
        this.injectMcpSessionHeader(req, sessionId);
        this.appendLine(`[${requestId}] Reusing proxy session for headerless MCP request: ${sessionId}`);
      }
    }

    const existingSession = sessionId ? this.sessions.get(sessionId) : undefined;
    if (existingSession?.transport) {
      try {
        await existingSession.transport.handleRequest(req, res, parsed);
      } finally {
        if (req.method === "DELETE") {
          await this.disposeSession(sessionId!);
        }
      }
      return;
    }

    if (!sessionId && req.method === "POST" && isJsonObject(parsed) && isInitializeRequest(parsed)) {
      const requestedWorkspacePath = this.extractWorkspacePathFromPayload(parsed, requestUrl.searchParams.get("workspacePath"));
      let defaultWorkspacePath: string | undefined;
      if (requestedWorkspacePath) {
        const bridge = this.findBridgeByWorkspacePath(requestedWorkspacePath);
        if (!bridge) {
          this.writeMcpError(res, 400, ErrorCode.InvalidParams, `No bridge is registered for workspacePath: ${requestedWorkspacePath}. Call vscode_workspace_status after initialization to list registered workspaces.`, parsedRequestId);
          return;
        }
        defaultWorkspacePath = bridge.workspacePath;
      }

      const session = await this.createProxySession(parsed, defaultWorkspacePath);
      await session.transport!.handleRequest(req, res, parsed);
      if (session.id) {
        this.rememberHeaderlessSession(req, session.id);
      }
      return;
    }

    this.writeMcpError(
      res,
      sessionId ? 404 : 400,
      sessionId ? -32001 : ErrorCode.InvalidRequest,
      sessionId ? "Session not found or expired." : "Initialize the MCP session before making this request.",
      parsedRequestId
    );
  }

  private async createProxySession(initializeRequest: JsonObject, defaultWorkspacePath?: string): Promise<ProxySession> {
    const session: ProxySession = {
      initializeRequest,
      defaultWorkspacePath,
      initialized: false,
      bridgeSessions: new Map()
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        session.id = sessionId;
        this.sessions.set(sessionId, session);
        this.appendLine(`Proxy session established: ${sessionId}`);
      }
    });
    const protocolServer = this.createProtocolServer(session);
    session.transport = transport;
    session.protocolServer = protocolServer;
    transport.onclose = () => {
      if (session.id) {
        void this.disposeSession(session.id);
      }
    };
    protocolServer.oninitialized = () => {
      session.initialized = true;
      void this.notifyInitializedBridgeSessions(session);
    };
    await protocolServer.connect(transport);
    return session;
  }

  private createProtocolServer(session: ProxySession): Server {
    const server = new Server(
      { name: "vscode-operator-proxy", version: "1.3.2" },
      { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: PROXY_SERVER_INSTRUCTIONS }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.getProxyTools() }));
    server.setRequestHandler(ListResourcesRequestSchema, async (): Promise<ListResourcesResult> => ({
      resources: [
        { uri: TOOLS_RESOURCE_URI, name: "VSCode Operator Proxy Tool Summary", description: "Tool names and descriptions available through the proxy.", mimeType: "application/json" },
        { uri: TOOL_SCHEMA_RESOURCE_URI, name: "VSCode Operator Proxy Tool Schema Lookup", description: "Read with ?name=<toolName> to get one tool input schema.", mimeType: "application/json" },
        { uri: USAGE_GUIDE_RESOURCE_URI, name: "VSCode Operator Proxy Usage Guide", description: "Discovery-first and multi-workspace routing guidance.", mimeType: "text/plain" }
      ]
    }));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request): Promise<ReadResourceResult> => this.readProxyResource(request.params.uri));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      if (request.params.name === PROXY_WORKSPACE_STATUS_TOOL.name) {
        const status = buildWorkspaceStatus(this.bridges.values());
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
          structuredContent: status
        };
      }

      const requestedWorkspacePath = extra.requestInfo?.url?.searchParams.get("workspacePath")
        ?? (typeof request.params.arguments?.workspacePath === "string" ? request.params.arguments.workspacePath : null);
      const activeSession = extra.sessionId ? this.sessions.get(extra.sessionId) : undefined;
      try {
        const route = selectWorkspaceBridge({
          bridges: this.bridges.values(),
          workspacePath: requestedWorkspacePath,
          sessionWorkspacePath: activeSession?.defaultWorkspacePath ?? session.defaultWorkspacePath
        });
        this.appendLine(`Route ${request.params.name} by ${route.source} -> ${route.bridge.workspacePath}`);
        return await this.invokeBridgeTool(activeSession ?? session, route.bridge, request.params);
      } catch (error) {
        throw asMcpError(error);
      }
    });
    return server;
  }

  private async getProxyTools(): Promise<Tool[]> {
    const bridges = getRegisteredBridges(this.bridges.values());
    const catalogs = await Promise.all(bridges.map(async (bridge) => this.getBridgeToolCatalog(bridge)));
    return mergeProxyToolCatalogs(catalogs);
  }

  private async getBridgeToolCatalog(bridge: BridgeRegistration): Promise<Tool[]> {
    try {
      const response = await this.requestBridge(bridge, "POST", {
        jsonrpc: "2.0",
        id: `proxy-tools-${randomUUID()}`,
        method: "tools/list",
        params: {}
      });
      const payload = this.parseBridgeResponse(response);
      const result = isJsonObject(payload?.result) ? payload.result : undefined;
      if (!payload || payload.error || response.statusCode >= 400) {
        this.appendLine(`Tool catalog unavailable from ${bridge.workspacePath}: HTTP ${response.statusCode}`);
        return [];
      }
      return Array.isArray(result?.tools)
        ? result.tools.filter((tool): tool is Tool => isJsonObject(tool) && typeof tool.name === "string")
        : [];
    } catch (error) {
      this.appendLine(`Tool catalog unavailable from ${bridge.workspacePath}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async readProxyResource(uri: string): Promise<ReadResourceResult> {
    if (uri === USAGE_GUIDE_RESOURCE_URI) {
      return { contents: [{ uri, mimeType: "text/plain", text: PROXY_USAGE_GUIDE_TEXT }] };
    }
    if (uri.startsWith(TOOL_SCHEMA_RESOURCE_URI)) {
      let toolName = "";
      try {
        toolName = new URL(uri).searchParams.get("name") ?? "";
      } catch {
        // Return the documented missing-name error below.
      }
      if (!toolName) {
        return {
          contents: [{
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ error: "Missing query parameter 'name'.", usage: "vscode-operator://tool-schema?name=vscode_workspace_status" }, null, 2)
          }]
        };
      }
      const tool = (await this.getProxyTools()).find((candidate) => candidate.name === toolName);
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify(tool ? { name: tool.name, description: tool.description, inputSchema: tool.inputSchema } : { error: `Tool not found: ${toolName}` }, null, 2)
        }]
      };
    }
    if (uri.startsWith(TOOLS_RESOURCE_URI)) {
      const tools = await this.getProxyTools();
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            usage: "Call vscode_workspace_status first, then include workspacePath for workspace-specific tools.",
            tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" }))
          }, null, 2)
        }]
      };
    }
    return { contents: [{ uri, mimeType: "text/plain", text: `Resource not found: ${uri}` }] };
  }

  private async invokeBridgeTool(
    session: ProxySession,
    bridge: BridgeRegistration,
    params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }
  ): Promise<CallToolResult> {
    const bridgeSessionId = await this.ensureBridgeSession(session, bridge);
    const response = await this.requestBridge(bridge, "POST", {
      jsonrpc: "2.0",
      id: `proxy-call-${randomUUID()}`,
      method: "tools/call",
      params
    }, bridgeSessionId);
    const payload = this.parseBridgeResponse(response);
    if (!payload) {
      throw new McpError(ErrorCode.InternalError, `Bridge returned an invalid response for ${params.name}.`);
    }
    if (isJsonObject(payload.error)) {
      throw new McpError(
        typeof payload.error.code === "number" ? payload.error.code : ErrorCode.InternalError,
        typeof payload.error.message === "string" ? payload.error.message : "Bridge request failed.",
        payload.error.data
      );
    }
    if (!isJsonObject(payload.result)) {
      throw new McpError(ErrorCode.InternalError, `Bridge returned no result for ${params.name}.`);
    }
    return payload.result as CallToolResult;
  }

  private async ensureBridgeSession(session: ProxySession, bridge: BridgeRegistration): Promise<string | undefined> {
    if (session.bridgeSessions.has(bridge.workspacePath)) {
      return session.bridgeSessions.get(bridge.workspacePath);
    }
    const initializeParams = isJsonObject(session.initializeRequest.params) ? session.initializeRequest.params : {};
    const response = await this.requestBridge(bridge, "POST", {
      jsonrpc: "2.0",
      id: `proxy-bridge-init-${randomUUID()}`,
      method: "initialize",
      params: initializeParams
    });
    const payload = this.parseBridgeResponse(response);
    if (!payload || isJsonObject(payload.error) || response.statusCode >= 400) {
      const message = isJsonObject(payload?.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : `Unable to initialize bridge for ${bridge.workspacePath}.`;
      throw new McpError(ErrorCode.InternalError, message);
    }
    const bridgeSessionId = getSingleHeader(response.headers["mcp-session-id"]);
    session.bridgeSessions.set(bridge.workspacePath, bridgeSessionId);
    if (bridgeSessionId && session.initialized) {
      await this.notifyBridgeInitialized(bridge, bridgeSessionId);
    }
    return bridgeSessionId;
  }

  private async notifyInitializedBridgeSessions(session: ProxySession): Promise<void> {
    await Promise.all([...session.bridgeSessions.entries()].map(async ([workspacePath, bridgeSessionId]) => {
      if (!bridgeSessionId) {
        return;
      }
      const bridge = this.findBridgeByWorkspacePath(workspacePath);
      if (bridge) {
        await this.notifyBridgeInitialized(bridge, bridgeSessionId);
      }
    }));
  }

  private async notifyBridgeInitialized(bridge: BridgeRegistration, bridgeSessionId: string): Promise<void> {
    try {
      await this.requestBridge(bridge, "POST", {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {}
      }, bridgeSessionId);
    } catch (error) {
      this.appendLine(`Failed to notify initialized bridge ${bridge.workspacePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async disposeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionId);
    for (const [peerKey, peerSessionId] of this.headerlessSessionIdsByPeer) {
      if (peerSessionId === sessionId) {
        this.headerlessSessionIdsByPeer.delete(peerKey);
      }
    }
    await Promise.all([...session.bridgeSessions.entries()].map(async ([workspacePath, bridgeSessionId]) => {
      if (!bridgeSessionId) {
        return;
      }
      const bridge = this.findBridgeByWorkspacePath(workspacePath);
      if (!bridge) {
        return;
      }
      try {
        await this.requestBridge(bridge, "DELETE", undefined, bridgeSessionId);
      } catch (error) {
        this.appendLine(`Failed to close bridge session for ${workspacePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    await session.transport?.close();
    await session.protocolServer?.close();
    this.appendLine(`Proxy session closed: ${sessionId}`);
  }

  private async requestBridge(
    bridge: BridgeRegistration,
    method: "POST" | "DELETE",
    payload?: JsonObject,
    bridgeSessionId?: string
  ): Promise<BridgeHttpResponse> {
    const body = payload ? JSON.stringify(payload) : "";
    const headers: Record<string, string> = {
      "accept": "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25"
    };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    if (bridgeSessionId) {
      headers["mcp-session-id"] = bridgeSessionId;
    }
    this.appendLine(`Forward -> ${bridge.host}:${bridge.port}${this.getMcpPath()} method=${method} workspace=${bridge.workspacePath} headers=${this.summarizeText(JSON.stringify({ sessionId: bridgeSessionId ?? null, contentType: headers["content-type"] ?? null }))} payload=${this.safePreviewJsonBody(body)}`);

    return new Promise<BridgeHttpResponse>((resolve, reject) => {
      const proxyReq = httpRequest(
        { hostname: bridge.host, port: bridge.port, path: this.getMcpPath(), method, headers },
        (proxyRes) => {
          let responseBody = "";
          let responseBytes = 0;
          proxyRes.on("data", (chunk: Buffer | string) => {
            const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            responseBody += text;
            responseBytes += Buffer.byteLength(text);
          });
          proxyRes.on("end", () => {
            this.appendLine(`Response <- status=${proxyRes.statusCode ?? 200} workspace=${bridge.workspacePath} bytes=${responseBytes} body=${this.shouldLogPayloadPreview() ? this.summarizeText(responseBody || "<empty>") : "<redacted>"}`);
            resolve({ statusCode: proxyRes.statusCode ?? 200, headers: proxyRes.headers, body: responseBody });
          });
        }
      );
      proxyReq.on("error", reject);
      if (body) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });
  }

  private parseBridgeResponse(response: BridgeHttpResponse): JsonObject | undefined {
    if (!response.body.trim()) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(response.body);
      return isJsonObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk: Buffer | string) => {
        body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  private writeMcpError(res: ServerResponse, status: number, code: number, message: string, id: unknown): void {
    if (res.headersSent || res.writableEnded) {
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: typeof id === "string" || typeof id === "number" ? id : null
    }));
  }
}
