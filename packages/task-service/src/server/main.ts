/// <reference types="node" />

import type { Server } from "node:http";
import { createRuntimeConfig, type RuntimeConfig } from "../config/runtime-config.js";
import { BoardAuthService } from "../core/board-auth-service.js";
import { HostEvidenceService } from "../core/host-evidence-service.js";
import { ProjectAccessService } from "../core/project-access-service.js";
import { RepositoryBootstrapService } from "../core/repository-bootstrap-service.js";
import { RegistryService } from "../core/registry-service.js";
import { SessionService } from "../core/session-service.js";
import {
  TaskService,
  type AdoptTaskInput,
  type AttachTaskInput,
  type AttachTaskResult,
  type CheckpointTaskInput,
  type ConfirmTaskDecisionInput,
  type CreateTaskInput,
  type DependencyValidationCheckpointInput,
  type DependencyValidationCompleteInput,
  type DependencyValidationCompleteResult,
  type DependencyValidationReceiveInput,
  type DependencyValidationReceiveResult,
  type DependencyRepairReceiveInput,
  type DependencyRepairReceiveResult,
  type StartTaskInput,
  type SubmitTaskInput,
  type RequestTaskDependencyValidationInput,
  type UpdateTaskDependenciesInput,
  type SwitchTaskInput,
  type SwitchTaskResult,
  type TaskMutationResult,
  type TaskServiceDeps
} from "../core/task-service.js";
import { mountMcpTransport, type MountedMcpTransport } from "../mcp/http-transport.js";
import { RepoProbe } from "../repo/repo-probe.js";
import { SqliteDatabase } from "../storage/database.js";
import type { PlatformStore } from "../storage/board-auth-store.js";
import type { ProgressStore } from "../storage/progress-store.js";
import { createHttpApp } from "./http-app.js";
import { SseHub } from "./sse-hub.js";

const STALE_SCAN_INTERVAL_MS = 60_000;

interface BroadcastingTaskServiceDeps extends TaskServiceDeps {
  hub: SseHub;
}

/**
 * TaskService subclass used only on the MCP side of the assembly: after a
 * successful agent mutation it publishes a `task.changed` frame on the same
 * SSE hub the web board subscribes to, so board clients see agent writes
 * without the reviewed core services knowing about the transport.
 */
class BroadcastingTaskService extends TaskService {
  readonly #hub: SseHub;
  readonly #store: ProgressStore;

  constructor(deps: BroadcastingTaskServiceDeps) {
    const { hub, ...serviceDeps } = deps;
    super(serviceDeps);
    this.#hub = hub;
    this.#store = serviceDeps.store;
  }

  async #broadcasted<T extends TaskMutationResult>(result: Promise<T>): Promise<T> {
    const resolved = await result;
    this.#hub.publishTaskChanged({
      task_id: resolved.task_id,
      version: resolved.version
    });
    this.#hub.publishOverviewChanged();
    return resolved;
  }

  async #broadcastValidation<T>(
    result: Promise<T>,
    validationId: string
  ): Promise<T> {
    const resolved = await result;
    const view = this.#store.getDependencyValidation(validationId);
    if (view !== undefined) {
      for (const taskId of [view.upstream_task_id, view.downstream_task_id]) {
        const task = this.#store.getTaskDetail(taskId);
        if (task !== undefined) {
          this.#hub.publishTaskChanged({ task_id: taskId, version: task.version });
        }
      }
      const latestRun = view.latest_run;
      this.#hub.publishDependencyValidationChanged({
        validation_id: validationId,
        upstream_task_id: view.upstream_task_id,
        downstream_task_id: view.downstream_task_id,
        status: latestRun?.status ?? view.status,
        ...(latestRun === null || latestRun === undefined ? {} : { attempt: latestRun.attempt })
      });
      const upstreamOwner = view.upstream_owner;
      if (upstreamOwner !== null) {
        const repair = this.#store.listDependencyRepairRequests(
          upstreamOwner,
          view.upstream_repository_id
        ).find((candidate) => candidate.validation_id === validationId);
        if (repair !== undefined) {
          this.#hub.publishDependencyRepairChanged({
            repair_id: repair.repair_id,
            validation_id: repair.validation_id,
            upstream_task_id: repair.upstream_task_id,
            downstream_task_id: repair.downstream_task_id,
            cycle: repair.cycle,
            status: repair.status
          });
        }
      }
    }
    this.#hub.publishOverviewChanged();
    return resolved;
  }

  override createTask(input: CreateTaskInput): Promise<TaskMutationResult> {
    return this.#broadcasted(super.createTask(input));
  }

  override adoptTask(input: AdoptTaskInput): Promise<TaskMutationResult> {
    return this.#broadcasted(super.adoptTask(input));
  }

  override attachTask(input: AttachTaskInput): Promise<AttachTaskResult> {
    return this.#broadcasted(super.attachTask(input));
  }

  override startTask(input: StartTaskInput): Promise<TaskMutationResult> {
    return this.#broadcasted(super.startTask(input));
  }

  override confirmTaskDecision(input: ConfirmTaskDecisionInput): Promise<TaskMutationResult> {
    return this.#broadcasted(super.confirmTaskDecision(input));
  }

  override checkpointTask(input: CheckpointTaskInput): Promise<TaskMutationResult> {
    return this.#broadcasted(super.checkpointTask(input));
  }

  override switchTask(input: SwitchTaskInput): Promise<SwitchTaskResult> {
    return this.#broadcasted(super.switchTask(input));
  }

  override submitTask(input: SubmitTaskInput): Promise<TaskMutationResult> {
    return this.#broadcastSubmit(super.submitTask(input));
  }

  override requestTaskDependencyValidation(input: RequestTaskDependencyValidationInput): Promise<TaskMutationResult> {
    return this.#broadcastSubmit(super.requestTaskDependencyValidation(input));
  }

  override updateTaskDependencies(input: UpdateTaskDependenciesInput): Promise<TaskMutationResult> {
    return this.#broadcastDependenciesUpdate(input);
  }

  async #broadcastDependenciesUpdate(
    input: UpdateTaskDependenciesInput
  ): Promise<TaskMutationResult> {
    // Replacing an edge changes the validation history shown on both sides.
    // Capture the old upstream ids before the mutation so a removed edge's
    // Board drawer is refreshed as well as the downstream task itself.
    const previousUpstreamIds = this.#store.transaction((tx) => (
      tx.listTaskDependencies(input.task_id)
        .map((dependency) => dependency.depends_on_task_id)
    ));
    const resolved = await super.updateTaskDependencies(input);
    const upstreamIds = new Set(previousUpstreamIds);
    const currentDependencies = this.#store.transaction((tx) => (
      tx.listTaskDependencies(input.task_id)
    ));
    for (const dependency of currentDependencies) {
      upstreamIds.add(dependency.depends_on_task_id);
    }
    const taskIds = new Set([resolved.task_id, ...upstreamIds]);
    for (const taskId of taskIds) {
      const task = this.#store.getTaskDetail(taskId);
      if (task !== undefined) {
        this.#hub.publishTaskChanged({ task_id: taskId, version: task.version });
      }
    }
    // Keep the SSE payload identity-only; the authenticated Board fetches
    // the sanitized validation contract and complete run history separately.
    for (const upstreamId of upstreamIds) {
      for (const validation of this.#store.listDependencyValidationViews(upstreamId)) {
        if (validation.downstream_task_id === resolved.task_id) {
          this.#hub.publishDependencyValidationChanged({
            validation_id: validation.validation_id,
            upstream_task_id: validation.upstream_task_id,
            downstream_task_id: validation.downstream_task_id,
            status: validation.latest_run?.status ?? validation.status,
            ...(validation.latest_run === null || validation.latest_run === undefined
              ? {}
              : { attempt: validation.latest_run.attempt })
          });
        }
      }
    }
    this.#hub.publishOverviewChanged();
    return resolved;
  }

  async #broadcastSubmit(result: Promise<TaskMutationResult>): Promise<TaskMutationResult> {
    const resolved = await result;
    this.#hub.publishTaskChanged({ task_id: resolved.task_id, version: resolved.version });
    const submittedTask = this.#store.getTaskDetail(resolved.task_id);
    if (submittedTask?.owner !== undefined) {
      for (const repair of this.#store.listDependencyRepairRequests(
        submittedTask.owner,
        submittedTask.repository_id
      ).filter((candidate) => candidate.upstream_task_id === resolved.task_id)) {
        this.#hub.publishDependencyRepairChanged({
          repair_id: repair.repair_id,
          validation_id: repair.validation_id,
          upstream_task_id: repair.upstream_task_id,
          downstream_task_id: repair.downstream_task_id,
          cycle: repair.cycle,
          status: repair.status
        });
      }
    }
    for (const validation of this.#store.listDependencyValidationViews(resolved.task_id)) {
      if (validation.status !== "pending") continue;
      const downstream = this.#store.getTaskDetail(validation.downstream_task_id);
      if (downstream !== undefined) {
        this.#hub.publishTaskChanged({
          task_id: validation.downstream_task_id,
          version: downstream.version
        });
      }
      this.#hub.publishDependencyValidationChanged({
        validation_id: validation.validation_id,
        upstream_task_id: validation.upstream_task_id,
        downstream_task_id: validation.downstream_task_id,
        status: validation.status
      });
    }
    this.#hub.publishOverviewChanged();
    return resolved;
  }

  override receiveDependencyValidation(
    input: DependencyValidationReceiveInput
  ): Promise<DependencyValidationReceiveResult> {
    return this.#broadcastValidation(
      super.receiveDependencyValidation(input),
      input.validation_id
    );
  }

  override checkpointDependencyValidation(
    input: DependencyValidationCheckpointInput
  ): Promise<import("../storage/progress-store.js").DependencyValidationRunRecord> {
    return this.#broadcastValidation(
      super.checkpointDependencyValidation(input),
      input.validation_id
    );
  }

  override completeDependencyValidation(
    input: DependencyValidationCompleteInput
  ): Promise<DependencyValidationCompleteResult> {
    return this.#broadcastValidation(
      super.completeDependencyValidation(input),
      input.validation_id
    );
  }

  override async receiveDependencyRepair(
    input: DependencyRepairReceiveInput
  ): Promise<DependencyRepairReceiveResult> {
    const result = await super.receiveDependencyRepair(input);
    this.#hub.publishTaskChanged({ task_id: result.task_id, version: result.version });
    this.#hub.publishDependencyRepairChanged({
      repair_id: result.repair.repair_id,
      validation_id: result.repair.validation_id,
      upstream_task_id: result.repair.upstream_task_id,
      downstream_task_id: result.repair.downstream_task_id,
      cycle: result.repair.cycle,
      status: result.repair.status
    });
    this.#hub.publishOverviewChanged();
    return result;
  }
}

function describeListenAddress(config: RuntimeConfig): string {
  return `http://${config.host}:${config.port}`;
}

function main(): void {
  const config = createRuntimeConfig();

  let database: SqliteDatabase;
  try {
    database = SqliteDatabase.open(config);
  } catch (error) {
    console.error(
      `Failed to open the platform database at ${config.databasePath}:`
      + ` ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
    return;
  }

  const store: PlatformStore = database.createProgressStore();
  const probe = new RepoProbe();
  const now = (): string => new Date().toISOString();
  // The MCP transport mounts after service construction; resume re-attachment
  // reads live transport ids through this late-bound holder.
  let mcpTransport: MountedMcpTransport | undefined;
  const sessionService = new SessionService(store, config, undefined, (transportSessionId) =>
    mcpTransport?.activeTransportSessions().includes(transportSessionId) === true
  );
  const registryService = new RegistryService(store, now);
  const repositoryBootstrapService = new RepositoryBootstrapService(
    store,
    sessionService,
    registryService
  );
  const boardAuthService = new BoardAuthService(store, { now });
  const projectAccess = new ProjectAccessService(store, { now });
  const hub = new SseHub({
    resolveTaskOwner: (taskId) => store.getTaskDetail(taskId)?.owner,
    resolveTaskProjectId: (taskId) => {
      const task = store.getTaskDetail(taskId);
      return task === undefined
        ? undefined
        : store.getRepository(task.repository_id)?.project_id;
    },
    canViewProject: (projectId, owner) => projectAccess.isProjectViewer(projectId, owner)
  });
  const taskService = new TaskService({ store, probe, projectAccess });
  const mcpTaskService = new BroadcastingTaskService({ store, probe, projectAccess, hub });
  const hostEvidenceService = new HostEvidenceService({ store, config });

  const app = createHttpApp({
    taskService,
    sessionService,
    store,
    registryService,
    boardAuthService,
    projectAccess,
    hostEvidenceService,
    allowedHosts: (() => {
      const hosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
      // Server deployment: comma-separated extra hosts (e.g. "172.16.0.90:47321,nas.example.com:47321")
      const extra = process.env.TASK_MCP_ALLOWED_HOSTS;
      if (extra !== undefined && extra.trim().length > 0) {
        for (const host of extra.split(",").map((h) => h.trim()).filter((h) => h.length > 0)) {
          hosts.push(host);
        }
      }
      return hosts;
    })(),
    sseHub: hub
  });

  const mcp: MountedMcpTransport = mountMcpTransport(app, {
    taskService: mcpTaskService,
    sessionService,
    registryService,
    boardAuthService,
    repositoryBootstrapService,
    hostEvidenceService,
    projectAccess,
    now,
    isRepositoryAllowed: (repositoryId) => (
      store.getRepository(repositoryId) !== undefined
    ),
    getRepositoryPath: (repositoryId) => store.getRepository(repositoryId)?.path,
    getSession: (sessionId) => store.transaction((tx) => tx.getSession(sessionId)),
    listProjectRepositoryIds: (projectId) => store
      .listRepositories()
      .filter((repository) => repository.project_id === projectId)
      .map((repository) => repository.repository_id),
    getRepositoryProjectId: (repositoryId) => store.getRepository(repositoryId)?.project_id,
    getProjectCreator: (projectId) => store.transaction((tx) => tx.getProject(projectId)?.created_by),
    getActiveLease: (sessionId) => store.transaction((tx) => (
      tx.getLeaseBySession(sessionId)
    )),
    resolveSessionByTransport: (transportSessionId) => store.transaction((tx) => (
      tx.getSessionByTransportId(transportSessionId)?.session_id
    )),
    publishOverviewChanged: () => hub.publishOverviewChanged()
  });
  mcpTransport = mcp;

  const staleScanTimer = setInterval(() => {
    sessionService.markStale(now());
  }, STALE_SCAN_INTERVAL_MS);

  const server: Server = app.listen(config.port, config.host);

  let listening = false;
  let shuttingDown = false;

  server.once("listening", () => {
    listening = true;
    console.log(`cli-session-task-mcp listening on ${describeListenAddress(config)}`);
    console.log(`  MCP endpoint: ${describeListenAddress(config)}/mcp`);
    console.log(`  Web board:    ${describeListenAddress(config)}/board`);
    console.log(`  Data dir:     ${config.dataDir}`);
  });

  // Ordered shutdown: HTTP server, then MCP transports, then the stale-scan
  // timer, then SQLite. Task statuses and leases are never touched here.
  async function shutdown(reason: string, exitCode: number): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      if (listening) {
        // SSE clients keep connections open; drop them so close() completes.
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await mcp.close();
      clearInterval(staleScanTimer);
      database.close();
      console.log(`cli-session-task-mcp stopped (${reason})`);
    } catch (error) {
      console.error(
        `Error during shutdown: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      process.exit(exitCode);
    }
  }

  server.once("error", (error: NodeJS.ErrnoException) => {
    process.exitCode = 1;
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${config.port} on ${config.host} is already in use.`
        + " Another cli-session-task-mcp instance (or another process) is likely"
        + " already listening there."
      );
      console.error(
        "This process will not terminate the existing listener."
        + " Stop it manually, then start this process again."
      );
    } else {
      console.error(
        `HTTP server failed to listen on ${describeListenAddress(config)}:`
        + ` ${error.message}`
      );
    }
    void shutdown("listen failed", 1);
  });

  process.on("SIGINT", () => {
    void shutdown("SIGINT", 0);
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });
}

main();
