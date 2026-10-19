import { randomUUID } from "node:crypto";
import { PlatformDomainError, projectArchivedError } from "./task-service.js";
import { canonicalRequestHash } from "./operation-fingerprint.js";
import type {
  JsonValue,
  OperationResult,
  ProgressStore,
  ProgressTransaction,
  RepositoryRecord
} from "../storage/progress-store.js";
import type { SessionRecord } from "../shared/task-contracts.js";

export interface RegisterRepositoryInput {
  /** Project name as stated by the user. Existing projects are matched by
   * name; an absent name creates a new project under this name. */
  project_name: string;
  /** Explicit project id. Used as-is when provided; otherwise the id is
   * resolved from the matched project or generated for a new one. */
  project_id?: string;
  repository_id: string;
  repository_name: string;
  /** Absolute path of the repository root on the agent's machine. Declared,
   * not verified — the server cannot stat remote worktrees. */
  path: string;
  session_id?: string;
  operation_id?: string;
  /** Trusted internal creator identity; Board routes and bootstrap supply it. */
  created_by?: string | null;
}

export interface RegisterRepositoryResult {
  project: { project_id: string; name: string; created_by: string | null };
  repository: RepositoryRecord;
  created_project: boolean;
}

export interface RebindRepositoryInput {
  session_id: string;
  operation_id: string;
  owner: string;
  repository_id: string;
  path: string;
  repository_name?: string;
}

/**
 * Repository registration. After remote deployment the whitelist's remaining
 * role is organizational (grouping + session binding), so registration is a
 * metadata write: the agent supplies the facts it reads from the workspace
 * (remote, toplevel path), the user only names the project.
 */
export class RegistryService {
  readonly #store: ProgressStore;
  readonly #now: () => string;

  constructor(store: ProgressStore, now: () => string) {
    this.#store = store;
    this.#now = now;
  }

  registerRepository(input: RegisterRepositoryInput): RegisterRepositoryResult {
    if (input.session_id !== undefined && input.operation_id !== undefined) {
      const requestHash = canonicalRequestHash(input);
      return this.#store.transaction((tx) => {
        const session = tx.getSession(input.session_id!);
        if (session === undefined) {
          throw new PlatformDomainError(
            "SESSION_NOT_FOUND",
            `Session ${input.session_id} does not exist`,
            { evidence: [input.session_id!] }
          );
        }
        this.#assertSessionWritable(session);
        const cached = tx.getOperationResult(input.session_id!, input.operation_id!);
        if (cached !== undefined) {
          this.#assertOperationFingerprint(cached, "repository_register", requestHash);
          return cached.result as unknown as RegisterRepositoryResult;
        }
        const result = this.#registerInTransaction(tx, input);
        tx.putOperationResult({
          session_id: input.session_id!,
          operation_id: input.operation_id!,
          result: result as unknown as JsonValue,
          created_at: this.#now(),
          tool_name: "repository_register",
          request_hash: requestHash
        });
        return result;
      });
    }
    return this.#store.transaction((tx) => this.#registerInTransaction(tx, input));
  }

  registerRepositoryInTransaction(
    tx: ProgressTransaction,
    input: RegisterRepositoryInput
  ): RegisterRepositoryResult {
    return this.#registerInTransaction(tx, input);
  }

  rebindRepository(input: RebindRepositoryInput): RepositoryRecord {
    const requestHash = canonicalRequestHash(input);
    return this.#store.transaction((tx) => {
      const session = tx.getSession(input.session_id);
      if (session === undefined) {
        throw new PlatformDomainError(
          "SESSION_NOT_FOUND",
          `Session ${input.session_id} does not exist`,
          { evidence: [input.session_id] }
        );
      }
      this.#assertSessionWritable(session);
      const cached = tx.getOperationResult(input.session_id, input.operation_id);
      if (cached !== undefined) {
        this.#assertOperationFingerprint(cached, "repository_rebind", requestHash);
        return cached.result as unknown as RepositoryRecord;
      }
      if (session.owner !== input.owner) {
        throw new PlatformDomainError(
          "OWNER_MISMATCH",
          "repository_rebind requires the Git owner bound to the session",
          { evidence: [`current owner ${session.owner ?? "unset"}`, `claimed owner ${input.owner}`] }
        );
      }
      if (session.repository_id !== input.repository_id) {
        throw new PlatformDomainError(
          "REPOSITORY_NOT_ALLOWED",
          "repository_rebind cannot change the session repository",
          { evidence: [session.repository_id, input.repository_id] }
        );
      }
      const activeLease = tx.getLeaseBySession(input.session_id);
      if (activeLease !== undefined) {
        throw new PlatformDomainError(
          "TASK_LEASE_CONFLICT",
          "repository_rebind requires an idle session with no active task lease",
          {
            evidence: [activeLease.task_id],
            recovery_actions: ["Checkpoint and pause the active task before rebinding the repository."]
          }
        );
      }
      const repository = this.#store.getRepository(input.repository_id);
      if (repository === undefined) {
        throw new PlatformDomainError(
          "REPOSITORY_NOT_ALLOWED",
          `Repository ${input.repository_id} is not registered`,
          {
            evidence: [input.repository_id],
            recovery_actions: ["Use repository_bootstrap for a repository that is not registered."]
          }
        );
      }
      const pathOwner = this.#store.listRepositories().find((candidate) => (
        candidate.path === input.path && candidate.repository_id !== input.repository_id
      ));
      if (pathOwner !== undefined) {
        throw new PlatformDomainError(
          "REPOSITORY_PATH_CONFLICT",
          `Repository path ${input.path} is already registered as ${pathOwner.repository_id}`,
          {
            evidence: [input.path, pathOwner.repository_id],
            recovery_actions: ["Choose the moved repository's unique root path."]
          }
        );
      }
      const updated: RepositoryRecord = {
        ...repository,
        path: input.path,
        ...(input.repository_name === undefined ? {} : { label: input.repository_name }),
        updated_at: this.#now()
      };
      tx.upsertRepository(updated);
      tx.putOperationResult({
        session_id: input.session_id,
        operation_id: input.operation_id,
        result: updated as unknown as import("../storage/progress-store.js").JsonValue,
        created_at: updated.updated_at,
        tool_name: "repository_rebind",
        request_hash: requestHash
      });
      return updated;
    });
  }

  #registerInTransaction(
    tx: ProgressTransaction,
    input: RegisterRepositoryInput
  ): RegisterRepositoryResult {
    const sessionOwner = input.session_id === undefined
      ? undefined
      : tx.getSession(input.session_id)?.owner;
    const createdBy = input.created_by !== undefined
      ? input.created_by
      : sessionOwner ?? null;
    if (this.#store.getRepository(input.repository_id) !== undefined) {
      throw new PlatformDomainError(
        "REPOSITORY_EXISTS",
        `Repository ${input.repository_id} is already registered`,
        {
          evidence: [input.repository_id],
          recovery_actions: [
            "Bind it with session_context, or choose a different repository_id."
          ]
        }
      );
    }
    // Include archived projects so a new repository never silently creates a
    // same-named duplicate or lands in an archived project.
    const projects = this.#store.listProjects(undefined, { include_archived: true });
    const byName = projects.find((project) => project.name === input.project_name);
    const byId = input.project_id === undefined
      ? undefined
      : projects.find((project) => project.project_id === input.project_id);
    if (input.project_id !== undefined
      && ((byId !== undefined && byId.name !== input.project_name)
        || (byName !== undefined && byName.project_id !== input.project_id))) {
      throw new PlatformDomainError(
        "PROJECT_CONFLICT",
        `Project id ${input.project_id} and name ${input.project_name} identify different projects`,
        {
          evidence: [
            `project_id=${input.project_id}`,
            `project_name=${input.project_name}`,
            ...(byId === undefined ? [] : [`id resolves to ${byId.name}`]),
            ...(byName === undefined ? [] : [`name resolves to ${byName.project_id}`])
          ],
          recovery_actions: [
            "Use the existing project's matching id and name, or choose a new id and name."
          ]
        }
      );
    }
    const existing = byId ?? byName;
    if (existing?.archived_at !== null && existing?.archived_at !== undefined) {
      const archived = projectArchivedError(existing);
      throw new PlatformDomainError(archived.code, archived.message, {
        evidence: archived.evidence,
        recovery_actions: [
          "Restore the archived project from the Board dashboard first, or register under a different project name."
        ]
      });
    }
    const now = this.#now();
    const projectId = existing?.project_id
      ?? input.project_id
      ?? `p-${randomUUID().slice(0, 8)}`;
    if (existing === undefined) {
      tx.upsertProject({
        project_id: projectId,
        name: input.project_name,
        created_by: createdBy,
        created_at: now,
        updated_at: now
      });
    }
    const repository: RepositoryRecord = {
      repository_id: input.repository_id,
      project_id: projectId,
      path: input.path,
      label: input.repository_name,
      created_at: now,
      updated_at: now
    };
    const pathOwner = this.#store.listRepositories().find((candidate) => (
      candidate.path === input.path && candidate.repository_id !== input.repository_id
    ));
    if (pathOwner !== undefined) {
      throw new PlatformDomainError(
        "REPOSITORY_PATH_CONFLICT",
        `Repository path ${input.path} is already registered as ${pathOwner.repository_id}`,
        {
          evidence: [input.path, pathOwner.repository_id],
          recovery_actions: ["Choose a unique repository root path."]
        }
      );
    }
    tx.upsertRepository(repository);
    return {
      project: {
        project_id: projectId,
        name: existing?.name ?? input.project_name,
        created_by: existing === undefined ? createdBy : existing.created_by ?? null
      },
      repository,
      created_project: existing === undefined
    };
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
