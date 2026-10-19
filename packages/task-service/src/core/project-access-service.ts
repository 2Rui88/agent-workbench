import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ProjectMemberRecord,
  ProjectOpenTask,
  ProjectRecord,
  ProjectShareRecord,
  ProgressStore,
  ProgressTransaction
} from "../storage/progress-store.js";
import { PlatformDomainError, assertProjectNotArchived } from "./task-service.js";

const defaultShareTtlMs = 24 * 60 * 60 * 1_000;

export interface ProjectShare {
  share_id: string;
  project_id: string;
  token: string;
  expires_at: string;
}

export interface ProjectAccessServiceOptions {
  now?: () => string;
  shareTtlMs?: number;
}

export class ProjectAccessService {
  readonly #store: ProgressStore;
  readonly #now: () => string;
  readonly #shareTtlMs: number;

  constructor(store: ProgressStore, options: ProjectAccessServiceOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#shareTtlMs = options.shareTtlMs ?? defaultShareTtlMs;
  }

  isProjectViewer(projectId: string, owner: string): boolean {
    const project = this.#store.getProject(projectId);
    if (project === undefined) {
      return false;
    }
    return project.created_by === owner
      || this.#store.getProjectMember(projectId, owner)?.revoked_at === null;
  }

  assertProjectViewer(projectId: string, owner: string): void {
    if (this.isProjectViewer(projectId, owner)) {
      return;
    }
    throw new PlatformDomainError(
      "PROJECT_ACCESS_REQUIRED",
      "The authenticated owner is not a member of this project",
      { evidence: [], recovery_actions: ["Accept a valid project share before accessing this project."] }
    );
  }

  assertProjectCreator(projectId: string, owner: string): void {
    const project = this.#store.getProject(projectId);
    if (project?.created_by === owner) {
      return;
    }
    throw creatorRequired();
  }

  #assertArchiveManager(tx: ProgressTransaction, projectId: string, owner: string): void {
    const project = tx.getProject(projectId);
    if (project === undefined) {
      throw creatorRequired();
    }
    if (project.created_by !== null && project.created_by !== undefined) {
      if (project.created_by !== owner) {
        throw creatorRequired();
      }
      return;
    }
    // Legacy projects have no creator: any identity that can see the project
    // (same visibility as the Board project list) may archive or restore it.
    const visible = this.#store.listProjects(owner, { include_archived: true })
      .some((candidate) => candidate.project_id === projectId);
    if (!visible) {
      throw new PlatformDomainError(
        "PROJECT_ACCESS_REQUIRED",
        "The authenticated owner cannot see this legacy project",
        { evidence: [], recovery_actions: ["Use an identity that has work or a session in this project."] }
      );
    }
  }

  assertTaskMutation(taskId: string, owner: string): void {
    const task = this.#store.getTaskDetail(taskId);
    if (task === undefined) {
      throw new PlatformDomainError("TASK_NOT_FOUND", `Task ${taskId} does not exist`);
    }
    if (task.owner !== owner) {
      throw new PlatformDomainError(
        "OWNER_MISMATCH",
        "Only the task owner can perform this action",
        { evidence: [], recovery_actions: ["Operate on a task owned by the authenticated owner."] }
      );
    }
    const repository = this.#store.getRepository(task.repository_id);
    if (repository === undefined) {
      throw new PlatformDomainError("REPOSITORY_NOT_ALLOWED", `Repository ${task.repository_id} is not registered`);
    }
    this.assertProjectViewer(repository.project_id, owner);
  }

  /**
   * Human-only archive (Board route). The creator archives; a legacy project
   * without a creator can be archived by any identity that can see it. The
   * open-task check and the write run inside one BEGIN IMMEDIATE transaction.
   */
  archiveProject(projectId: string, owner: string): ProjectRecord {
    return this.#store.transaction((tx) => {
      this.#assertArchiveManager(tx, projectId, owner);
      const outcome = tx.archiveProject(projectId, owner, this.#now());
      if (outcome.status === "not_found") {
        throw creatorRequired();
      }
      if (outcome.status === "open_tasks") {
        throw openTasksError(projectId, outcome.open_tasks);
      }
      return outcome.project;
    });
  }

  unarchiveProject(projectId: string, owner: string): ProjectRecord {
    return this.#store.transaction((tx) => {
      this.#assertArchiveManager(tx, projectId, owner);
      const outcome = tx.unarchiveProject(projectId, this.#now());
      if (outcome.status === "not_found") {
        throw creatorRequired();
      }
      return outcome.project;
    });
  }

  createShare(projectId: string, owner: string): ProjectShare {
    this.assertProjectCreator(projectId, owner);
    assertProjectNotArchived(this.#store.getProject(projectId));
    const now = this.#now();
    const expiresAt = new Date(Date.parse(now) + this.#shareTtlMs).toISOString();
    const token = randomBytes(32).toString("base64url");
    const record: ProjectShareRecord = {
      share_id: randomUUID(),
      project_id: projectId,
      token_hash: hashToken(token),
      created_by: owner,
      expires_at: expiresAt,
      consumed_at: null,
      revoked_at: null,
      created_at: now
    };
    this.#store.transaction((tx) => tx.createProjectShare(record));
    return {
      share_id: record.share_id,
      project_id: projectId,
      token,
      expires_at: expiresAt
    };
  }

  acceptShare(token: string, owner: string): ProjectMemberRecord {
    if (token.length === 0 || owner.length === 0) {
      throw invalidShare();
    }
    const now = this.#now();
    const tokenHash = hashToken(token);
    return this.#store.transaction((tx) => {
      const share = tx.getProjectShareByTokenHash(tokenHash);
      if (share === undefined) {
        throw invalidShare();
      }
      assertProjectNotArchived(tx.getProject(share.project_id));
      if (!tx.consumeProjectShare(share.share_id, tokenHash, now)) {
        throw invalidShare();
      }
      const member: ProjectMemberRecord = {
        project_id: share.project_id,
        owner,
        role: "member",
        granted_by: share.created_by,
        created_at: now,
        revoked_at: null
      };
      tx.upsertProjectMember(member);
      return member;
    });
  }

  revokeShare(projectId: string, shareId: string, owner: string): boolean {
    this.assertProjectCreator(projectId, owner);
    return this.#store.transaction((tx) => tx.revokeProjectShare(shareId, projectId, this.#now()));
  }

  listMembers(projectId: string, owner: string): ProjectMemberRecord[] {
    this.assertProjectViewer(projectId, owner);
    return this.#store.listProjectMembers(projectId);
  }

  removeMember(projectId: string, memberOwner: string, owner: string): boolean {
    this.assertProjectCreator(projectId, owner);
    if (memberOwner === owner) {
      throw new PlatformDomainError(
        "PROJECT_CREATOR_REQUIRED",
        "The project creator cannot remove themselves from the project",
        { evidence: [], recovery_actions: ["Keep the creator as the project's owner."] }
      );
    }
    return this.#store.transaction((tx) => tx.revokeProjectMember(projectId, memberOwner, this.#now()));
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function creatorRequired(): PlatformDomainError {
  return new PlatformDomainError(
    "PROJECT_CREATOR_REQUIRED",
    "Only the project creator can manage project sharing, members, and archiving",
    { evidence: [], recovery_actions: ["Use the project creator's authenticated session."] }
  );
}

function openTasksError(projectId: string, openTasks: readonly ProjectOpenTask[]): PlatformDomainError {
  const counts: Record<string, number> = {};
  for (const task of openTasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return new PlatformDomainError(
    "PROJECT_HAS_OPEN_TASKS",
    `Project ${projectId} still has ${openTasks.length} unfinished task(s)`,
    {
      evidence: [
        ...Object.entries(counts).map(([status, count]) => `${status}: ${count}`),
        ...openTasks.map((task) => (
          `task ${task.task_id} (owner ${task.owner ?? "unassigned"}, ${task.status})`
        ))
      ],
      recovery_actions: [
        "Accept or cancel every unfinished task (including members' tasks) before archiving."
      ],
      details: {
        open_task_counts: counts,
        open_tasks: openTasks.map((task) => ({ ...task }))
      }
    }
  );
}

function invalidShare(): PlatformDomainError {
  return new PlatformDomainError(
    "PROJECT_SHARE_INVALID",
    "The project share is invalid, expired, revoked, or already used",
    { evidence: [], recovery_actions: ["Request a new project share from the creator."] }
  );
}
