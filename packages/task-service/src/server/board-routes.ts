import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { RegistryService } from "../core/registry-service.js";
import type { SessionService } from "../core/session-service.js";
import type { ProjectAccessService } from "../core/project-access-service.js";
import {
  PlatformDomainError,
  TaskService,
  type TaskActor

} from "../core/task-service.js";
import type { ProgressStore } from "../storage/progress-store.js";
import { boardPrincipal } from "./board-auth.js";
import type { SseHub } from "./sse-hub.js";

const HUMAN_ACTOR: TaskActor = "human";

const operationIdSchema = z.string().min(1);
const expectedVersionSchema = z.number().int().min(0);

const patchTaskBodySchema = z.object({
  operation_id: operationIdSchema,
  expected_version: expectedVersionSchema,
  title: z.string().min(1).optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional()
});

const versionedActionBodySchema = z.object({
  operation_id: operationIdSchema,
  expected_version: expectedVersionSchema
});

const releaseBodySchema = z.object({
  operation_id: operationIdSchema,
  expected_version: expectedVersionSchema
});

const operationOnlyBodySchema = z.object({
  operation_id: operationIdSchema
});

/**
 * Human registration of a repository from the board. Paths are declared, not
 * verified: since the service runs remotely from most worktrees it cannot
 * stat them anyway (same stance as the opaque worktree-probe fallback), and
 * the whitelist's remaining role is grouping plus session binding.
 */
const registerRepositoryBodySchema = z.object({
  project_id: z.string().min(1).max(64),
  project_name: z.string().min(1).max(120),
  repository_id: z.string().min(1).max(64),
  repository_name: z.string().min(1).max(120),
  path: z.string().min(1).max(1024)
});

interface CachedResponse {
  status: number;
  body: unknown;
}

const responseCacheLimit = 512;

/**
 * Web-only idempotency for human mutations. The human service methods have
 * no operation ids of their own, so the board keeps a bounded in-memory
 * replay cache keyed by the operation id the board UI generates. A process
 * restart forgets the cache; a retried mutation then re-runs against the
 * current version and fails with TASK_VERSION_CONFLICT instead of double
 * applying — acceptable for a single human clicking a local board.
 */
export class WebOperationCache {
  readonly #responses = new Map<string, CachedResponse>();

  get(operationId: string): CachedResponse | undefined {
    const cached = this.#responses.get(operationId);
    if (cached !== undefined) {
      this.#responses.delete(operationId);
      this.#responses.set(operationId, cached);
    }
    return cached;
  }

  put(operationId: string, response: CachedResponse): void {
    if (this.#responses.has(operationId)) {
      return;
    }
    this.#responses.set(operationId, response);
    if (this.#responses.size > responseCacheLimit) {
      const oldest = this.#responses.keys().next().value;
      if (oldest !== undefined) {
        this.#responses.delete(oldest);
      }
    }
  }
}

export interface BoardRoutesDeps {
  taskService: TaskService;
  sessionService: SessionService;
  store: ProgressStore;
  registryService: RegistryService;
  projectAccess?: ProjectAccessService;
  hub: SseHub;
  now: () => string;
  cache?: WebOperationCache;
}

export function createBoardRouter(deps: BoardRoutesDeps): Router {
  const router = Router();
  const cache = deps.cache ?? new WebOperationCache();

  function replay(
    request: Request,
    response: Response,
    next: NextFunction,
    run: () => Promise<{ status: number; body: unknown }>
  ): Promise<void> {
    const header = request.header("x-operation-id");
    const bodyOperationId = typeof request.body === "object" && request.body !== null
      ? (request.body as Record<string, unknown>).operation_id
      : undefined;
    const operationId = typeof bodyOperationId === "string"
      ? bodyOperationId
      : (typeof header === "string" && header.length > 0 ? header : undefined);
    if (operationId === undefined) {
      response.status(400).json(invalidInput("operation_id is required"));
      return Promise.resolve();
    }
    const cacheKey = [
      boardPrincipal(response).owner,
      request.method,
      request.originalUrl,
      operationId
    ].join("\u0000");
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      response.status(cached.status).json(cached.body);
      return Promise.resolve();
    }
    return run().then((result) => {
      cache.put(cacheKey, result);
      response.status(result.status).json(result.body);
    }, next);
  }

  function broadcast(taskId: string, version: number): void {
    deps.hub.publishTaskChanged({ task_id: taskId, version });
    deps.hub.publishOverviewChanged();
  }

  router.get("/tasks", async (request, response) => {
    const repositoryId = request.query.repository_id;
    const scope = request.query.scope;
    const owner = readTargetOwner(request, response);
    if (owner === undefined) {
      return;
    }
    const filter: { repositoryId?: string; owner?: string } = { owner };
    if (repositoryId !== undefined) {
      if (typeof repositoryId !== "string" || repositoryId.length === 0) {
        response.status(400).json(invalidInput("repository_id must be a non-empty string"));
        return;
      }
      filter.repositoryId = repositoryId;
    }
    if (scope !== undefined && scope !== "project") {
      response.status(400).json(invalidInput("scope must be project"));
      return;
    }
    if (scope === "project") {
      if (repositoryId === undefined) {
        response.status(400).json(invalidInput("repository_id is required for project scope"));
        return;
      }
      if (owner !== boardPrincipal(response).owner) {
        response.status(403).json(invalidInput("project scope cannot target another owner"));
        return;
      }
      assertProjectViewerForRepository(repositoryId, boardPrincipal(response).owner);
      delete filter.owner;
    }
    response.json({
      tasks: await deps.taskService.listTasks(filter)
    });
  });

  router.get("/repositories", async (request, response) => {
    const owner = readTargetOwner(request, response);
    if (owner === undefined) {
      return;
    }
    response.json({
      repositories: deps.store.listRepositories(owner)
    });
  });

  router.post("/repositories", async (request, response) => {
    const parsed = registerRepositoryBodySchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json(invalidInput(parsed.error.issues[0]?.message));
      return;
    }
    const result = deps.registryService.registerRepository({
      ...parsed.data,
      created_by: boardPrincipal(response).owner
    });
    deps.hub.publishOverviewChanged();
    response.status(201).json({
      project: result.project,
      repository: result.repository,
      created_project: result.created_project
    });
  });

  router.get("/projects", (request, response) => {
    const owner = readTargetOwner(request, response);
    if (owner === undefined) {
      return;
    }
    const includeArchived = request.query.include_archived;
    if (includeArchived !== undefined
      && includeArchived !== "true"
      && includeArchived !== "false") {
      response.status(400).json(invalidInput("include_archived must be true or false"));
      return;
    }
    response.json({
      projects: deps.store.listProjects(owner, {
        include_archived: includeArchived === "true"
      })
    });
  });

  // Human-only project archive/restore. Deliberately Board-only: no MCP tool
  // exposes these, so an Agent can never archive a project.
  for (const action of ["archive", "unarchive"] as const) {
    router.post(`/projects/:projectId/${action}`, (request, response, next) => {
      void replay(request, response, next, async () => {
        const parsed = operationOnlyBodySchema.safeParse(request.body);
        if (!parsed.success) {
          return { status: 400, body: invalidInput(parsed.error.issues[0]?.message) };
        }
        if (deps.projectAccess === undefined) {
          return { status: 503, body: unavailable("Project collaboration is not configured") };
        }
        const owner = boardPrincipal(response).owner;
        const project = action === "archive"
          ? deps.projectAccess.archiveProject(request.params.projectId, owner)
          : deps.projectAccess.unarchiveProject(request.params.projectId, owner);
        deps.hub.publishOverviewChanged();
        return { status: 200, body: { project } };
      });
    });
  }

  router.post("/projects/:projectId/shares", (request, response, next) => {
    void replay(request, response, next, async () => {
      const parsed = operationOnlyBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return { status: 400, body: invalidInput(parsed.error.issues[0]?.message) };
      }
      if (deps.projectAccess === undefined) {
        return { status: 503, body: unavailable("Project collaboration is not configured") };
      }
      const share = deps.projectAccess.createShare(
        request.params.projectId,
        boardPrincipal(response).owner
      );
      deps.hub.publishOverviewChanged();
      return { status: 201, body: { share } };
    });
  });

  router.post("/project-invitations/:token/accept", (request, response, next) => {
    void replay(request, response, next, async () => {
      const parsed = operationOnlyBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return { status: 400, body: invalidInput(parsed.error.issues[0]?.message) };
      }
      if (deps.projectAccess === undefined) {
        return { status: 503, body: unavailable("Project collaboration is not configured") };
      }
      const project = deps.projectAccess.acceptShare(
        request.params.token,
        boardPrincipal(response).owner
      );
      deps.hub.publishOverviewChanged();
      return { status: 200, body: { project } };
    });
  });

  router.get("/projects/:projectId/members", (request, response) => {
    if (deps.projectAccess === undefined) {
      response.status(503).json(unavailable("Project collaboration is not configured"));
      return;
    }
    const owner = boardPrincipal(response).owner;
    const members = deps.projectAccess.listMembers(request.params.projectId, owner);
    const project = deps.store.getProject(request.params.projectId);
    response.json({
      creator: project?.created_by ?? null,
      members
    });
  });

  router.delete("/projects/:projectId/shares/:shareId", (request, response, next) => {
    void replay(request, response, next, async () => {
      const parsed = operationOnlyBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return { status: 400, body: invalidInput(parsed.error.issues[0]?.message) };
      }
      if (deps.projectAccess === undefined) {
        return { status: 503, body: unavailable("Project collaboration is not configured") };
      }
      const revoked = deps.projectAccess.revokeShare(
        request.params.projectId,
        request.params.shareId,
        boardPrincipal(response).owner
      );
      deps.hub.publishOverviewChanged();
      return { status: 200, body: { revoked } };
    });
  });

  router.delete("/projects/:projectId/members/:memberOwner", (request, response, next) => {
    void replay(request, response, next, async () => {
      const parsed = operationOnlyBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return { status: 400, body: invalidInput(parsed.error.issues[0]?.message) };
      }
      if (deps.projectAccess === undefined) {
        return { status: 503, body: unavailable("Project collaboration is not configured") };
      }
      const revoked = deps.projectAccess.removeMember(
        request.params.projectId,
        request.params.memberOwner,
        boardPrincipal(response).owner
      );
      deps.hub.publishOverviewChanged();
      return { status: 200, body: { revoked } };
    });
  });

  router.get("/overview/projects", (_request, response) => {
    response.json({ projects: deps.store.listProjects() });
  });

  router.get("/whoami", (_request, response) => {
    response.json({
      owner: boardPrincipal(response).owner,
      source: "board_session"
    });
  });

  router.get("/people", (request, response) => {
    const owner = readTargetOwner(request, response);
    if (owner === undefined) {
      return;
    }
    response.json({ people: deps.store.listPeople(owner) });
  });

  router.get("/overview/people", (_request, response) => {
    response.json({ people: deps.store.listPeople() });
  });

  router.get("/notifications", (request, response) => {
    const repositoryId = request.query.repository_id;
    if (repositoryId !== undefined
      && (typeof repositoryId !== "string" || repositoryId.length === 0)) {
      response.status(400).json(invalidInput("repository_id must be a non-empty string"));
      return;
    }
    const unread = request.query.unread;
    if (unread !== undefined && unread !== "true" && unread !== "false") {
      response.status(400).json(invalidInput("unread must be true or false"));
      return;
    }
    response.json({
      notifications: deps.store.listNotifications(boardPrincipal(response).owner, {
        ...(repositoryId !== undefined ? { repositoryId } : {}),
        unreadOnly: unread === "true"
      })
    });
  });

  router.post("/notifications/:notificationId/read", (request, response, next) => {
    void replay(request, response, next, async () => {
      deps.store.markNotificationRead(
        request.params.notificationId,
        boardPrincipal(response).owner
      );
      return { status: 200, body: { read: true } };
    });
  });

  router.get("/dependency-validation-activities", (request, response) => {
    const repositoryId = request.query.repository_id;
    if (repositoryId !== undefined
      && (typeof repositoryId !== "string" || repositoryId.length === 0)) {
      response.status(400).json(invalidInput("repository_id must be a non-empty string"));
      return;
    }
    const unread = request.query.unread;
    if (unread !== undefined && unread !== "true" && unread !== "false") {
      response.status(400).json(invalidInput("unread must be true or false"));
      return;
    }
    const owner = boardPrincipal(response).owner;
    const repairs = deps.store.listDependencyRepairRequests(owner, repositoryId);
    response.json({
      activities: deps.store.listDependencyValidationActivities(owner, {
        ...(repositoryId !== undefined ? { repositoryId } : {}),
        unreadOnly: unread === "true"
      }).map((activity) => ({
        ...activity,
        dependency_repair: repairs.find((repair) => (
          repair.validation_id === activity.validation_id
        )) ?? null
      }))
    });
  });

  router.post(
    "/dependency-validations/:validationId/:perspective/read",
    (request, response, next) => {
      void replay(request, response, next, async () => {
        const perspective = request.params.perspective;
        if (perspective !== "request" && perspective !== "response") {
          return { status: 400, body: invalidInput("perspective must be request or response") };
        }
        deps.store.markDependencyValidationRead(
          request.params.validationId,
          boardPrincipal(response).owner,
          perspective
        );
        return { status: 200, body: { read: true } };
      });
    }
  );

  router.get("/tasks/:taskId", async (request, response) => {
    const task = await deps.taskService.getTask(request.params.taskId);
    if (task === undefined) {
      response.status(404).json(notFound(`Task ${request.params.taskId} not found`));
      return;
    }
    assertProjectViewerForTask(task.repository_id, boardPrincipal(response).owner);
    const recovery = await deps.taskService.getTaskRecovery({
      task_id: request.params.taskId
    });
    response.json({
      task,
      recovery,
      dependency_repairs: task.owner === undefined
        ? []
        : deps.store.listDependencyRepairRequests(task.owner, task.repository_id)
          .filter((repair) => repair.upstream_task_id === task.task_id),
      dependencies: deps.store.listTaskDependencyViews(request.params.taskId),
      dependency_validations: deps.store.listDependencyValidationViews(request.params.taskId),
      dependency_validation_gate: deps.store.getDependencyValidationGate(request.params.taskId),
      events: deps.store.listTaskEventViews(request.params.taskId),
      snapshots: deps.store.listRepoSnapshotViews(request.params.taskId)
    });
  });

  router.get("/dependency-contexts/:ctxId", (request, response) => {
    if (deps.store.getDependencyContext === undefined) {
      response.status(404).json(notFound(`Dependency context ${request.params.ctxId} not found`));
      return;
    }
    const context = deps.store.getDependencyContext(request.params.ctxId);
    if (context === undefined) {
      response.status(404).json(notFound(`Dependency context ${request.params.ctxId} not found`));
      return;
    }
    const upstream = deps.store.getTaskDetail(context.upstream_task_id);
    const downstream = deps.store.getTaskDetail(context.downstream_task_id);
    const principal = boardPrincipal(response).owner;
    if (upstream !== undefined) assertProjectViewerForTask(upstream.repository_id, principal);
    if (downstream !== undefined) assertProjectViewerForTask(downstream.repository_id, principal);
    response.json({
      context,
      events: deps.store.listDependencyContextEvents?.(request.params.ctxId) ?? []
    });
  });

  router.patch("/tasks/:taskId", (request, response, next) => {
    void replay(request, response, next, async () => {
      const parsed = patchTaskBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return { status: 400, body: invalidInput(parsed.error.issues[0]?.message) };
      }
      const patchTask = await deps.taskService.getTask(request.params.taskId);
      if (patchTask !== undefined) {
        assertTaskMutationAccess(patchTask, boardPrincipal(response).owner);
      }
      const result = await deps.taskService.humanUpdateTask(
        request.params.taskId,
        HUMAN_ACTOR,
        {
          ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
          ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {})
        },
        { expected_version: parsed.data.expected_version }
      );
      broadcast(result.task_id, result.version);
      return { status: 200, body: { task: await taskDetail(result.task_id) } };
    });
  });

  for (const action of ["accept", "reject", "resume", "cancel"] as const) {
    router.post(`/tasks/:taskId/${action}`, (request, response, next) => {
      void replay(request, response, next, async () => {
        const parsed = versionedActionBodySchema.safeParse(request.body);
        if (!parsed.success) {
          return { status: 400, body: invalidInput(parsed.error.issues[0]?.message) };
        }
        const service = deps.taskService;
        const currentTask = await service.getTask(request.params.taskId);
        if (currentTask !== undefined) {
          assertTaskMutationAccess(currentTask, boardPrincipal(response).owner);
        }
        const result = await (action === "accept"
          ? service.humanAccept(request.params.taskId, HUMAN_ACTOR, {
            expected_version: parsed.data.expected_version
          })
          : action === "reject"
            ? service.humanReject(request.params.taskId, HUMAN_ACTOR, {
              expected_version: parsed.data.expected_version
            })
            : action === "resume"
              ? service.humanResume(request.params.taskId, HUMAN_ACTOR, {
                expected_version: parsed.data.expected_version
              })
            : service.humanCancel(request.params.taskId, HUMAN_ACTOR, {
              expected_version: parsed.data.expected_version
            }));
        broadcast(result.task_id, result.version);
        for (const repair of result.dependency_repair_changes ?? []) {
          deps.hub.publishDependencyRepairChanged({
            repair_id: repair.repair_id,
            validation_id: repair.validation_id,
            upstream_task_id: repair.upstream_task_id,
            downstream_task_id: repair.downstream_task_id,
            cycle: repair.cycle,
            status: repair.status
          });
        }
        return { status: 200, body: { task: await taskDetail(result.task_id) } };
      });
    });
  }

  router.post("/sessions/:sessionId/release", (request, response, next) => {
    void replay(request, response, next, async () => {
      const parsed = releaseBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return { status: 400, body: invalidInput(parsed.error.issues[0]?.message) };
      }
      const lease = deps.store.transaction((tx) =>
        tx.getLeaseBySession(request.params.sessionId)
      );
      if (lease !== undefined) {
        const leaseTask = await deps.taskService.getTask(lease.task_id);
        if (leaseTask !== undefined) {
          assertTaskMutationAccess(leaseTask, boardPrincipal(response).owner);
        }
      }
      const result = await deps.taskService.humanReleaseSession(
        request.params.sessionId,
        HUMAN_ACTOR,
        { expected_version: parsed.data.expected_version }
      );
      broadcast(result.task_id, result.version);
      return { status: 200, body: { task: await taskDetail(result.task_id) } };
    });
  });

  async function taskDetail(taskId: string): Promise<unknown> {
    return deps.taskService.getTask(taskId);
  }

  function assertProjectViewerForRepository(repositoryId: string, owner: string): void {
    const repository = deps.store.getRepository(repositoryId);
    if (repository === undefined) {
      throw new PlatformDomainError("REPOSITORY_NOT_ALLOWED", `Repository ${repositoryId} is not registered`);
    }
    const project = deps.store.getProject(repository.project_id);
    if (project?.created_by !== undefined && project.created_by !== null) {
      if (deps.projectAccess === undefined) {
        throw new PlatformDomainError(
          "PROJECT_ACCESS_REQUIRED",
          "Project collaboration is not configured",
          { evidence: [], recovery_actions: ["Restart the platform service with project access enabled."] }
        );
      }
      deps.projectAccess.assertProjectViewer(repository.project_id, owner);
    }
  }

  function assertProjectViewerForTask(repositoryId: string, owner: string): void {
    assertProjectViewerForRepository(repositoryId, owner);
  }

  function assertTaskMutationAccess(
    task: { task_id: string; repository_id: string; owner?: string | undefined },
    owner: string
  ): void {
    assertOwnerMatches(task.owner, owner);
    const repository = deps.store.getRepository(task.repository_id);
    const project = repository === undefined ? undefined : deps.store.getProject(repository.project_id);
    if (project?.created_by !== undefined && project.created_by !== null) {
      if (deps.projectAccess === undefined) {
        throw new PlatformDomainError(
          "PROJECT_ACCESS_REQUIRED",
          "Project collaboration is not configured",
          { evidence: [], recovery_actions: ["Restart the platform service with project access enabled."] }
        );
      }
      deps.projectAccess.assertTaskMutation(task.task_id, owner);
    }
  }

  return router;
}

function invalidInput(message: string | undefined): unknown {
  return {
    code: "INVALID_INPUT",
    message: message ?? "Request body failed validation",
    retryable: false,
    evidence: [],
    recovery_actions: ["Fix the request body and retry."]
  };
}

function readTargetOwner(request: Request, response: Response): string | undefined {
  const requestedOwner = request.query.owner;
  if (requestedOwner === undefined) {
    return boardPrincipal(response).owner;
  }
  if (typeof requestedOwner !== "string" || requestedOwner.length === 0) {
    response.status(400).json(invalidInput("owner must be a non-empty string"));
    return undefined;
  }
  return requestedOwner;
}

/**
 * Owner-scoped guard based only on the server-issued Board principal. The
 * response deliberately does not disclose the task's actual owner.
 */
function assertOwnerMatches(
  taskOwner: string | undefined,
  requester: string
): void {
  if (taskOwner !== requester) {
    throw new PlatformDomainError(
      "OWNER_MISMATCH",
      "The task is not available to the authenticated Board owner",
      {
        evidence: [],
        recovery_actions: ["Only the task owner can perform this action."]
      }
    );
  }
}

function notFound(message: string): unknown {
  return {
    code: "TASK_NOT_FOUND",
    message,
    retryable: false,
    evidence: [],
    recovery_actions: []
  };
}

function unavailable(message: string): unknown {
  return {
    code: "STORAGE_BUSY",
    message,
    retryable: true,
    evidence: [],
    recovery_actions: ["Restart the platform service and retry."]
  };
}
