/// <reference types="node" />

import { randomUUID } from "node:crypto";
import {
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage,
  type MessageExtraInfo
} from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import express, { type Express, type Request, type Response } from "express";
import {
  createMcpServer,
  type McpServerDeps,
  type TransportHandshake
} from "./register-tools.js";

export const MCP_PATH = "/mcp";

const SESSION_HEADER = "mcp-session-id";

export interface McpTransportDeps extends Omit<McpServerDeps, "handshake"> {
  sessionIdGenerator?: () => string;
}

interface TransportSessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface MountedMcpTransport {
  /** Transport session ids that currently hold a live server+transport pair. */
  activeTransportSessions(): readonly string[];
  /** Closes every transport session; task leases are intentionally untouched. */
  close(): Promise<void>;
}

/**
 * Mounts the Streamable HTTP MCP endpoint (`POST/GET/DELETE /mcp`) on an
 * Express app. Every MCP initialize creates its own transport session, keyed
 * by the SDK-generated session id, with its own McpServer instance. A DELETE
 * closes the transport and frees the connection objects but never releases
 * task leases held by the bound platform session.
 */
export function mountMcpTransport(
  app: Express,
  deps: McpTransportDeps
): MountedMcpTransport {
  const sessions = new Map<string, TransportSessionEntry>();
  const jsonParser = express.json({ limit: "1mb" });
  const sessionIdGenerator = deps.sessionIdGenerator ?? (() => randomUUID());

  async function startTransportSession(): Promise<TransportSessionEntry> {
    const handshake: TransportHandshake = {};
    const server = createMcpServer({ ...deps, handshake });
    let entry: TransportSessionEntry;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator,
      onsessioninitialized(sessionId: string) {
        handshake.transportSessionId = sessionId;
        sessions.set(sessionId, entry);
      },
      onsessionclosed(sessionId: string) {
        if (sessions.get(sessionId)?.transport === transport) {
          sessions.delete(sessionId);
        }
        // Free the per-session server and its connection objects; platform
        // sessions and task leases survive transport teardown by design.
        void server.close().catch(() => undefined);
      }
    });
    entry = { server, transport };
    // The concrete transport widens its lifecycle callbacks with `| undefined`,
    // which exactOptionalPropertyTypes rejects against the Transport interface.
    await server.connect(transport as unknown as Transport);
    captureHandshake(transport, handshake);
    return entry;
  }

  function sessionNotFound(res: Response, sessionId: string): void {
    res.status(404).json({
      error: {
        code: "SESSION_NOT_FOUND",
        message: `No MCP transport session ${sessionId}`,
        retryable: false,
        evidence: [sessionId],
        recovery_actions: ["Send a new initialize request without a session id header."]
      }
    });
  }

  async function handlePost(req: Request, res: Response): Promise<void> {
    const headerSessionId = req.header(SESSION_HEADER);
    try {
      if (headerSessionId !== undefined) {
        const entry = sessions.get(headerSessionId);
        if (entry === undefined) {
          sessionNotFound(res, headerSessionId);
          return;
        }
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }
      // No session id: only an initialize request may open a new session.
      const entry = await startTransportSession();
      await entry.transport.handleRequest(req, res, req.body);
      if (entry.transport.sessionId === undefined) {
        // The SDK rejected the headerless request; drop the half-open pair.
        await entry.server.close();
      }
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
            evidence: [],
            recovery_actions: ["Retry the request against a fresh transport session."]
          }
        });
      } else {
        res.destroy();
      }
    }
  }

  app.post(MCP_PATH, jsonParser, (req: Request, res: Response) => {
    void handlePost(req, res);
  });

  app.get(MCP_PATH, (req: Request, res: Response) => {
    const headerSessionId = req.header(SESSION_HEADER);
    const entry = headerSessionId === undefined
      ? undefined
      : sessions.get(headerSessionId);
    if (entry === undefined) {
      res.status(405).json({
        error: {
          code: "SESSION_NOT_FOUND",
          message: "SSE streams require an existing MCP transport session id",
          retryable: false,
          evidence: [headerSessionId ?? "missing"],
          recovery_actions: ["Initialize a transport session with POST /mcp first."]
        }
      });
      return;
    }
    void entry.transport.handleRequest(req, res, undefined)
      .catch(() => res.destroy());
  });

  app.delete(MCP_PATH, (req: Request, res: Response) => {
    const headerSessionId = req.header(SESSION_HEADER);
    const entry = headerSessionId === undefined
      ? undefined
      : sessions.get(headerSessionId);
    if (entry === undefined) {
      sessionNotFound(res, headerSessionId ?? "missing");
      return;
    }
    void entry.transport.handleRequest(req, res, undefined)
      .catch(() => res.destroy());
  });

  app.all(MCP_PATH, (req: Request, res: Response) => {
    res.status(405).json({
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: `${req.method} is not supported on ${MCP_PATH}; use POST, GET, or DELETE`,
        retryable: false,
        evidence: [req.method],
        recovery_actions: ["Use POST for messages, GET for SSE, DELETE to terminate."]
      }
    });
  });

  return {
    activeTransportSessions: () => [...sessions.keys()],
    async close() {
      const entries = [...sessions.values()];
      sessions.clear();
      for (const entry of entries) {
        await entry.server.close();
      }
    }
  };
}

/**
 * Wraps the transport's inbound message handler so the client facts of the
 * initialize handshake (clientInfo, protocol version, capabilities) are
 * captured for `session_context` before the server processes the request.
 */
function captureHandshake(
  transport: StreamableHTTPServerTransport,
  handshake: TransportHandshake
): void {
  const forwarded = transport.onmessage;
  transport.onmessage = (
    message: JSONRPCMessage,
    extra?: MessageExtraInfo
  ): void => {
    if (isInitializeRequest(message)) {
      const clientInfo = message.params.clientInfo;
      if (clientInfo !== undefined) {
        handshake.clientName = clientInfo.name;
        handshake.clientVersion = clientInfo.version;
      }
      const requested = message.params.protocolVersion;
      handshake.protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      const capabilities = message.params.capabilities as
        | Record<string, unknown>
        | undefined;
      if (capabilities !== undefined) {
        handshake.capabilities = capabilities;
      }
    }
    forwarded?.(message, extra);
  };
}
