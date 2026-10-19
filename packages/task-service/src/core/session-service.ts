/// <reference types="node" />

import { execSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { PlatformDomainError, assertProjectNotArchived } from "./task-service.js";
import { canonicalRequestHash } from "./operation-fingerprint.js";

export function detectGitOwner(workspacePath: string): string | undefined {
  try {
    const name = execSync("git config user.name", {
      encoding: "utf8",
      timeout: 3_000,
      cwd: workspacePath
    }).trim();
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

import { normalizeClientMetadata, type ClientMetadata } from "../mcp/client-metadata.js";
import type {
  ClientFamily,
  SessionRecord
} from "../shared/task-contracts.js";
import type {
  ProgressStore,
  ProgressTransaction,
  OperationResult
} from "../storage/progress-store.js";

export interface SessionContextInput {
  transport_session_id: string;
  client_name: string;
  client_version: string;
  protocol_version: string;
  capabilities?: Record<string, unknown>;
  workspace_path: string;
  repository_id: string;
  worktree_path: string;
  owner?: string;
  successor_session_id?: string;
  successor_ctx_id?: string;
  /** Re-attach this session after its transport died; requires resume_token. */
  resume_session_id?: string;
  resume_token?: string;
}

export interface SessionContextResult extends SessionRecord {
  transport_session_id: string;
  client_name: string;
  client_version: string;
  client_family: ClientFamily;
  protocol_version: string;
  last_activity_at: string;
  /** Raw one-time resume token; returned by every bind/resume, never stored. */
  resume_token?: string;
}

export interface SessionRebindInput {
  session_id: string;
  operation_id: string;
  repository_id: string;
  owner: string;
  expected_worktree_path: string;
  workspace_path: string;
  worktree_path: string;
}

const sessionRebindResultSchema = z.object({
  session_id: z.string().min(1),
  repository_id: z.string().min(1),
  owner: z.string().min(1),
  previous_workspace_path: z.string().nullable(),
  previous_worktree_path: z.string().nullable(),
  workspace_path: z.string().min(1),
  worktree_path: z.string().min(1),
  rebound: z.boolean(),
  rebound_at: z.iso.datetime()
});

export type SessionRebindResult = z.infer<typeof sessionRebindResultSchema>;

export class SessionService {
  readonly #store: ProgressStore;
  readonly #config: RuntimeConfig;
  readonly #leaseTtlMs: number;
  readonly #isTransportActive: ((transportSessionId: string) => boolean) | undefined;

  constructor(
    store: ProgressStore,
    config: RuntimeConfig,
    leaseTtlMs = config.staleAfterMs,
    isTransportActive?: (transportSessionId: string) => boolean
  ) {
    this.#store = store;
    this.#config = config;
    this.#leaseTtlMs = leaseTtlMs;
    this.#isTransportActive = isTransportActive;
  }

  sessionContext(input: SessionContextInput, now: string): SessionContextResult {
    const metadata = normalizeClientMetadata({
      name: input.client_name,
      version: input.client_version
    });
    return this.#store.transaction((tx) => this.sessionContextInTransaction(tx, input, now, metadata));
  }

  sessionContextInTransaction(
    tx: ProgressTransaction,
    input: SessionContextInput,
    now: string,
    metadata = normalizeClientMetadata({
      name: input.client_name,
      version: input.client_version
    })
  ): SessionContextResult {
    this.#assertRepositoryProjectWritable(tx, input.repository_id);
    if (input.resume_session_id !== undefined) {
      return this.#resumeContext(tx, input, now, metadata);
    }
    const existing = tx.getSessionByTransportId(input.transport_session_id);
    if (existing !== undefined) {
      this.#assertSessionWritable(existing);
      const mismatches = contextMismatches(existing, input);
      if (mismatches.length > 0) {
        throw new PlatformDomainError(
          "SESSION_CONTEXT_CONFLICT",
          "session_context cannot silently change an existing transport binding",
          {
            evidence: mismatches,
            recovery_actions: [
              "Call session_rebind with the current session_id, expected old worktree,"
                + " and target worktree while the session holds no task lease."
            ]
          }
        );
      }
      tx.updateSessionActivity(existing.session_id, now);
      const resumeToken = this.#rotateResumeToken(tx, existing.session_id);
      const refreshed = tx.getSession(existing.session_id) ?? existing;
      return { ...toContextResult(refreshed, metadata, input), resume_token: resumeToken };
    }
    const owner = input.owner ?? detectGitOwner(input.workspace_path);
    const record: SessionRecord = {
      session_id: randomUUID(),
      repository_id: input.repository_id,
      label: `${input.client_name} ${input.client_version}`,
      started_at: now,
      transport_session_id: input.transport_session_id,
      client_name: metadata.client_name,
      client_version: metadata.client_version,
      client_family: metadata.client_family,
      protocol_version: input.protocol_version,
      workspace_path: input.workspace_path,
      worktree_path: input.worktree_path,
      last_activity_at: now,
      ...(owner === undefined ? {} : { owner })
    };
    if (input.capabilities !== undefined) {
      record.capabilities = input.capabilities;
    }
    tx.insertSession(record);
    if (input.successor_session_id !== undefined) {
      const predecessor = tx.getSession(input.successor_session_id);
      if (predecessor === undefined
        || predecessor.repository_id !== record.repository_id
        || predecessor.owner !== record.owner) {
        throw new PlatformDomainError("SESSION_CONTEXT_CONFLICT", "Successor session identity does not match predecessor", {
          evidence: [input.successor_session_id, record.repository_id, record.owner ?? "unassigned"]
        });
      }
      this.#assertSessionWritable(predecessor);
      const lease = tx.getLeaseBySession(predecessor.session_id);
      if (lease !== undefined) {
        const task = tx.getTask(lease.task_id);
        if (task === undefined || task.repository_id !== record.repository_id || task.owner !== record.owner) {
          throw new PlatformDomainError("TASK_LEASE_CONFLICT", "Predecessor lease cannot be transferred to this successor");
        }
        if (task.status === "done" || task.status === "cancelled") {
          throw new PlatformDomainError(
            "INVALID_TRANSITION",
            `Terminal task ${task.task_id} cannot be transferred to a successor session`,
            { evidence: [task.task_id, task.status] }
          );
        }
        const targetLease = tx.getLeaseBySession(record.session_id);
        if (targetLease !== undefined) {
          throw new PlatformDomainError("TASK_LEASE_CONFLICT", "Successor session already holds a task lease");
        }
        const conflictingScope = tx.listActiveScopesByWorktree(record.worktree_path!)
          .find((scope) => scope.task_id !== task.task_id
            && tx.getLeaseByTask(scope.task_id) !== undefined);
        if (conflictingScope !== undefined) {
          throw new PlatformDomainError(
            "WORKTREE_CONFLICT",
            `Successor worktree is leased by task ${conflictingScope.task_id}`,
            {
              evidence: [record.worktree_path!, conflictingScope.task_id],
              recovery_actions: ["Use an unleased worktree or finish the conflicting task before retrying."]
            }
          );
        }
        const taskVersion = tx.getTaskVersion(task.task_id);
        if (taskVersion === undefined) {
          throw new PlatformDomainError("TASK_NOT_FOUND", `Task ${task.task_id} was not found`);
        }
        tx.deleteLeaseByTask(lease.task_id);
        tx.putLease({
          ...lease,
          session_id: record.session_id,
          heartbeat_at: now,
          expires_at: new Date(Date.parse(now) + this.#leaseTtlMs).toISOString(),
          generation: (lease.generation ?? 1) + 1
        });
        tx.updateTask({
          ...task,
          session_id: record.session_id,
          updated_at: now
        }, taskVersion);
        tx.replaceTaskWorktreeScope({
          task_scope_id: randomUUID(),
          task_id: task.task_id,
          scope_type: "worktree_path",
          scope_value: record.worktree_path!
        });
        tx.upsertTaskSessionLink({ task_id: lease.task_id, session_id: record.session_id, linked_at: now });
        tx.appendTaskEvent({
          event_id: randomUUID(),
          task_id: task.task_id,
          session_id: record.session_id,
          event_type: "lease_succeeded",
          payload: {
            actor: "agent",
            predecessor_session_id: predecessor.session_id,
            successor_session_id: record.session_id,
            successor_ctx_id: input.successor_ctx_id ?? null,
            worktree_path: record.worktree_path!
          },
          created_at: now
        });
        tx.insertSessionEvent({
          event_id: randomUUID(), session_id: record.session_id, event_type: "session_succeeded",
          payload: { actor: "agent", predecessor_session_id: predecessor.session_id, task_id: lease.task_id }, created_at: now
        });
      }
      tx.setSessionSuccessor(
        predecessor.session_id,
        record.session_id,
        input.successor_ctx_id,
        now
      );
    }
    const resumeToken = this.#rotateResumeToken(tx, record.session_id);
    return { ...toContextResult(record, metadata, input), resume_token: resumeToken };
  }

  /**
   * Re-attach a pseudo-dead session (its MCP transport is gone, e.g. after a
   * server restart) to the calling transport, proving possession of the
   * session's one-time resume token. The session id, task lease, and history
   * stay continuous; nothing is transferred or superseded.
   */
  #resumeContext(
    tx: ProgressTransaction,
    input: SessionContextInput,
    now: string,
    metadata: ClientMetadata
  ): SessionContextResult {
    const resumeSessionId = input.resume_session_id!;
    const session = requireSession(tx.getSession(resumeSessionId), resumeSessionId);
    this.#assertSessionWritable(session);
    if (session.repository_id !== input.repository_id) {
      throw new PlatformDomainError(
        "SESSION_RESUME_FAILED",
        "Session resume requires the originally bound repository",
        {
          evidence: [`repository_id: ${session.repository_id} != ${input.repository_id}`],
          recovery_actions: ["Bind a fresh session with session_context."]
        }
      );
    }
    if (input.owner !== undefined && session.owner !== undefined && input.owner !== session.owner) {
      throw new PlatformDomainError(
        "SESSION_RESUME_FAILED",
        "Session resume requires the originally bound owner",
        {
          evidence: [`owner: ${session.owner} != ${input.owner}`],
          recovery_actions: ["Bind a fresh session with session_context."]
        }
      );
    }
    const contextMismatch = contextMismatches(session, input);
    if (contextMismatch.length > 0) {
      throw new PlatformDomainError(
        "SESSION_RESUME_FAILED",
        "Session resume requires the originally bound workspace and worktree",
        {
          evidence: contextMismatch,
          recovery_actions: ["Resume with the original context, then use session_rebind if needed."]
        }
      );
    }
    const storedHash = session.resume_token_hash;
    if (storedHash === undefined || input.resume_token === undefined) {
      throw new PlatformDomainError(
        "SESSION_RESUME_FAILED",
        "Session resume requires the resume token issued by the original bind",
        {
          evidence: [resumeSessionId, storedHash === undefined ? "no stored token" : "no provided token"],
          recovery_actions: [
            "Bind a fresh session with session_context, or use an explicit successor session."
          ]
        }
      );
    }
    const providedHash = createHash("sha256").update(input.resume_token, "utf8").digest();
    const expectedHash = Buffer.from(storedHash, "hex");
    if (expectedHash.length !== providedHash.length
      || !timingSafeEqual(providedHash, expectedHash)) {
      throw new PlatformDomainError(
        "SESSION_RESUME_FAILED",
        "Session resume token does not match",
        {
          evidence: [resumeSessionId],
          recovery_actions: [
            "Bind a fresh session with session_context, or use an explicit successor session."
          ]
        }
      );
    }
    if (this.#isTransportActive === undefined) {
      throw new PlatformDomainError(
        "SESSION_RESUME_FAILED",
        "Session resume is not available without transport liveness tracking",
        { evidence: [resumeSessionId], recovery_actions: ["Bind a fresh session with session_context."] }
      );
    }
    if (session.transport_session_id !== undefined
      && this.#isTransportActive(session.transport_session_id)) {
      throw new PlatformDomainError(
        "SESSION_RESUME_FAILED",
        "The previous transport of this session is still active",
        {
          evidence: [resumeSessionId, session.transport_session_id],
          recovery_actions: ["Continue on the active transport instead of resuming."]
        }
      );
    }
    const holder = tx.getSessionByTransportId(input.transport_session_id);
    if (holder !== undefined && holder.session_id !== session.session_id) {
      throw new PlatformDomainError(
        "SESSION_CONTEXT_CONFLICT",
        "This transport is already bound to another session",
        {
          evidence: [input.transport_session_id, holder.session_id],
          recovery_actions: ["Call session_context on this connection to reuse that binding."]
        }
      );
    }
    const previousTransportSessionId = session.transport_session_id ?? null;
    tx.updateSessionTransport(session.session_id, input.transport_session_id, now);
    const resumeToken = this.#rotateResumeToken(tx, session.session_id);
    tx.insertSessionEvent({
      event_id: randomUUID(),
      session_id: session.session_id,
      event_type: "session_rebound",
      payload: {
        actor: "agent",
        repository_id: session.repository_id,
        previous_transport_session_id: previousTransportSessionId,
        transport_session_id: input.transport_session_id,
        via: "session_resume"
      },
      created_at: now
    });
    const refreshed = tx.getSession(session.session_id) ?? session;
    return { ...toContextResult(refreshed, metadata, input), resume_token: resumeToken };
  }

  #rotateResumeToken(tx: ProgressTransaction, sessionId: string): string {
    const token = randomBytes(32).toString("base64url");
    tx.setSessionResumeTokenHash(
      sessionId,
      createHash("sha256").update(token, "utf8").digest("hex")
    );
    return token;
  }

  rebindSession(input: SessionRebindInput, now: string): SessionRebindResult {
    const requestHash = canonicalRequestHash(input);
    return this.#store.transaction((tx) => {
      const session = requireSession(tx.getSession(input.session_id), input.session_id);
      this.#assertSessionWritable(session);
      const cached = tx.getOperationResult(input.session_id, input.operation_id);
      if (cached !== undefined) {
        this.#assertOperationFingerprint(cached, "session_rebind", requestHash);
        return sessionRebindResultSchema.parse(cached.result);
      }
      assertRebindIdentity(
        session,
        input,
        this.#store.getRepository(input.repository_id) !== undefined
      );
      this.#assertRepositoryProjectWritable(tx, input.repository_id);
      const targetWorktree = normalizePath(input.worktree_path)!;
      assertRebindAvailable(tx, input.session_id, targetWorktree);
      const workspacePath = normalizePath(input.workspace_path)!;
      const previousWorkspacePath = session.workspace_path ?? null;
      const previousWorktreePath = session.worktree_path ?? null;
      const rebound = normalizePath(session.workspace_path) !== workspacePath
        || normalizePath(session.worktree_path) !== targetWorktree;
      tx.updateSessionContext(
        session.session_id,
        workspacePath,
        targetWorktree,
        now
      );
      if (rebound) {
        tx.insertSessionEvent({
          event_id: randomUUID(),
          session_id: session.session_id,
          event_type: "session_rebound",
          payload: {
            actor: "agent",
            repository_id: session.repository_id,
            owner: input.owner,
            previous_workspace_path: previousWorkspacePath,
            previous_worktree_path: previousWorktreePath,
            workspace_path: workspacePath,
            worktree_path: targetWorktree,
            via: "session_rebind"
          },
          created_at: now
        });
      }
      const result = sessionRebindResultSchema.parse({
        session_id: session.session_id,
        repository_id: session.repository_id,
        owner: session.owner,
        previous_workspace_path: previousWorkspacePath,
        previous_worktree_path: previousWorktreePath,
        workspace_path: workspacePath,
        worktree_path: targetWorktree,
        rebound,
        rebound_at: now
      });
      tx.putOperationResult({
        session_id: session.session_id,
        operation_id: input.operation_id,
        tool_name: "session_rebind",
        request_hash: requestHash,
        result,
        created_at: now
      });
      return result;
    });
  }

  /** Binding to an archived project's repository fails with PROJECT_ARCHIVED. */
  #assertRepositoryProjectWritable(tx: ProgressTransaction, repositoryId: string): void {
    const projectId = this.#store.getRepository(repositoryId)?.project_id;
    if (projectId !== undefined) {
      assertProjectNotArchived(tx.getProject(projectId));
    }
  }

  markStale(now: string): SessionRecord[] {
    const cutoff = new Date(new Date(now).getTime() - this.#config.staleAfterMs)
      .toISOString();
    return this.#store.transaction((tx) => {
      const marked: SessionRecord[] = [];
      for (const session of tx.listSessionsInactiveBefore(cutoff)) {
        if (session.stale_at !== undefined) {
          continue;
        }
        tx.setSessionStaleAt(session.session_id, now);
        marked.push({ ...session, stale_at: now });
      }
      return marked;
    });
  }

  #assertOperationFingerprint(
    found: OperationResult,
    toolName: string,
    requestHash: string
  ): void {
    if (found.tool_name === toolName && found.request_hash === requestHash) {
      return;
    }
    throw new PlatformDomainError(
      "OPERATION_ID_CONFLICT",
      `Operation id ${found.operation_id} was already used for a different request`,
      {
        evidence: [
          `stored tool: ${found.tool_name ?? "legacy-unfingerprinted"}`,
          `requested tool: ${toolName}`
        ],
        recovery_actions: ["Use a fresh operation_id, or retry the exact original tool input."]
      }
    );
  }

  #assertSessionWritable(session: SessionRecord): void {
    if (session.successor_session_id === undefined) {
      return;
    }
    throw new PlatformDomainError(
      "SESSION_SUPERSEDED",
      `Session ${session.session_id} was replaced by explicit successor ${session.successor_session_id}`,
      {
        evidence: [session.session_id, session.successor_session_id],
        recovery_actions: ["Continue from the explicit successor session."]
      }
    );
  }
}

function normalizePath(path: string | undefined): string | undefined {
  if (path === undefined || path === "/") {
    return path;
  }
  return path.replace(/\/+$/, "");
}

function requireSession(
  session: SessionRecord | undefined,
  sessionId: string
): SessionRecord {
  if (session === undefined) {
    throw new PlatformDomainError(
      "SESSION_NOT_FOUND",
      `Session ${sessionId} does not exist`,
      { evidence: [sessionId] }
    );
  }
  return session;
}

function assertRebindIdentity(
  session: SessionRecord,
  input: SessionRebindInput,
  repositoryExists: boolean
): void {
  if (session.repository_id !== input.repository_id || !repositoryExists) {
    throw new PlatformDomainError(
      "REPOSITORY_NOT_ALLOWED",
      "A transport session can only rebind within its registered repository",
      {
        evidence: [
          `current repository ${session.repository_id}`,
          `target repository ${input.repository_id}`
        ],
        recovery_actions: ["Open a new MCP transport for a different repository."]
      }
    );
  }
  if (session.owner === undefined || session.owner !== input.owner) {
    throw new PlatformDomainError(
      "OWNER_MISMATCH",
      "session_rebind cannot change or infer the bound Git owner",
      {
        evidence: [
          `current owner ${session.owner ?? "unset"}`,
          `claimed owner ${input.owner}`
        ],
        recovery_actions: [
          "Use the exact git config user.name bound to this session,"
            + " or open a new transport for another owner."
        ]
      }
    );
  }
  if (normalizePath(session.worktree_path)
    !== normalizePath(input.expected_worktree_path)) {
    throw new PlatformDomainError(
      "SESSION_CONTEXT_CONFLICT",
      "The session worktree changed after the caller last read it",
      {
        evidence: [
          `expected ${input.expected_worktree_path}`,
          `current ${session.worktree_path ?? "unset"}`
        ],
        recovery_actions: [
          "Call session_context to read the current binding and retry with"
            + " its worktree_path as expected_worktree_path."
        ]
      }
    );
  }
}

function assertRebindAvailable(
  tx: ProgressTransaction,
  sessionId: string,
  targetWorktree: string
): void {
  const activeLease = tx.getLeaseBySession(sessionId);
  if (activeLease !== undefined) {
    throw new PlatformDomainError(
      "TASK_LEASE_CONFLICT",
      "session_rebind requires an idle session with no active task lease",
      {
        evidence: [`active task ${activeLease.task_id}`],
        recovery_actions: [
          "Use task_switch for an atomic cross-worktree task change,"
            + " or checkpoint and pause the current task first."
        ]
      }
    );
  }
  for (const scope of tx.listActiveScopesByWorktree(targetWorktree)) {
    const lease = tx.getLeaseByTask(scope.task_id);
    if (lease === undefined) {
      continue;
    }
    throw new PlatformDomainError(
      "WORKTREE_CONFLICT",
      `Worktree ${targetWorktree} is already leased by task ${scope.task_id}`,
      {
        evidence: [targetWorktree, `task ${scope.task_id}`, `session ${lease.session_id}`],
        recovery_actions: [
          "Pause or finish the conflicting task before rebinding this session."
        ]
      }
    );
  }
}

function contextMismatches(
  existing: SessionRecord,
  input: SessionContextInput
): string[] {
  const mismatches: string[] = [];
  if (existing.repository_id !== input.repository_id) {
    mismatches.push(
      `repository_id: ${existing.repository_id} != ${input.repository_id}`
    );
  }
  if (normalizePath(existing.workspace_path) !== normalizePath(input.workspace_path)) {
    mismatches.push(
      `workspace_path: ${existing.workspace_path ?? "unset"} != ${input.workspace_path}`
    );
  }
  if (normalizePath(existing.worktree_path) !== normalizePath(input.worktree_path)) {
    mismatches.push(
      `worktree_path: ${existing.worktree_path ?? "unset"} != ${input.worktree_path}`
    );
  }
  if (input.owner !== undefined && existing.owner !== input.owner) {
    mismatches.push(`owner: ${existing.owner ?? "unset"} != ${input.owner}`);
  }
  return mismatches;
}

function toContextResult(
  record: SessionRecord,
  metadata: ClientMetadata,
  input: SessionContextInput
): SessionContextResult {
  const { resume_token_hash: _storedHash, ...safeRecord } = record;
  void _storedHash;
  return {
    ...safeRecord,
    transport_session_id: record.transport_session_id ?? input.transport_session_id,
    client_name: record.client_name ?? metadata.client_name,
    client_version: record.client_version ?? metadata.client_version,
    client_family: record.client_family ?? metadata.client_family,
    protocol_version: record.protocol_version ?? input.protocol_version,
    last_activity_at: record.last_activity_at ?? record.started_at
  };
}
