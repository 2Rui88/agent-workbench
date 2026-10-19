/// <reference types="node" />

import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BoardAuthService } from "../core/board-auth-service.js";
import type { HostEvidenceService } from "../core/host-evidence-service.js";
import type { ProjectAccessService } from "../core/project-access-service.js";
import type { RepositoryBootstrapService } from "../core/repository-bootstrap-service.js";
import type { RegistryService } from "../core/registry-service.js";
import type { SessionService } from "../core/session-service.js";
import {
  PlatformDomainError,
  type TaskService
} from "../core/task-service.js";
import type { ActiveTaskLease, JsonValue, TaskListFilter, SessionRecord } from "../storage/progress-store.js";
import {
  platformErrorSchema,
  type TaskStatus
} from "../shared/task-contracts.js";
import {
  sessionContextInputSchema,
  sessionRebindInputSchema,
  boardPairInputSchema,
  repositoryBootstrapInputSchema,
  repositoryRebindInputSchema,
  repositoryRegisterInputSchema,
  taskAdoptInputSchema,
  taskAttachInputSchema,
  taskCheckpointInputSchema,
  taskConfirmDecisionInputSchema,
  taskConflictsInputSchema,
  taskCreateInputSchema,
  taskGetInputSchema,
  taskRecoveryGetInputSchema,
  operationResultGetInputSchema,
  dependencyRepairListInputSchema,
  dependencyRepairReceiveInputSchema,
  taskListInputSchema,
  dependencyContextGetInputSchema,
  dependencyValidationListInputSchema,
  dependencyValidationReceiveInputSchema,
  dependencyValidationCheckpointInputSchema,
  dependencyValidationCompleteInputSchema,
  taskStartInputSchema,
  taskDependenciesUpdateInputSchema,
  taskSubmitInputSchema,
  taskDependencyValidationRequestInputSchema,
  taskSwitchInputSchema,
  hostKeyRegisterInputSchema,
  worktreeEvidenceChallengeInputSchema,
  worktreeEvidenceSubmitInputSchema,
  projectShareCreateInputSchema,
  projectShareAcceptInputSchema,
  projectMembersListInputSchema,
  projectMemberRemoveInputSchema,
  projectShareRevokeInputSchema
} from "./tool-schemas.js";

/**
 * Client facts captured from the MCP `initialize` handshake of the transport
 * session this server instance serves. The agent cannot override them.
 */
export interface TransportHandshake {
  transportSessionId?: string;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
}

export interface McpServerDeps {
  taskService: TaskService;
  projectAccess?: ProjectAccessService;
  sessionService: SessionService;
  registryService: RegistryService;
  boardAuthService: BoardAuthService;
  repositoryBootstrapService?: RepositoryBootstrapService;
  /** Host-trusted worktree evidence tools; omitted in narrow test setups. */
  hostEvidenceService?: HostEvidenceService;
  now: () => string;
  handshake: TransportHandshake;
  isRepositoryAllowed: (repositoryId: string) => boolean;
  /** Registered root path of a repository, for the session_context
   * worktree-path mismatch warning. Optional so tests can omit it. */
  getRepositoryPath?: (repositoryId: string) => string | undefined;
  getActiveLease: (sessionId: string) => ActiveTaskLease | undefined;
  getSession?: (sessionId: string) => SessionRecord | undefined;
  listProjectRepositoryIds?: (projectId: string) => readonly string[];
  getRepositoryProjectId?: (repositoryId: string) => string | undefined;
  getProjectCreator?: (projectId: string) => string | null | undefined;
  resolveSessionByTransport: (transportSessionId: string) => string | undefined;
  /** Notify Board SSE clients after a successful catalog mutation. */
  publishOverviewChanged?: () => void;
}

export const SERVER_NAME = "cli-session-task-mcp";
export const SERVER_VERSION = "0.1.0";
export const SCHEMA_VERSION = "1";

export const SERVER_INSTRUCTIONS = [
  "在白名单仓库执行多步骤或修改型工作前调用 `session_context`；未登记仓库直接调用 `repository_bootstrap` 完成首次项目、仓库和 Session 初始化；同一 transport 进入同仓库的新 worktree 时调用 `session_rebind`；开始写入前创建或恢复任务；切换或停止前必须 checkpoint；待人工决定必须在当前 Agent 对话中核对，用户明确确认后才能调用 `task_confirm_decision`，不得推断或从看板代填；Agent 只能提交待验收，不能自行标记完成。",
  "",
  "Workflow: call session_context once per transport session to bind a whitelisted repository and worktree; if the repository is unregistered, call repository_bootstrap directly from the Agent. Repeating session_context never changes that binding; use session_rebind while idle for an explicit same-repository, same-owner worktree change, or repository_rebind when the registered root path moved. Use board_pair only when a human asks you to approve a pairing code shown on the Board. Discover work with task_list and task_get, then check contention with task_conflicts. Create new work with task_create (expected_version 0) or adopt legacy work with task_adopt. task_start acquires the task lease after conflict checks; task_checkpoint persists progress and may pause the task; task_confirm_decision records an exact decision only after the human explicitly confirms it in the current Agent conversation; task_switch checkpoints the current task and atomically moves both the lease and session worktree to the target. Pass target_worktree_path when the Agent needs to correct or explicitly choose the target task's worktree scope. task_submit hands a fully verified task over to pending_acceptance for human acceptance. Every write is idempotent per (session_id, operation_id) and guarded by expected_version or an expected current worktree.",
  "Dependency validation workflow: task_submit creates one immutable, non-sensitive validation contract per active task_dependencies edge. For a pending_acceptance submission with late dependency edges, use task_dependency_validation_request with fresh trusted evidence matching the original snapshot to backfill missing cycles without resubmitting. Existing cycles cannot be reset through this tool. Use dependency_validation_list to see only pending requests for the current session owner/repository, then dependency_validation_receive to claim a run (claiming is not passing). Use dependency_validation_checkpoint periodically to persist bounded progress and renew the rolling lease. Finish with dependency_validation_complete using explicit verification evidence that includes command, outcome, summary, and when available revision/target_revision/worktree_path; passed requires non-empty all-passed evidence, rejected requires a reason plus failed evidence, and error leaves the request pending for retry. A retry cap returns a structured capped result with recovery actions while preserving every prior attempt. Validation results update the upstream gate but never set a task to done; the upstream remains pending_acceptance until human acceptance. Requests from an old cycle, an orphan validation without an active task_dependencies link, or a terminal downstream task cannot be claimed/checkpointed/completed. Reuse the same operation_id only for an idempotent retry of the identical call; do not treat pending, rejected, error, superseded, or pending_acceptance as interchangeable states. Human Board validation actions are read-only compatibility paths.",
  "Recovery workflow: call task_recovery_get after resume or context compaction. Continue a leased task only through explicit session succession; never infer takeover from owner or client family. If a write result is unknown, call operation_result_get before choosing a fresh operation_id. A rejected downstream validation creates upstream repair work: list it with dependency_repair_list, claim it with dependency_repair_receive, checkpoint the repaired code with fresh server-verified evidence, then task_submit to create a new validation cycle. An error remains a downstream retry and creates no repair. Only a human can finally accept the task as done.",
  "dependency_context_get reads the immutable cross-task/cross-repository ctx record and ordered synchronization events; ctx never holds a task lease or replaces the business task."
].join("\n");

const readOnlyAnnotations = { readOnlyHint: true } as const;
const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false
} as const;

interface ToolPayload {
  data: unknown;
  taskVersion?: number;
  next: string;
}

interface ToolResponseBody {
  [key: string]: unknown;
  ok: boolean;
  data?: unknown;
  error?: unknown;
  meta: { request_id: string; schema_version: string; task_version?: number };
  next: string;
}

function metaFor(requestId: string, taskVersion?: number) {
  const meta: { request_id: string; schema_version: string; task_version?: number } = {
    request_id: requestId,
    schema_version: SCHEMA_VERSION
  };
  if (taskVersion !== undefined) {
    meta.task_version = taskVersion;
  }
  return meta;
}

function resultOf(body: ToolResponseBody, isError: boolean): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    isError
  };
}

type PlatformErrorBody = z.infer<typeof platformErrorSchema>;

function toPlatformErrorBody(error: unknown): PlatformErrorBody {
  if (error instanceof PlatformDomainError) {
    const body: PlatformErrorBody = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      evidence: [...error.evidence],
      recovery_actions: [...error.recovery_actions]
    };
    if (error.current_version !== undefined) {
      body.current_version = error.current_version;
    }
    return body;
  }
  if (error instanceof z.ZodError) {
    return {
      code: "INVALID_INPUT",
      message: `Tool input rejected: ${error.message}`,
      retryable: false,
      evidence: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      recovery_actions: ["Fix the reported input fields and retry the tool call."]
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    evidence: [],
    recovery_actions: ["Retry the tool call; if it keeps failing, restart the session."]
  };
}

/**
 * Wraps a tool body so every handler only parses input, calls a service, and
 * shapes the response. PlatformDomainError fields pass through unchanged so
 * agents always see stable error codes.
 */
async function executeTool(work: () => Promise<ToolPayload>, stableRequestId?: string): Promise<CallToolResult> {
  const requestId = stableRequestId ?? randomUUID();
  try {
    const payload = await work();
    return resultOf(
      { ok: true, data: payload.data, meta: metaFor(requestId, payload.taskVersion), next: payload.next },
      false
    );
  } catch (error) {
    const body = toPlatformErrorBody(error);
    return resultOf(
      {
        ok: false,
        error: body,
        meta: metaFor(requestId),
        next: body.recovery_actions[0] ?? ""
      },
      true
    );
  }
}

/**
 * The server cannot stat remote worktrees, so a session bound to a
 * registered repository whose path does not contain the declared worktree
 * gets an explicit warning instead of a hard failure — the agent may be in
 * a legitimate sibling worktree, or it may have borrowed an unrelated
 * repository and would file tasks under the wrong project.
 */
function worktreePathWarnings(
  deps: McpServerDeps,
  args: { repository_id: string; worktree_path: string }
): string[] {
  const registeredPath = deps.getRepositoryPath?.(args.repository_id);
  if (registeredPath === undefined) {
    return [];
  }
  const worktree = args.worktree_path.replace(/\/+$/, "");
  const root = registeredPath.replace(/\/+$/, "");
  if (worktree === root || worktree.startsWith(`${root}/`)) {
    return [];
  }
  return [
    `worktree_path ${args.worktree_path} is not under the registered path of`
    + ` repository ${args.repository_id} (${registeredPath}). If this workspace`
    + ` belongs to a different project, do NOT create tasks here — ask the user`
    + ` for the project name and use repository_bootstrap (or`
    + ` repository_register from an existing session) before creating tasks.`
  ];
}

function sessionContextData(
  deps: McpServerDeps,
  transportSessionId: string,
  args: z.infer<typeof sessionContextInputSchema>
) {
  const session = deps.sessionService.sessionContext({
    transport_session_id: transportSessionId,
    client_name: deps.handshake.clientName ?? "unknown-agent",
    client_version: deps.handshake.clientVersion ?? "0.0.0",
    protocol_version: deps.handshake.protocolVersion ?? "2025-06-18",
    ...(deps.handshake.capabilities === undefined
      ? {}
      : { capabilities: deps.handshake.capabilities }),
    workspace_path: args.workspace_path,
    repository_id: args.repository_id,
    worktree_path: args.worktree_path,
    ...(args.owner !== undefined ? { owner: args.owner } : {}),
    ...(args.successor_session_id !== undefined ? { successor_session_id: args.successor_session_id } : {}),
    ...(args.successor_ctx_id !== undefined ? { successor_ctx_id: args.successor_ctx_id } : {}),
    ...(args.resume_session_id !== undefined ? { resume_session_id: args.resume_session_id } : {}),
    ...(args.resume_token !== undefined ? { resume_token: args.resume_token } : {})
  }, deps.now());
  const lease = deps.getActiveLease(session.session_id);
  return {
    session_id: session.session_id,
    transport_session_id: session.transport_session_id,
    repository_id: session.repository_id,
    workspace_path: session.workspace_path ?? null,
    worktree_path: session.worktree_path ?? null,
    resume_token: session.resume_token ?? null,
    client: {
      name: session.client_name,
      version: session.client_version,
      family: session.client_family
    },
    protocol_version: session.protocol_version,
    started_at: session.started_at,
    last_activity_at: session.last_activity_at,
    stale: session.stale_at !== undefined,
    stale_at: session.stale_at ?? null,
    active_lease: lease ?? null
  };
}

function requireBoundSessionId(
  deps: McpServerDeps,
  extra: { sessionId?: string },
  claimedSessionId: string
): void {
  const transportSessionId = requireTransportSessionId(deps, extra.sessionId);
  const boundSessionId = deps.resolveSessionByTransport(transportSessionId);
  if (boundSessionId !== claimedSessionId) {
    throw new PlatformDomainError(
      "SESSION_MISMATCH",
      "session_id does not belong to this transport session",
      {
        evidence: [claimedSessionId],
        recovery_actions: [
          "Call session_context on this connection and use the session_id it returns."
        ]
      }
    );
  }
}

function requireBoundSession(
  deps: McpServerDeps,
  extra: { sessionId?: string },
  claimedSessionId: string
): SessionRecord {
  requireBoundSessionId(deps, extra, claimedSessionId);
  const session = deps.getSession?.(claimedSessionId);
  if (session === undefined) {
    throw new PlatformDomainError(
      "SESSION_NOT_FOUND",
      "The bound platform session no longer exists",
      { evidence: [claimedSessionId], recovery_actions: ["Call session_context to create a fresh session."] }
    );
  }
  return session;
}

function requireTransportSessionId(
  deps: McpServerDeps,
  transportSessionId: string | undefined
): string {
  if (transportSessionId === undefined) {
    throw new PlatformDomainError(
      "SESSION_NOT_FOUND",
      "This tool requires an initialized streamable HTTP transport session",
      {
        evidence: ["missing transport session id"],
        recovery_actions: ["Connect or reconnect over POST /mcp, then call session_context."]
      }
    );
  }
  return transportSessionId;
}

function taskNotFound(taskId: string): PlatformDomainError {
  return new PlatformDomainError(
    "TASK_NOT_FOUND",
    `Task ${taskId} does not exist`,
    {
      evidence: [taskId],
      recovery_actions: ["Re-read the task list and retry with an existing task."]
    }
  );
}

function nextForTaskStatus(status: TaskStatus): string {
  switch (status) {
    case "backlog":
    case "paused":
    case "blocked":
      return "Attach with task_attach and start the task with task_start when ready.";
    case "in_progress":
    case "waiting_human":
    case "verifying":
      return "Continue the active task and persist progress with task_checkpoint.";
    case "pending_acceptance":
      return "Wait for human acceptance on the web board.";
    case "done":
    case "cancelled":
      return "This task is terminal; inspect its checkpoint or choose another task.";
  }
}

export function registerTools(server: McpServer, deps: McpServerDeps): void {
  server.registerTool(
    "session_context",
    {
      description: "Bind this transport session to the whitelisted repository this workspace ACTUALLY belongs to. Client metadata comes from the MCP handshake and cannot be overridden. Pass `owner` (the value of `git config user.name` on YOUR machine) so tasks created in this session are attributed to you — the server runs remotely and cannot read your local git config. If the repository is not registered yet, use repository_bootstrap to initialize it directly; do not bind an unrelated repository.",
      inputSchema: sessionContextInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = sessionContextInputSchema.parse(rawArgs);
      const transportSessionId = requireTransportSessionId(
        deps,
        extra.sessionId ?? deps.handshake.transportSessionId
      );
      if (!deps.isRepositoryAllowed(args.repository_id)) {
        throw new PlatformDomainError(
          "REPOSITORY_NOT_ALLOWED",
          `Repository ${args.repository_id} is not registered`,
          {
            evidence: [args.repository_id],
            recovery_actions: [
              "If the user wants this workspace tracked, ask them for the"
                + " project name and register it with repository_register,"
                + " then retry session_context. Do not bind an unrelated"
                + " repository — tasks would land in the wrong project."
            ]
          }
        );
      }
      const data = sessionContextData(deps, transportSessionId, args);
      deps.publishOverviewChanged?.();
      const warnings = worktreePathWarnings(deps, args);
      const warning = warnings[0];
      return {
        data: warnings.length > 0 ? { ...data, warnings } : data,
        next: warning !== undefined
          ? warning
          : "Create a task with task_create or adopt legacy work with task_adopt before writing."
      };
    })
  );

  server.registerTool(
    "session_rebind",
    {
      description: "Explicitly move this transport's existing platform session to another worktree in the same registered repository. The session must be idle; owner and repository cannot change. Pass the current worktree as expected_worktree_path and a fresh operation_id. Use task_switch instead when the session holds an active task lease.",
      inputSchema: sessionRebindInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = sessionRebindInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      if (!deps.isRepositoryAllowed(args.repository_id)) {
        throw new PlatformDomainError(
          "REPOSITORY_NOT_ALLOWED",
          `Repository ${args.repository_id} is not registered`,
          {
            evidence: [args.repository_id],
            recovery_actions: [
              "Register the repository first, or open a new transport for another repository."
            ]
          }
        );
      }
      const result = deps.sessionService.rebindSession({
        session_id: args.session_id,
        operation_id: args.operation_id,
        repository_id: args.repository_id,
        owner: args.owner,
        expected_worktree_path: args.expected_worktree_path,
        workspace_path: args.workspace_path,
        worktree_path: args.worktree_path
      }, deps.now());
      deps.publishOverviewChanged?.();
      const warnings = worktreePathWarnings(deps, args);
      return {
        data: warnings.length > 0 ? { ...result, warnings } : result,
        next: warnings[0]
          ?? "Run task_conflicts, then attach and start the task for the rebound worktree."
      };
    })
  );

  server.registerTool(
    "board_pair",
    {
      description: "Approve a one-time Board pairing code for the owner already bound to this MCP transport by session_context. Call this only when the human asks to pair the Board they are viewing.",
      inputSchema: boardPairInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = boardPairInputSchema.parse(rawArgs);
      const transportSessionId = requireTransportSessionId(
        deps,
        extra.sessionId ?? deps.handshake.transportSessionId
      );
      const sessionId = deps.resolveSessionByTransport(transportSessionId);
      if (sessionId === undefined) {
        throw new PlatformDomainError(
          "SESSION_NOT_FOUND",
          "Board pairing requires a platform session bound by session_context",
          {
            recovery_actions: [
              "Call session_context with this worktree and Git owner, then retry board_pair."
            ]
          }
        );
      }
      const result = deps.boardAuthService.approvePairing(
        args.pairing_code,
        sessionId
      );
      return {
        data: { paired: true, owner: result.owner, expires_at: result.expires_at },
        next: "Tell the human the pairing is approved; the Board will finish signing in automatically."
      };
    })
  );

  server.registerTool(
    "repository_bootstrap",
    {
      description: "Bootstrap an unregistered repository directly from the Agent. Atomically creates or matches the project, registers the exact repository_id, and binds this MCP transport to the new session. Human intervention is only required later for final task acceptance.",
      inputSchema: repositoryBootstrapInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = repositoryBootstrapInputSchema.parse(rawArgs);
      const service = deps.repositoryBootstrapService;
      if (service === undefined) {
        throw new PlatformDomainError(
          "BOOTSTRAP_NOT_CONFIGURED",
          "Repository bootstrap is not configured on this server",
          {
            recovery_actions: ["Configure the bootstrap service and restart the server."]
          }
        );
      }
      const transportSessionId = requireTransportSessionId(
        deps,
        extra.sessionId ?? deps.handshake.transportSessionId
      );
      const result = service.bootstrapRepository({
        transport_session_id: transportSessionId,
        client_name: deps.handshake.clientName ?? "unknown-agent",
        client_version: deps.handshake.clientVersion ?? "0.0.0",
        protocol_version: deps.handshake.protocolVersion ?? "2025-06-18",
        ...(deps.handshake.capabilities === undefined
          ? {}
          : { capabilities: deps.handshake.capabilities }),
        owner: args.owner,
        operation_id: args.operation_id,
        project_name: args.project_name,
        ...(args.project_id === undefined ? {} : { project_id: args.project_id }),
        repository_id: args.repository_id,
        repository_name: args.repository_name,
        path: args.path,
        workspace_path: args.workspace_path,
        worktree_path: args.worktree_path
      }, deps.now());
      deps.publishOverviewChanged?.();
      return {
        data: result,
        next: "Repository bootstrap completed; continue with task_create or task_adopt using this session_id."
      };
    })
  );

  server.registerTool(
    "repository_register",
    {
      description: "Register an additional repository under a project from an existing bound session. For an unregistered first repository, use repository_bootstrap directly. Pass a fresh operation_id so a lost success response can be retried safely.",
      inputSchema: repositoryRegisterInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = repositoryRegisterInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const result = deps.registryService.registerRepository({
        session_id: args.session_id,
        operation_id: args.operation_id,
        project_name: args.project_name,
        repository_id: args.repository_id,
        repository_name: args.repository_name,
        path: args.path,
        ...(args.project_id !== undefined ? { project_id: args.project_id } : {})
      });
      deps.publishOverviewChanged?.();
      return {
        data: {
          project: result.project,
          created_project: result.created_project,
          repository: result.repository
        },
        next: `Call session_context with repository_id ${args.repository_id}`
          + ` and this workspace's paths to bind the session.`
      };
    })
  );

  server.registerTool(
    "repository_rebind",
    {
      description: "Update the registered root path after a repository moves. Requires the existing bound session and exact Git owner; repository_id never changes.",
      inputSchema: repositoryRebindInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = repositoryRebindInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const repository = deps.registryService.rebindRepository({
        session_id: args.session_id,
        operation_id: args.operation_id,
        owner: args.owner,
        repository_id: args.repository_id,
        path: args.path,
        ...(args.repository_name === undefined ? {} : { repository_name: args.repository_name })
      });
      deps.publishOverviewChanged?.();
      return {
        data: { repository, rebound: true },
        next: "Call session_rebind with the new worktree path before creating tasks."
      };
    })
  );

  server.registerTool(
    "project_share_create",
    {
      description: "Create a one-time, expiring project share token. Only the project creator may create shares.",
      inputSchema: projectShareCreateInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => {
      const stableRequestId = typeof rawArgs === "object" && rawArgs !== null
        && "operation_id" in rawArgs && typeof rawArgs.operation_id === "string"
        ? rawArgs.operation_id
        : undefined;
      return executeTool(async () => {
        const args = projectShareCreateInputSchema.parse(rawArgs);
        const session = requireBoundSession(deps, extra, args.session_id);
        if (session.owner === undefined || deps.projectAccess === undefined) {
          throw new PlatformDomainError("PROJECT_ACCESS_REQUIRED", "Project collaboration is not configured for this session");
        }
        return {
          data: { share: deps.projectAccess.createShare(args.project_id, session.owner) },
          next: "Send the one-time token to the collaborator, then have them call project_share_accept."
        };
      }, stableRequestId);
    }
  );

  server.registerTool(
    "project_share_accept",
    {
      description: "Accept a one-time project share token for the authenticated owner.",
      inputSchema: projectShareAcceptInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => {
      const stableRequestId = typeof rawArgs === "object" && rawArgs !== null
        && "operation_id" in rawArgs && typeof rawArgs.operation_id === "string"
        ? rawArgs.operation_id
        : undefined;
      return executeTool(async () => {
        const args = projectShareAcceptInputSchema.parse(rawArgs);
        const session = requireBoundSession(deps, extra, args.session_id);
        if (session.owner === undefined || deps.projectAccess === undefined) {
          throw new PlatformDomainError("PROJECT_ACCESS_REQUIRED", "Project collaboration is not configured for this session");
        }
        return {
          data: { member: deps.projectAccess.acceptShare(args.token, session.owner) },
          next: "Call task_list with scope=project and the shared project_id to inspect all project tasks."
        };
      }, stableRequestId);
    }
  );

  server.registerTool(
    "project_members_list",
    {
      description: "List active members of a project visible to the authenticated owner.",
      inputSchema: projectMembersListInputSchema,
      annotations: readOnlyAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = projectMembersListInputSchema.parse(rawArgs);
      const session = requireBoundSession(deps, extra, args.session_id);
      if (session.owner === undefined || deps.projectAccess === undefined) {
        throw new PlatformDomainError("PROJECT_ACCESS_REQUIRED", "Project collaboration is not configured for this session");
      }
      return {
        data: { members: deps.projectAccess.listMembers(args.project_id, session.owner) },
        next: "Shared members can read project tasks, but only each task owner can mutate it."
      };
    })
  );

  server.registerTool(
    "project_member_remove",
    {
      description: "Revoke a project member. Only the project creator may remove members.",
      inputSchema: projectMemberRemoveInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => {
      const stableRequestId = typeof rawArgs === "object" && rawArgs !== null
        && "operation_id" in rawArgs && typeof rawArgs.operation_id === "string"
        ? rawArgs.operation_id
        : undefined;
      return executeTool(async () => {
        const args = projectMemberRemoveInputSchema.parse(rawArgs);
        const session = requireBoundSession(deps, extra, args.session_id);
        if (session.owner === undefined || deps.projectAccess === undefined) {
          throw new PlatformDomainError("PROJECT_ACCESS_REQUIRED", "Project collaboration is not configured for this session");
        }
        return {
          data: { revoked: deps.projectAccess.removeMember(args.project_id, args.owner, session.owner) },
          next: "The removed owner must accept a new project share before reading or mutating the project."
        };
      }, stableRequestId);
    }
  );

  server.registerTool(
    "project_share_revoke",
    {
      description: "Revoke an unused project share. Only the project creator may revoke shares.",
      inputSchema: projectShareRevokeInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => {
      const stableRequestId = typeof rawArgs === "object" && rawArgs !== null
        && "operation_id" in rawArgs && typeof rawArgs.operation_id === "string"
        ? rawArgs.operation_id
        : undefined;
      return executeTool(async () => {
        const args = projectShareRevokeInputSchema.parse(rawArgs);
        const session = requireBoundSession(deps, extra, args.session_id);
        if (session.owner === undefined || deps.projectAccess === undefined) {
          throw new PlatformDomainError("PROJECT_ACCESS_REQUIRED", "Project collaboration is not configured for this session");
        }
        return {
          data: { revoked: deps.projectAccess.revokeShare(args.project_id, args.share_id, session.owner) },
          next: "The revoked token can no longer be accepted; create a new share if needed."
        };
      }, stableRequestId);
    }
  );

  server.registerTool(
    "task_list",
    {
      description: "List tasks, optionally filtered by repository, status, and priority. Use scope=project with a bound session to read every owner's task in a shared project.",
      inputSchema: taskListInputSchema,
      annotations: readOnlyAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskListInputSchema.parse(rawArgs);
      if (args.scope === "project") {
        if (args.session_id === undefined || args.project_id === undefined) {
          throw new PlatformDomainError("INVALID_INPUT", "project scope requires session_id and project_id");
        }
        const session = requireBoundSession(deps, extra, args.session_id);
        if (session.owner === undefined || deps.projectAccess === undefined) {
          throw new PlatformDomainError("PROJECT_ACCESS_REQUIRED", "Project collaboration is not configured for this session");
        }
        if (args.owner !== undefined && args.owner !== session.owner) {
          throw new PlatformDomainError("OWNER_MISMATCH", "owner must match the bound session owner");
        }
        deps.projectAccess.assertProjectViewer(args.project_id, session.owner);
        const repositoryIds = deps.listProjectRepositoryIds?.(args.project_id) ?? [];
        if (args.repository_id !== undefined && !repositoryIds.includes(args.repository_id)) {
          throw new PlatformDomainError("REPOSITORY_NOT_ALLOWED", "repository_id is not part of the requested project");
        }
        const selectedRepositoryIds = args.repository_id === undefined
          ? repositoryIds
          : [args.repository_id];
        let projectTasks = (await Promise.all(selectedRepositoryIds.map((repositoryId) => (
          deps.taskService.listTasks({ repositoryId })
        )))).flat();
        if (args.status !== undefined && args.status.length > 0) {
          const statuses = new Set(args.status);
          projectTasks = projectTasks.filter((task) => statuses.has(task.status));
        }
        if (args.priority !== undefined && args.priority.length > 0) {
          const priorities = new Set(args.priority);
          projectTasks = projectTasks.filter((task) => priorities.has(task.priority));
        }
        return {
          data: { tasks: projectTasks },
          next: "Call task_get on the task you plan to work on; mutations remain limited to that task's owner."
        };
      }
      const filter: TaskListFilter = {};
      if (args.owner !== undefined) {
        filter.owner = args.owner;
      }
      if (args.repository_id !== undefined) {
        filter.repositoryId = args.repository_id;
      }
      if (args.status !== undefined && args.status.length > 0) {
        filter.statuses = args.status;
      }
      let tasks = await deps.taskService.listTasks(filter);
      if (args.priority !== undefined && args.priority.length > 0) {
        const priorities = new Set(args.priority);
        tasks = tasks.filter((task) => priorities.has(task.priority));
      }
      return {
        data: { tasks },
        next: "Call task_get on the task you plan to work on."
      };
    })
  );

  server.registerTool(
    "dependency_context_get",
    {
      description: "Read the immutable cross-task dependency context and ordered synchronization events for a task pair.",
      inputSchema: dependencyContextGetInputSchema,
      annotations: readOnlyAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = dependencyContextGetInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const context = await deps.taskService.getDependencyContext(args.session_id, args.ctx_id);
      if (context === undefined) {
        throw new PlatformDomainError("DEPENDENCY_VALIDATION_NOT_FOUND", `Dependency context ${args.ctx_id} was not found`, {
          evidence: [args.ctx_id]
        });
      }
      return {
        data: context,
        next: "Use the ordered context events to reconcile dependency state before continuing the task."
      };
    })
  );

  server.registerTool(
    "dependency_validation_list",
    {
      description: "List pending dependency validation requests for the owner and repository bound to this MCP session. The latest run (if any) is included; listing never changes validation state.",
      inputSchema: dependencyValidationListInputSchema,
      annotations: readOnlyAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = dependencyValidationListInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const validations = await deps.taskService.listDependencyValidationRequests({
        session_id: args.session_id,
        owner: args.owner,
        repository_id: args.repository_id
      });
      return {
        data: { validations },
        next: validations.length === 0
          ? "No pending dependency validations are available for this session."
          : "Receive a validation request to claim its latest run, then checkpoint progress before completing it."
      };
    })
  );

  server.registerTool(
    "dependency_validation_receive",
    {
      description: "Claim a pending dependency validation run for this owner and bound session. Receiving is only a claim, not a pass or final response.",
      inputSchema: dependencyValidationReceiveInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => {
      const stableRequestId = typeof rawArgs === "object" && rawArgs !== null
        && "operation_id" in rawArgs && typeof rawArgs.operation_id === "string"
        ? rawArgs.operation_id
        : undefined;
      return executeTool(async () => {
        const args = dependencyValidationReceiveInputSchema.parse(rawArgs);
        requireBoundSessionId(deps, extra, args.session_id);
        const result = await deps.taskService.receiveDependencyValidation(args);
        return {
          data: result,
          next: "Validation run claimed; checkpoint progress while working, then complete with passed, rejected, or error."
        };
      }, stableRequestId);
    }
  );

  server.registerTool(
    "dependency_validation_checkpoint",
    {
      description: "Persist dependency validation progress and renew its lease. The run remains claimed/running until completion.",
      inputSchema: dependencyValidationCheckpointInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => {
      const stableRequestId = typeof rawArgs === "object" && rawArgs !== null
        && "operation_id" in rawArgs && typeof rawArgs.operation_id === "string"
        ? rawArgs.operation_id
        : undefined;
      return executeTool(async () => {
        const args = dependencyValidationCheckpointInputSchema.parse(rawArgs);
        requireBoundSessionId(deps, extra, args.session_id);
        const result = await deps.taskService.checkpointDependencyValidation({
          session_id: args.session_id,
          operation_id: args.operation_id,
          validation_id: args.validation_id,
          owner: args.owner,
          run_id: args.run_id,
          progress: args.progress as JsonValue
        });
        return {
          data: result,
          next: "Progress checkpoint saved; continue the run or complete the validation before the lease expires."
        };
      }, stableRequestId);
    }
  );

  server.registerTool(
    "dependency_validation_complete",
    {
      description: "Complete a claimed dependency validation with passed, rejected, or error and verification evidence. An error leaves the request pending for retry; only human acceptance ultimately clears the upstream task gate.",
      inputSchema: dependencyValidationCompleteInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => {
      const stableRequestId = typeof rawArgs === "object" && rawArgs !== null
        && "operation_id" in rawArgs && typeof rawArgs.operation_id === "string"
        ? rawArgs.operation_id
        : undefined;
      return executeTool(async () => {
        const args = dependencyValidationCompleteInputSchema.parse(rawArgs);
        requireBoundSessionId(deps, extra, args.session_id);
        const result = await deps.taskService.completeDependencyValidation({
          session_id: args.session_id,
          operation_id: args.operation_id,
          validation_id: args.validation_id,
          owner: args.owner,
          run_id: args.run_id,
          status: args.status,
          verification: args.verification,
          ...(args.reason === undefined ? {} : { reason: args.reason })
        });
        return {
          data: result,
          next: "Validation completion processed; inspect the returned run/request state and follow the next workflow step."
        };
      }, stableRequestId);
    }
  );

  server.registerTool(
    "operation_result_get",
    {
      description: "Read the durable result of an operation from the current session or its explicit predecessor chain after an uncertain client outcome.",
      inputSchema: operationResultGetInputSchema,
      annotations: readOnlyAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = operationResultGetInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const operationResult = await deps.taskService.getOperationResult(args);
      return {
        data: { operation_result: operationResult ?? null },
        next: operationResult === undefined
          ? "No durable result was found; inspect task state before choosing a fresh operation_id."
          : "Use this result to recover the prior call outcome; reuse the operation_id only for the exact original request."
      };
    })
  );

  server.registerTool(
    "task_get",
    {
      description: "Read one task with its status, version, checkpoint, and scopes.",
      inputSchema: taskGetInputSchema,
      annotations: readOnlyAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskGetInputSchema.parse(rawArgs);
      const detail = await deps.taskService.getTask(args.task_id);
      if (detail === undefined) {
        throw taskNotFound(args.task_id);
      }
      if (args.session_id !== undefined && deps.projectAccess !== undefined) {
        const session = requireBoundSession(deps, extra, args.session_id);
        const projectId = deps.getRepositoryProjectId?.(detail.repository_id);
        const creator = projectId === undefined ? undefined : deps.getProjectCreator?.(projectId);
        if (projectId !== undefined && creator !== undefined && creator !== null && session.owner !== undefined) {
          deps.projectAccess.assertProjectViewer(projectId, session.owner);
        }
      }
      return {
        data: { task: detail },
        taskVersion: detail.version,
        next: nextForTaskStatus(detail.status)
      };
    })
  );

  server.registerTool(
    "task_recovery_get",
    {
      description: "Assemble the authoritative task continuation packet, including checkpoint attempts, lease/session identity, code evidence freshness, pending decisions, dependency gate, active repair, recent events, and next action.",
      inputSchema: taskRecoveryGetInputSchema,
      annotations: readOnlyAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskRecoveryGetInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const recovery = await deps.taskService.getTaskRecovery(args);
      return {
        data: { recovery },
        taskVersion: recovery.task.version,
        next: recovery.next_action
      };
    })
  );

  server.registerTool(
    "dependency_repair_list",
    {
      description: "List current rejected downstream validations that require repair by the upstream task owner. Reading does not claim work.",
      inputSchema: dependencyRepairListInputSchema,
      annotations: readOnlyAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = dependencyRepairListInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const repairs = await deps.taskService.listDependencyRepairRequests({
        session_id: args.session_id,
        owner: args.owner,
        ...(args.repository_id === undefined
          ? {}
          : { repository_id: args.repository_id })
      });
      return {
        data: { repairs },
        next: repairs.length === 0
          ? "No current upstream repair is waiting."
          : "Claim one current repair with dependency_repair_receive, then checkpoint and submit the repaired task normally."
      };
    })
  );

  server.registerTool(
    "dependency_repair_receive",
    {
      description: "Claim one current rejected validation as upstream repair work. This atomically reopens the pending_acceptance task, acquires its normal task lease, and preserves human final acceptance.",
      inputSchema: dependencyRepairReceiveInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = dependencyRepairReceiveInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const result = await deps.taskService.receiveDependencyRepair(args);
      return {
        data: result,
        taskVersion: result.version,
        next: "Fix the rejected validation, checkpoint fresh evidence, then call task_submit to open a new validation cycle."
      };
    })
  );

  server.registerTool(
    "task_conflicts",
    {
      description: "Report conflicts either for an existing task_id (probes the session worktree) or for a proposed scope that has no task yet. Provide exactly one of task_id or proposed.",
      inputSchema: taskConflictsInputSchema,
      annotations: readOnlyAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskConflictsInputSchema.parse(rawArgs);
      const transportSessionId = requireTransportSessionId(deps, extra.sessionId);
      const sessionId = deps.resolveSessionByTransport(transportSessionId);
      if (sessionId === undefined) {
        throw new PlatformDomainError(
          "SESSION_NOT_FOUND",
          "No platform session is bound to this transport session",
          {
            evidence: [transportSessionId],
            recovery_actions: ["Call session_context before checking conflicts."]
          }
        );
      }
      const proposed = args.proposed;
      const input = args.task_id !== undefined
        ? { session_id: sessionId, task_id: args.task_id }
        : {
          session_id: sessionId,
          // superRefine guarantees `proposed` whenever task_id is absent.
          proposed: {
            repository_id: proposed!.repository_id,
            worktree_path: proposed!.worktree_path,
            ...(proposed!.scopes === undefined ? {} : { scopes: proposed!.scopes }),
            ...(proposed!.changed_files === undefined
              ? {}
              : { changed_files: proposed!.changed_files })
          }
        };
      const report = await deps.taskService.checkTaskConflicts(input);
      const next = report.level === "none"
        ? "Start the task with task_start."
        : "Resolve the conflict or acknowledge its warning codes before task_start.";
      return { data: { conflict: report }, next };
    })
  );

  server.registerTool(
    "task_attach",
    {
      description: "Attach the session to an existing task in a given role before starting it.",
      inputSchema: taskAttachInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskAttachInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const detail = await deps.taskService.getTask(args.task_id);
      if (detail === undefined) {
        throw taskNotFound(args.task_id);
      }
      if (detail.version !== args.expected_version) {
        throw new PlatformDomainError(
          "TASK_VERSION_CONFLICT",
          `Task ${args.task_id} is not at expected version ${args.expected_version}`,
          {
            current_version: String(detail.version),
            evidence: [`task ${args.task_id} is at version ${detail.version}`],
            recovery_actions: ["Re-read the task and retry with its current version."]
          }
        );
      }
      const result = await deps.taskService.attachTask({
        session_id: args.session_id,
        operation_id: args.operation_id,
        task_id: args.task_id,
        role: args.role
      });
      return {
        data: result,
        taskVersion: result.version,
        next: "Start the attached task with task_start."
      };
    })
  );

  server.registerTool(
    "task_create",
    {
      description: "Create a backlog task in a whitelisted repository with goal, acceptance criteria, and the first next_action. expected_version must be 0.",
      inputSchema: taskCreateInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskCreateInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const result = await deps.taskService.createTask({
        session_id: args.session_id,
        operation_id: args.operation_id,
        expected_version: 0,
        ...(args.owner !== undefined ? { owner: args.owner } : {}),
        repository_id: args.repository_id,
        title: args.title,
        goal: args.goal,
        acceptance_criteria: args.acceptance_criteria,
        next_action: args.next_action,
        priority: args.priority,
        ...(args.scopes === undefined ? {} : { scopes: args.scopes }),
        ...(args.dependencies === undefined ? {} : { dependencies: args.dependencies })
      });
      return {
        data: result,
        taskVersion: result.version,
        next: "Attach and start the new task with task_start when ready."
      };
    })
  );

  server.registerTool(
    "task_adopt",
    {
      description: "Adopt a legacy in-flight task under a legacy_import_key, restoring its checkpoint and repo snapshot, with goal, acceptance criteria, scopes, and dependencies.",
      inputSchema: taskAdoptInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskAdoptInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const result = await deps.taskService.adoptTask({
        session_id: args.session_id,
        operation_id: args.operation_id,
        expected_version: 0,
        ...(args.owner !== undefined ? { owner: args.owner } : {}),
        legacy_import_key: args.legacy_import_key,
        source_session_label: args.source_session_label,
        project_id: args.project_id,
        repository_id: args.repository_id,
        worktree_path: args.worktree_path,
        normalized_title: args.normalized_title,
        ...(args.title === undefined ? {} : { title: args.title }),
        goal: args.goal,
        acceptance_criteria: args.acceptance_criteria,
        priority: args.priority,
        status: args.status,
        checkpoint: args.checkpoint,
        snapshot: {
          head_commit: args.snapshot.head_commit,
          ...(args.snapshot.repository_path === undefined
            ? {}
            : { repository_path: args.snapshot.repository_path }),
          ...(args.snapshot.captured_at === undefined
            ? {}
            : { captured_at: args.snapshot.captured_at })
        },
        ...(args.scopes === undefined ? {} : { scopes: args.scopes }),
        ...(args.dependencies === undefined ? {} : { dependencies: args.dependencies })
      });
      return {
        data: result,
        taskVersion: result.version,
        next: "Continue the adopted task and checkpoint progress with task_checkpoint."
      };
    })
  );

  server.registerTool(
    "task_confirm_decision",
    {
      description: "仅当用户在当前 Agent 对话中明确确认问题和最终决定后，记录一项待决定内容。Record one exact pending decision only after the human explicitly confirms both the question and final decision in the current Agent conversation. Never infer consent, reuse an older conversation, or call this from a Board action.",
      inputSchema: taskConfirmDecisionInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskConfirmDecisionInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const result = await deps.taskService.confirmTaskDecision(args);
      const task = await deps.taskService.getTask(result.task_id);
      const remaining = task?.checkpoint?.pending_decisions.length ?? 0;
      return {
        data: result,
        taskVersion: result.version,
        next: remaining === 0
          ? "Decision recorded; run task_start to resume the task when ready."
          : `Decision recorded; confirm the remaining ${remaining} decision(s) with the human.`
      };
    })
  );

  server.registerTool(
    "task_start",
    {
      description: "Move a task to in_progress and acquire its lease after repo probing and conflict checks.",
      inputSchema: taskStartInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskStartInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const result = await deps.taskService.startTask({
        session_id: args.session_id,
        operation_id: args.operation_id,
        task_id: args.task_id,
        expected_version: args.expected_version,
        ...(args.acknowledged_warning_codes === undefined
          ? {}
          : { acknowledged_warning_codes: args.acknowledged_warning_codes })
      });
      return {
        data: result,
        taskVersion: result.version,
        next: "Work in the worktree and persist progress with task_checkpoint."
      };
    })
  );

  server.registerTool(
    "task_checkpoint",
    {
      description: "Persist a structured checkpoint (and repo snapshot) on a task, optionally moving it to a non-terminal status.",
      inputSchema: taskCheckpointInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskCheckpointInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const result = await deps.taskService.checkpointTask({
        session_id: args.session_id,
        operation_id: args.operation_id,
        task_id: args.task_id,
        expected_version: args.expected_version,
        checkpoint: args.checkpoint,
        ...(args.target_status === undefined ? {} : { target_status: args.target_status })
      });
      return {
        data: result,
        taskVersion: result.version,
        next: "Continue work, switch with task_switch, or submit with task_submit."
      };
    })
  );

  server.registerTool(
    "task_switch",
    {
      description: "Checkpoint the current task, release its lease, and start the target task under the session lease. Pass target_worktree_path to explicitly choose and atomically replace the target task's worktree scope; omit it to use the target task's existing scope or the current Session worktree for backward compatibility.",
      inputSchema: taskSwitchInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskSwitchInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const result = await deps.taskService.switchTask({
        session_id: args.session_id,
        operation_id: args.operation_id,
        task_id: args.task_id,
        expected_version: args.expected_version,
        checkpoint: args.checkpoint,
        target_task_id: args.target_task_id,
        target_expected_version: args.target_expected_version,
        ...(args.target_worktree_path === undefined
          ? {}
          : { target_worktree_path: args.target_worktree_path }),
        ...(args.acknowledged_warning_codes === undefined
          ? {}
          : { acknowledged_warning_codes: args.acknowledged_warning_codes })
      });
      return {
        data: result,
        taskVersion: result.version,
        next: "Continue the target task and checkpoint again before the next switch."
      };
    })
  );

  server.registerTool(
    "task_dependencies_update",
    {
      description: "Replace the full dependency list of a task (cross-repository read-only dependencies allowed).",
      inputSchema: taskDependenciesUpdateInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskDependenciesUpdateInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const result = await deps.taskService.updateTaskDependencies({
        session_id: args.session_id,
        operation_id: args.operation_id,
        task_id: args.task_id,
        expected_version: args.expected_version,
        dependencies: args.dependencies,
        ...(args.policies === undefined ? {} : { policies: args.policies })
      });
      return {
        data: result,
        taskVersion: result.version,
        next: "Dependencies replaced; start the task when its prerequisites finish."
      };
    })
  );

  server.registerTool(
    "task_submit",
    {
      description: "Submit a checkpointed, fully verified task to pending_acceptance for human review. Only humans can accept or reject.",
      inputSchema: taskSubmitInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskSubmitInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const result = await deps.taskService.submitTask({
        session_id: args.session_id,
        operation_id: args.operation_id,
        task_id: args.task_id,
        expected_version: args.expected_version,
        verification: args.verification
      });
      return {
        data: result,
        taskVersion: result.version,
        next: "Wait for human acceptance on the web board."
      };
    })
  );

  server.registerTool(
    "task_dependency_validation_request",
    {
      description: "Backfill missing current-edge validation cycles for an unchanged pending_acceptance submission. Requires an idle bound owner session, original submission snapshot and fresh trusted worktree evidence. Existing cycles and task status remain unchanged; stale submissions require human rejection and normal re-verification.",
      inputSchema: taskDependencyValidationRequestInputSchema,
      annotations: writeAnnotations
    },
    async (rawArgs, extra) => executeTool(async () => {
      const args = taskDependencyValidationRequestInputSchema.parse(rawArgs);
      requireBoundSessionId(deps, extra, args.session_id);
      const result = await deps.taskService.requestTaskDependencyValidation(args);
      return {
        data: result,
        taskVersion: result.version,
        next: "Let downstream Agents receive the missing validation requests; human acceptance remains gated."
      };
    })
  );

  if (deps.hostEvidenceService !== undefined) {
    const hostEvidence = deps.hostEvidenceService;
    server.registerTool(
      "host_key_register",
      {
        description: "Register this developer machine's Ed25519 host key (SPKI DER, base64) bound to the exact git owner. Idempotent for the same (owner, public key). Pass rotation_signature_b64 — the previous key's signature over the SHA-256 digest of the new SPKI public key — to rotate. Run `cli-session-task-mcp host-key generate` locally to create the key pair first.",
        inputSchema: hostKeyRegisterInputSchema,
        annotations: writeAnnotations
      },
      async (rawArgs) => executeTool(async () => {
        const args = hostKeyRegisterInputSchema.parse(rawArgs);
        const result = hostEvidence.registerHostKey({
          owner: args.owner,
          label: args.label,
          public_key_b64: args.public_key_b64,
          ...(args.rotation_signature_b64 === undefined
            ? {}
            : { rotation_signature_b64: args.rotation_signature_b64 })
        });
        return {
          data: result,
          next: result.outcome === "registered"
            ? "Host key registered. Challenges can now be signed by this machine."
            : result.outcome === "rotated"
              ? "Host key rotated; the previous key is revoked."
              : "Host key was already registered."
        };
      })
    );

    server.registerTool(
      "worktree_evidence_challenge",
      {
        description: "Fetch a one-time challenge for host-signed worktree evidence when the server cannot probe your worktree directly. The challenge binds operation, session, repository, task, lease generation, and the expected worktree path, and expires quickly. Run `cli-session-task-mcp evidence collect` on the developer machine to fetch a challenge, fingerprint the local worktree, sign, and submit in one step.",
        inputSchema: worktreeEvidenceChallengeInputSchema,
        annotations: writeAnnotations
      },
      async (rawArgs) => executeTool(async () => {
        const args = worktreeEvidenceChallengeInputSchema.parse(rawArgs);
        const result = hostEvidence.createChallenge({
          session_id: args.session_id,
          operation: args.operation,
          ...(args.task_id === undefined ? {} : { task_id: args.task_id })
        });
        return {
          data: result,
          next: "Sign the challenge over the local worktree fingerprint and "
            + "submit it with worktree_evidence_commit before it expires, "
            + "then run task_checkpoint or task_submit within the evidence window."
        };
      })
    );

    server.registerTool(
      "worktree_evidence_commit",
      {
        description: "Submit the signed host_worktree_evidence.v1 payload for verification. The server checks the one-time challenge, its binding, the active host key and owner match, the Ed25519 signature over the canonical JSON payload, and the capture-time window, then stores the evidence as host_verified for task_checkpoint/task_submit.",
        inputSchema: worktreeEvidenceSubmitInputSchema,
        annotations: writeAnnotations
      },
      async (rawArgs) => executeTool(async () => {
        const args = worktreeEvidenceSubmitInputSchema.parse(rawArgs);
        const result = hostEvidence.submitEvidence(args);
        return {
          data: result,
          next: "Host evidence stored. Run task_checkpoint or task_submit now, "
            + `before it expires at ${result.expires_at}.`
        };
      })
    );
  }
}

/**
 * Creates an MCP server that exposes the task workflow and Board pairing tools. Each
 * streamable HTTP transport session gets its own server instance so the
 * handshake metadata stays per-connection.
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerTools(server, deps);
  return server;
}
