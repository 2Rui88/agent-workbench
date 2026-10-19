import { existsSync } from "node:fs";
import { join } from "node:path";
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response
} from "express";
import { MCP_PATH } from "../mcp/http-transport.js";
import type { BoardAuthService } from "../core/board-auth-service.js";
import type { SessionService } from "../core/session-service.js";
import type { ProjectAccessService } from "../core/project-access-service.js";
import { PlatformDomainError } from "../core/task-service.js";
import type { PlatformStore } from "../storage/board-auth-store.js";
import {
  boardPrincipal,
  createBoardAuthenticationGate,
  createBoardAuthRouter
} from "./board-auth.js";
import { createBoardRouter } from "./board-routes.js";
import { createHostGate, createOriginGate } from "./security.js";
import { SseHub } from "./sse-hub.js";

export interface HttpAppDeps {
  taskService: import("../core/task-service.js").TaskService;
  sessionService: SessionService;
  store: PlatformStore;
  registryService: import("../core/registry-service.js").RegistryService;
  boardAuthService: BoardAuthService;
  projectAccess?: ProjectAccessService;
  /** Backs the developer-machine evidence endpoints when provided. */
  hostEvidenceService?: import("../core/host-evidence-service.js").HostEvidenceService;
  allowedHosts: readonly string[];
  sseHub?: SseHub;
  boardDir?: string;
  now?: () => string;
}

const domainErrorStatus: Record<string, number> = {
  TASK_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  LEASE_NOT_FOUND: 404,
  DEPENDENCY_VALIDATION_NOT_FOUND: 404,
  TASK_VERSION_CONFLICT: 409,
  SESSION_CONTEXT_CONFLICT: 409,
  TASK_LEASE_CONFLICT: 409,
  WORKTREE_CONFLICT: 409,
  FILE_CONFLICT: 409,
  REPOSITORY_EXISTS: 409,
  REPOSITORY_PATH_CONFLICT: 409,
  PROJECT_CONFLICT: 409,
  PROJECT_ARCHIVED: 409,
  PROJECT_HAS_OPEN_TASKS: 409,
  ACTIVE_UPSTREAM_DEPENDENCY: 409,
  DEPENDENCY_VALIDATION_REQUIRED: 409,
  DEPENDENCY_VALIDATION_ALREADY_RESPONDED: 409,
  PROJECT_ACCESS_REQUIRED: 403,
  PROJECT_CREATOR_REQUIRED: 403,
  PROJECT_SHARE_INVALID: 400,
  HUMAN_CONFIRMATION_REQUIRED: 403,
  REPOSITORY_NOT_ALLOWED: 403,
  REMOTE_WORKTREE_EVIDENCE_REQUIRED: 409,
  HOST_KEY_REJECTED: 403,
  CHALLENGE_EXPIRED: 410,
  CHALLENGE_REPLAY: 409,
  HOST_EVIDENCE_MISMATCH: 400,
  OWNER_MISMATCH: 403,
  BOARD_AUTH_REQUIRED: 401,
  BOARD_PAIRING_SESSION_INVALID: 403,
  BOARD_PAIRING_NOT_FOUND: 404,
  BOARD_PAIRING_EXPIRED: 410,
  BOOTSTRAP_NOT_CONFIGURED: 503,
  INVALID_INPUT: 400,
  INVALID_TRANSITION: 400,
  DECISION_NOT_PENDING: 400,
  CHECKPOINT_REQUIRED: 400,
  TASK_ALREADY_ADOPTED: 400,
  STORAGE_BUSY: 503
};

/**
 * Assembles the loopback-only HTTP surface: security gates, the board REST
 * API, SSE events, health, and the static board. `/mcp` is mounted later by
 * the runtime entrypoint; the host gate in front of it already covers every
 * path including MCP requests.
 */
export function createHttpApp(deps: HttpAppDeps): Express {
  const app = express();
  const hub = deps.sseHub ?? new SseHub({
    resolveTaskOwner: (taskId) => deps.store.getTaskDetail(taskId)?.owner,
    resolveTaskProjectId: (taskId) => {
      const task = deps.store.getTaskDetail(taskId);
      return task === undefined
        ? undefined
        : deps.store.getRepository(task.repository_id)?.project_id;
    },
    canViewProject: (projectId, owner) => deps.projectAccess?.isProjectViewer(projectId, owner) === true
  });
  const now = deps.now ?? (() => new Date().toISOString());
  app.locals.sseHub = hub;
  app.set("trust proxy", true);

  app.disable("x-powered-by");
  app.use(createHostGate(deps.allowedHosts));
  app.use(createOriginGate(deps.allowedHosts));

  app.get("/health", (_request: Request, response: Response) => {
    response.json({ ok: true });
  });

  const jsonBody = express.json({ limit: "1mb" });
  const boardAuthenticationGate = createBoardAuthenticationGate(deps.boardAuthService);
  app.use("/api/board-auth", jsonBody, createBoardAuthRouter(deps.boardAuthService));

  if (deps.hostEvidenceService !== undefined) {
    const hostEvidence = deps.hostEvidenceService;
    app.post("/host-evidence/register-key", jsonBody, (request, response, next) => {
      try {
        const body = request.body as Record<string, unknown>;
        response.json(hostEvidence.registerHostKey({
          owner: String(body.owner ?? ""),
          label: String(body.label ?? ""),
          public_key_b64: String(body.public_key_b64 ?? ""),
          ...(body.client_family === undefined
            ? {}
            : { client_family: String(body.client_family) }),
          ...(body.rotation_signature_b64 === undefined
            ? {}
            : { rotation_signature_b64: String(body.rotation_signature_b64) })
        }));
      } catch (error) {
        next(error);
      }
    });
    app.post("/host-evidence/challenge", jsonBody, (request, response, next) => {
      try {
        const body = request.body as Record<string, unknown>;
        const operation = String(body.operation ?? "checkpoint");
        response.json(hostEvidence.createChallenge({
          session_id: String(body.session_id ?? ""),
          operation: operation === "submit" ? "submit" : "checkpoint",
          ...(body.task_id === undefined ? {} : { task_id: String(body.task_id) })
        }));
      } catch (error) {
        next(error);
      }
    });
    app.post("/host-evidence/submit", jsonBody, (request, response, next) => {
      try {
        const body = request.body as Record<string, unknown>;
        response.json(hostEvidence.submitEvidence({
          payload: body.payload,
          signature_b64: String(body.signature_b64 ?? "")
        }));
      } catch (error) {
        next(error);
      }
    });
  }

  app.use("/api", jsonBody, boardAuthenticationGate, createBoardRouter({
    taskService: deps.taskService,
    sessionService: deps.sessionService,
    store: deps.store,
    registryService: deps.registryService,
    ...(deps.projectAccess === undefined ? {} : { projectAccess: deps.projectAccess }),
    hub,
    now
  }));

  app.get("/events", boardAuthenticationGate, (request: Request, response: Response) => {
    const requestedOwner = request.query.owner;
    if (requestedOwner !== undefined
      && (typeof requestedOwner !== "string" || requestedOwner.length === 0)) {
      response.status(400).json({
        code: "INVALID_INPUT",
        message: "owner must be a non-empty string",
        retryable: false,
        evidence: [],
        recovery_actions: []
      });
      return;
    }
    hub.attach(
      request,
      response,
      typeof requestedOwner === "string"
        ? requestedOwner
        : boardPrincipal(response).owner,
      boardPrincipal(response).owner
    );
  });

  const boardDir = deps.boardDir ?? join(process.cwd(), "dist", "web");
  // dotfiles: "allow" keeps the board servable from linked worktrees, whose
  // paths sit inside a .worktrees directory that send/static ignore by default.
  const staticOptions = { dotfiles: "allow" as const };
  app.get("/board", (_request: Request, response: Response) => {
    const indexPath = join(boardDir, "index.html");
    if (existsSync(indexPath)) {
      response.sendFile(indexPath, staticOptions);
      return;
    }
    response
      .status(200)
      .type("html")
      .send("<!doctype html><title>CLI Session Task MCP</title>"
        + "<p>CLI Session Task MCP board is not built yet.</p>");
  });
  if (existsSync(boardDir)) {
    app.use("/board", express.static(boardDir, staticOptions));
  }

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.path === MCP_PATH) {
      // The runtime entrypoint mounts the MCP transport on this app after
      // assembly; without this pass-through the catch-all below would shadow
      // those later-registered routes.
      next();
      return;
    }
    response.status(404).json({
      code: "NOT_FOUND",
      message: "Unknown endpoint",
      retryable: false,
      evidence: [],
      recovery_actions: []
    });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
    if (error instanceof PlatformDomainError) {
      const status = domainErrorStatus[error.code] ?? 500;
      response.status(status).json({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        evidence: [...error.evidence],
        recovery_actions: [...error.recovery_actions],
        ...(error.current_version !== undefined
          ? { current_version: error.current_version }
          : {}),
        ...(error.details !== undefined ? { details: error.details } : {})
      });
      return;
    }
    next(error);
  };
  app.use(errorHandler);

  return app;
}
