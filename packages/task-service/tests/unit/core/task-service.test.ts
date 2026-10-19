/// <reference types="node" />

import { describe, expect, it } from "vitest";
import {
  PlatformDomainError,
  TaskService,
  type CreateTaskInput,
  type StartTaskInput,
  type SwitchTaskInput,
  type TaskActor
} from "../../../src/core/task-service.js";
import { canonicalRequestHash } from "../../../src/core/operation-fingerprint.js";
import type {
  RepoProbeInput,
  RepoSnapshotDraft
} from "../../../src/repo/repo-probe.js";
import {
  StorageError,
  type ActiveTaskLease,
  type ArchiveProjectOutcome,
  type UnarchiveProjectOutcome,
  type ActiveTaskScope,
  type CheckpointRecord,
  type DependencyValidationActivity,
  type DependencyRepairRequestRecord,
  type DependencyRepairStatus,
  type DependencyValidationGate,
  type DependencyValidationListFilter,
  type DependencyValidationPerspective,
  type DependencyValidationRecord,
  type DependencyValidationRunRecord,
  type DependencyValidationRunStatus,
  type DependencyValidationView,
  type HostEvidenceChallengeRecord,
  type HostEvidenceRecord,
  type HostKeyRecord,
  type HumanDecisionRecord,
  type LegacyTaskImport,
  type NotificationRecord,
  type OperationResult,
  type ProgressStore,
  type ProgressTransaction,
  type ProjectMemberRecord,
  type ProjectRecord,
  type ProjectShareRecord,
  type ProjectWithRepositories,
  type RepoSnapshotView,
  type SessionEventRecord,
  type SnapshotConflictView,
  type TaskDependencyView,
  type TaskEventView,
  type RepoSnapshotRecord,
  type RepositoryRecord,
  type TaskDetail,
  type TaskDependencyRecord,
  type TaskEventRecord,
  type TaskListFilter,
  type TaskScopeRecord,
  type TaskSessionLinkRecord,
  type TaskSummary
} from "../../../src/storage/progress-store.js";
import {
  checkpointPayloadSchema,
  type CheckpointPayload,
  type SessionRecord,
  type TaskRecord
} from "../../../src/shared/task-contracts.js";
import {
  assertDependencyValidationSpecIdentity,
  sanitizeDependencyValidationEvidence,
  sanitizeDependencyValidationProgress,
  sanitizeDependencyValidationSpec,
  sanitizeDependencyValidationText
} from "../../../src/shared/dependency-validation-contracts.js";
import type { JsonValue } from "../../../src/storage/progress-store.js";

const WORKTREE_A = "/wt/a";
const WORKTREE_B = "/wt/b";
const WORKTREE_C = "/wt/c";
const BASE_TIME_MS = Date.parse("2026-08-17T10:00:00.000Z");

describe("canonicalRequestHash", () => {
  it("sorts object keys, omits undefined and operation_id, and preserves array order", () => {
    expect(canonicalRequestHash({ b: 2, a: 1 }))
      .toBe(canonicalRequestHash({ a: 1, b: 2 }));
    expect(canonicalRequestHash({ a: 1, omitted: undefined }))
      .toBe(canonicalRequestHash({ a: 1 }));
    expect(canonicalRequestHash({ operation_id: "one", a: 1 }))
      .toBe(canonicalRequestHash({ operation_id: "two", a: 1 }));
    expect(canonicalRequestHash({ values: ["a", "b"] }))
      .not.toBe(canonicalRequestHash({ values: ["b", "a"] }));
    expect(canonicalRequestHash({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects values that JSON cannot represent safely", () => {
    expect(() => canonicalRequestHash({ value: BigInt(1) })).toThrow();
    expect(() => canonicalRequestHash({ value: Number.NaN })).toThrow();
    expect(() => canonicalRequestHash({ values: [undefined] })).toThrow();
  });
});

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function validationAtCycle(
  validation: DependencyValidationRecord,
  cycle: number
): DependencyValidationRecord {
  const spec = validation.validation_spec;
  const specObject = typeof spec === "object" && spec !== null && !Array.isArray(spec)
    ? spec as Record<string, JsonValue>
    : {};
  return {
    ...validation,
    cycle,
    validation_spec: { ...specObject, cycle }
  };
}

class MemoryStore implements ProgressStore, ProgressTransaction {
  readonly tasks = new Map<string, TaskRecord>();
  readonly versions = new Map<string, number>();
  readonly projects = new Map<string, ProjectRecord>();
  readonly projectMembers = new Map<string, ProjectMemberRecord>();
  readonly projectShares = new Map<string, ProjectShareRecord>();
  readonly repositories = new Map<string, RepositoryRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly leases = new Map<string, ActiveTaskLease>();
  readonly checkpoints: CheckpointRecord[] = [];
  readonly snapshots: RepoSnapshotRecord[] = [];
  readonly events: TaskEventRecord[] = [];
  readonly sessionEvents: SessionEventRecord[] = [];
  readonly operations = new Map<string, OperationResult>();
  readonly legacyImports = new Map<string, LegacyTaskImport>();
  readonly taskScopes: TaskScopeRecord[] = [];
  readonly sessionLinks: TaskSessionLinkRecord[] = [];
  readonly decisions: HumanDecisionRecord[] = [];
  readonly dependencies: TaskDependencyRecord[] = [];
  readonly notifications: NotificationRecord[] = [];
  readonly dependencyValidations: DependencyValidationRecord[] = [];
  readonly dependencyValidationRuns: DependencyValidationRunRecord[] = [];
  readonly dependencyRepairs: DependencyRepairRequestRecord[] = [];
  readonly hostKeys = new Map<string, HostKeyRecord>();
  readonly hostChallenges = new Map<string, HostEvidenceChallengeRecord>();
  readonly hostEvidence = new Map<string, HostEvidenceRecord>();
  beforeTransaction: (() => void) | undefined;

  transaction<T>(work: (tx: ProgressTransaction) => T): T {
    const hook = this.beforeTransaction;
    this.beforeTransaction = undefined;
    hook?.();
    return work(this);
  }

  listTasks(filter: TaskListFilter): TaskSummary[] {
    return [...this.tasks.values()]
      .filter((task) => filter.repositoryId === undefined
        || task.repository_id === filter.repositoryId)
      .filter((task) => filter.statuses === undefined
        || filter.statuses.includes(task.status))
      .map((task) => ({ ...task, version: this.versions.get(task.task_id) ?? 0 }))
      .sort((left, right) => left.task_id.localeCompare(right.task_id));
  }

  getTaskDetail(taskId: string): TaskDetail | undefined {
    const task = this.tasks.get(taskId);
    return task === undefined
      ? undefined
      : {
        ...task,
        version: this.versions.get(taskId) ?? 0,
        scopes: this.taskScopes
          .filter((scope) => scope.task_id === taskId)
          .map((scope) => ({ ...scope }))
      };
  }

  getTaskVersion(taskId: string): number | undefined {
    return this.tasks.has(taskId) ? this.versions.get(taskId) ?? 0 : undefined;
  }

  getRepository(repositoryId: string): RepositoryRecord | undefined {
    const repository = this.repositories.get(repositoryId);
    return repository === undefined ? undefined : { ...repository };
  }

  getProject(projectId: string): ProjectRecord | undefined {
    const project = this.projects.get(projectId);
    return project === undefined ? undefined : { ...project };
  }

  getProjectMember(projectId: string, owner: string): ProjectMemberRecord | undefined {
    const member = this.projectMembers.get(`${projectId}\u0000${owner}`);
    return member === undefined ? undefined : { ...member };
  }

  listProjectMembers(projectId: string, includeRevoked = false): ProjectMemberRecord[] {
    return [...this.projectMembers.values()]
      .filter((member) => member.project_id === projectId
        && (includeRevoked || member.revoked_at === null))
      .map((member) => ({ ...member }));
  }

  listRepositories(): RepositoryRecord[] {
    return [...this.repositories.values()].map((repository) => ({ ...repository }))
      .sort((left, right) => left.repository_id.localeCompare(right.repository_id));
  }

  replaceTaskDependencies(
    taskId: string,
    dependsOnTaskIds: readonly string[],
    created_at = new Date().toISOString(),
    policies?: Readonly<Record<string, TaskDependencyRecord["policy"]>>
  ): void {
    for (let i = this.dependencies.length - 1; i >= 0; i -= 1) {
      if (this.dependencies[i]!.task_id === taskId) {
        this.dependencies.splice(i, 1);
      }
    }
    for (const dependsOn of dependsOnTaskIds) {
      this.dependencies.push({
        task_id: taskId,
        depends_on_task_id: dependsOn,
        created_at,
        policy: policies?.[dependsOn] ?? "acceptance_gate"
      });
    }
  }

  listTaskDependencyViews(): TaskDependencyView[] {
    return [];
  }

  listTaskEventViews(): TaskEventView[] {
    return [];
  }

  listSessionEvents(sessionId: string): SessionEventRecord[] {
    return this.sessionEvents
      .filter((event) => event.session_id === sessionId)
      .map((event) => ({ ...event }));
  }

  latestSnapshotsForWorktree(worktreePath: string): SnapshotConflictView[] {
    return this.snapshots
      .filter((snapshot) => snapshot.worktree_path === worktreePath)
      .sort((left, right) => right.captured_at.localeCompare(left.captured_at))
      .map((snapshot) => ({
        task_id: snapshot.task_id,
        worktree_path: snapshot.worktree_path,
        changed_files: [...(snapshot.changed_files ?? [])],
        captured_at: snapshot.captured_at
      }));
  }

  listRepoSnapshotViews(): RepoSnapshotView[] {
    return [];
  }

  listDependentsOf(taskId: string): { task_id: string }[] {
    return this.dependencies
      .filter((dep) => dep.depends_on_task_id === taskId)
      .map((dep) => ({ task_id: dep.task_id }));
  }

  listPeople(): [] {
    return [];
  }

  insertNotification(notification: NotificationRecord): void {
    this.notifications.push({ ...notification });
  }

  nextDependencyValidationCycle(taskId: string): number {
    return this.dependencyValidations
      .filter((validation) => validation.upstream_task_id === taskId)
      .reduce((latest, validation) => Math.max(latest, validation.cycle), 0) + 1;
  }

  insertDependencyValidation(validation: DependencyValidationRecord): void {
    const upstream = this.tasks.get(validation.upstream_task_id);
    const downstream = this.tasks.get(validation.downstream_task_id);
    const snapshot = this.getLatestRepoSnapshot(validation.upstream_task_id);
    assertDependencyValidationSpecIdentity(validation.validation_spec, {
      upstream_task_id: validation.upstream_task_id,
      upstream_task_version: this.getTaskVersion(validation.upstream_task_id) ?? 0,
      upstream_repository_id: upstream?.repository_id,
      downstream_task_id: validation.downstream_task_id,
      downstream_repository_id: downstream?.repository_id,
      cycle: validation.cycle
    });
    this.dependencyValidations.push({
      ...validation,
      validation_spec: sanitizeDependencyValidationSpec(validation.validation_spec, {
        preserve_persisted_fields: true,
        upstream_task_id: validation.upstream_task_id,
        upstream_task_version: this.getTaskVersion(validation.upstream_task_id) ?? 0,
        upstream_repository_id: upstream?.repository_id,
        downstream_task_id: validation.downstream_task_id,
        downstream_repository_id: downstream?.repository_id,
        cycle: validation.cycle,
        ...(snapshot === undefined ? {} : {
          target_revision: snapshot.head_commit,
          target_head_commit: snapshot.head_commit,
          worktree_path: snapshot.worktree_path,
          changed_files: snapshot.changed_files
        })
      })
    });
  }

  listDependencyValidationsForUpstream(taskId: string): DependencyValidationRecord[] {
    return this.dependencyValidations
      .filter((validation) => validation.upstream_task_id === taskId)
      .map((validation) => ({ ...validation }));
  }

  getDependencyRepairRequest(
    repairId: string,
    owner?: string
  ): DependencyRepairRequestRecord | undefined {
    const repair = this.dependencyRepairs.find((candidate) => candidate.repair_id === repairId);
    if (repair === undefined) {
      return undefined;
    }
    if (owner !== undefined && this.tasks.get(repair.upstream_task_id)?.owner !== owner) {
      return undefined;
    }
    return { ...repair };
  }

  getDependencyRepairByValidation(
    validationId: string
  ): DependencyRepairRequestRecord | undefined {
    const repair = this.dependencyRepairs.find((candidate) => (
      candidate.validation_id === validationId
    ));
    return repair === undefined ? undefined : { ...repair };
  }

  listDependencyRepairsForUpstream(taskId: string): DependencyRepairRequestRecord[] {
    return this.dependencyRepairs
      .filter((repair) => repair.upstream_task_id === taskId)
      .map((repair) => ({ ...repair }));
  }

  listDependencyRepairsForDownstream(taskId: string): DependencyRepairRequestRecord[] {
    return this.dependencyRepairs
      .filter((repair) => repair.downstream_task_id === taskId)
      .map((repair) => ({ ...repair }));
  }

  listDependencyRepairRequests(
    owner: string,
    repositoryId?: string
  ): DependencyRepairRequestRecord[] {
    return this.dependencyRepairs
      .filter((repair) => {
        const upstream = this.tasks.get(repair.upstream_task_id);
        return upstream?.owner === owner
          && (repositoryId === undefined || upstream.repository_id === repositoryId);
      })
      .map((repair) => ({ ...repair }));
  }

  insertDependencyRepairRequest(record: DependencyRepairRequestRecord): void {
    this.dependencyRepairs.push({ ...record });
  }

  updateDependencyRepairRequest(
    record: DependencyRepairRequestRecord,
    expectedStatus: DependencyRepairStatus
  ): void {
    const index = this.dependencyRepairs.findIndex((candidate) => (
      candidate.repair_id === record.repair_id && candidate.status === expectedStatus
    ));
    if (index === -1) {
      throw new StorageError("VERSION_CONFLICT", "repair request status changed");
    }
    this.dependencyRepairs[index] = { ...record };
  }

  updateDependencyValidationResponse(
    validationId: string,
    expectedStatus: "pending",
    response: {
      status: "passed" | "rejected";
      responded_by_owner: string;
      response_reason: string | null;
      responded_at: string;
      response_read_at: string | null;
    }
  ): void {
    const index = this.dependencyValidations.findIndex((validation) => (
      validation.validation_id === validationId && validation.status === expectedStatus
    ));
    if (index === -1) {
      throw new StorageError("VERSION_CONFLICT", "validation is no longer pending");
    }
    this.dependencyValidations[index] = {
      ...this.dependencyValidations[index]!,
      ...response,
      response_reason: response.response_reason === null
        ? null
        : sanitizeDependencyValidationText(response.response_reason) ?? "[redacted]",
      request_read_at: this.dependencyValidations[index]!.request_read_at
        ?? response.responded_at
    };
  }

  markDependencyValidationRequestRead(validationId: string, readAt: string): void {
    const index = this.dependencyValidations.findIndex((validation) => validation.validation_id === validationId);
    if (index >= 0) this.dependencyValidations[index] = { ...this.dependencyValidations[index]!, request_read_at: readAt };
  }

  supersedePendingDependencyValidations(taskId: string, _supersededAt?: string): void {
    for (let index = 0; index < this.dependencyValidations.length; index += 1) {
      const validation = this.dependencyValidations[index]!;
      if (validation.upstream_task_id === taskId && validation.status === "pending") {
        this.dependencyValidations[index] = { ...validation, status: "superseded" };
        for (const run of this.dependencyValidationRuns) {
          if (run.validation_id === validation.validation_id
            && (run.status === "queued" || run.status === "claimed" || run.status === "running")) {
            run.status = "cancelled";
            run.completed_at = _supersededAt ?? run.completed_at;
            run.error_reason = "Validation cycle superseded";
            run.updated_at = _supersededAt ?? run.updated_at;
          }
        }
      }
    }
  }

  supersedeDependencyValidationsForDownstream(taskId: string, _supersededAt?: string): void {
    for (let index = 0; index < this.dependencyValidations.length; index += 1) {
      const validation = this.dependencyValidations[index]!;
      if (validation.downstream_task_id === taskId && validation.status === "pending") {
        this.dependencyValidations[index] = {
          ...validation,
          status: "superseded"
        };
      }
      if (validation.downstream_task_id === taskId) {
        for (const run of this.dependencyValidationRuns) {
          if (run.validation_id === validation.validation_id
            && (run.status === "queued" || run.status === "claimed" || run.status === "running")) {
            run.status = "cancelled";
            run.completed_at = _supersededAt ?? run.completed_at;
            run.error_reason = "Downstream task no longer accepts validation runs";
            run.updated_at = _supersededAt ?? run.updated_at;
          }
        }
      }
    }
  }

  getDependencyValidationRun(runId: string): DependencyValidationRunRecord | undefined {
    return this.dependencyValidationRuns.find((run) => run.run_id === runId);
  }

  getActiveDependencyValidationRun(validationId: string): DependencyValidationRunRecord | undefined {
    return this.dependencyValidationRuns
      .filter((run) => run.validation_id === validationId
        && ["queued", "claimed", "running"].includes(run.status))
      .sort((left, right) => right.attempt - left.attempt)[0];
  }

  listDependencyValidationRuns(validationId: string): DependencyValidationRunRecord[] {
    return this.dependencyValidationRuns
      .filter((run) => run.validation_id === validationId)
      .sort((left, right) => right.attempt - left.attempt)
      .map((run) => ({ ...run }));
  }

  insertDependencyValidationRun(run: DependencyValidationRunRecord): void {
    this.dependencyValidationRuns.push({
      ...run,
      verification: sanitizeDependencyValidationEvidence(run.verification),
      progress: sanitizeDependencyValidationProgress(run.progress),
      failure_reason: run.failure_reason === null
        ? null
        : sanitizeDependencyValidationText(run.failure_reason) ?? "[redacted]",
      error_reason: run.error_reason === null
        ? null
        : sanitizeDependencyValidationText(run.error_reason) ?? "[redacted]"
    });
  }

  updateDependencyValidationRun(
    run: DependencyValidationRunRecord,
    expectedStatus?: DependencyValidationRunStatus
  ): void {
    const index = this.dependencyValidationRuns.findIndex((candidate) => candidate.run_id === run.run_id);
    if (index < 0 || (expectedStatus !== undefined
      && this.dependencyValidationRuns[index]!.status !== expectedStatus)) {
      throw new StorageError("VERSION_CONFLICT", "run update conflict");
    }
    this.dependencyValidationRuns[index] = {
      ...run,
      verification: sanitizeDependencyValidationEvidence(run.verification),
      progress: sanitizeDependencyValidationProgress(run.progress),
      failure_reason: run.failure_reason === null
        ? null
        : sanitizeDependencyValidationText(run.failure_reason) ?? "[redacted]",
      error_reason: run.error_reason === null
        ? null
        : sanitizeDependencyValidationText(run.error_reason) ?? "[redacted]"
    };
  }

  renewDependencyValidationRunLease(
    runId: string,
    owner: string,
    sessionId: string,
    heartbeatAt: string,
    expiresAt: string,
    now: string
  ): void {
    const index = this.dependencyValidationRuns.findIndex((run) => (
      run.run_id === runId && run.owner === owner && run.session_id === sessionId
      && run.expires_at > now
    ));
    if (index < 0) throw new StorageError("VERSION_CONFLICT", "run lease renewal rejected");
    this.dependencyValidationRuns[index] = {
      ...this.dependencyValidationRuns[index]!,
      heartbeat_at: heartbeatAt,
      expires_at: expiresAt,
      updated_at: heartbeatAt
    };
  }

  listNotifications(): [] {
    return [];
  }

  markNotificationRead(): void {}

  getDependencyValidation(validationId: string): DependencyValidationView | undefined {
    const validation = this.dependencyValidations.find((candidate) => (
      candidate.validation_id === validationId
    ));
    if (validation === undefined) {
      return undefined;
    }
    const upstream = this.tasks.get(validation.upstream_task_id)!;
    const downstream = this.tasks.get(validation.downstream_task_id)!;
    return {
      ...validation,
      validation_spec: sanitizeDependencyValidationSpec(validation.validation_spec, {
        preserve_persisted_fields: true,
        upstream_task_id: validation.upstream_task_id,
        upstream_task_version: this.getTaskVersion(validation.upstream_task_id) ?? 0,
        upstream_repository_id: upstream.repository_id,
        downstream_task_id: validation.downstream_task_id,
        downstream_repository_id: downstream.repository_id,
        cycle: validation.cycle
      }),
      upstream_owner: upstream.owner ?? null,
      upstream_repository_id: upstream.repository_id,
      upstream_title: upstream.title,
      downstream_owner: downstream.owner ?? null,
      downstream_repository_id: downstream.repository_id,
      downstream_title: downstream.title,
      latest_run: (() => {
        const run = this.listDependencyValidationRuns(validation.validation_id)[0];
        return run === undefined ? null : { ...run, validation_spec: sanitizeDependencyValidationSpec(validation.validation_spec, {
          preserve_persisted_fields: true,
          upstream_task_id: validation.upstream_task_id,
          upstream_task_version: this.getTaskVersion(validation.upstream_task_id) ?? 0,
          upstream_repository_id: upstream.repository_id,
          downstream_task_id: validation.downstream_task_id,
          downstream_repository_id: downstream.repository_id,
          cycle: validation.cycle
        }) };
      })(),
      runs: this.listDependencyValidationRuns(validation.validation_id).map((run) => ({
        ...run,
        validation_spec: sanitizeDependencyValidationSpec(validation.validation_spec, {
          preserve_persisted_fields: true,
          upstream_task_id: validation.upstream_task_id,
          upstream_task_version: this.getTaskVersion(validation.upstream_task_id) ?? 0,
          upstream_repository_id: upstream.repository_id,
          downstream_task_id: validation.downstream_task_id,
          downstream_repository_id: downstream.repository_id,
          cycle: validation.cycle
        })
      }))
    };
  }

  listDependencyValidationViews(taskId: string): DependencyValidationView[] {
    return this.dependencyValidations
      .filter((validation) => validation.upstream_task_id === taskId)
      .map((validation) => this.getDependencyValidation(validation.validation_id)!);
  }

  listDependencyValidationActivities(
    _owner: string,
    _filter?: DependencyValidationListFilter
  ): DependencyValidationActivity[] {
    return [];
  }

  getDependencyValidationGate(taskId: string): DependencyValidationGate {
    const dependents = this.listDependentsOf(taskId)
      .map((entry) => this.tasks.get(entry.task_id))
      .filter((task): task is TaskRecord => (
        task !== undefined && task.status !== "done" && task.status !== "cancelled"
      ));
    const validations = this.listDependencyValidationsForUpstream(taskId);
    const latestCycle = validations.reduce(
      (latest, validation) => {
        const dependency = this.dependencies.find((entry) => (
          entry.task_id === validation.downstream_task_id
            && entry.depends_on_task_id === taskId
        ));
        return dependency !== undefined && validation.requested_at >= dependency.created_at
          ? Math.max(latest, validation.cycle)
          : latest;
      },
      0
    );
    return {
      dependent_count: dependents.length,
      latest_cycle: latestCycle === 0 ? null : latestCycle,
      ready_for_acceptance: dependents.length === 0 || (
        latestCycle > 0 && dependents.every((dependent) => {
          const dependency = this.dependencies.find((entry) => (
            entry.task_id === dependent.task_id
              && entry.depends_on_task_id === taskId
          ));
          return dependency !== undefined && validations.some((validation) => (
            validation.cycle === latestCycle
            && validation.downstream_task_id === dependent.task_id
            && validation.status === "passed"
            && validation.requested_at >= dependency.created_at
          ));
        })
      )
    };
  }

  markDependencyValidationRead(
    _validationId: string,
    _owner: string,
    _perspective: DependencyValidationPerspective
  ): void {}

  listProjects(): ProjectWithRepositories[] {
    const byProject = new Map<string, ProjectWithRepositories>();
    for (const repository of this.listRepositories()) {
      const project = byProject.get(repository.project_id) ?? {
        project_id: repository.project_id,
        name: repository.project_id,
        repositories: []
      };
      project.repositories.push({
        repository_id: repository.repository_id,
        label: repository.label,
        task_count: this.listTasks({ repositoryId: repository.repository_id }).length,
        attention: {
          pending_acceptance: 0,
          blocked: 0,
          stale: 0
        }
      });
      byProject.set(repository.project_id, project);
    }
    return [...byProject.values()];
  }

  listActiveTaskScopes(repositoryId: string): ActiveTaskScope[] {
    return this.scopesForActiveTasks()
      .filter((scope) => this.tasks.get(scope.task_id)?.repository_id === repositoryId)
      .map((scope) => ({
        task_id: scope.task_id,
        scope_type: scope.scope_type,
        scope_value: scope.scope_value
      }))
      .sort((left, right) => left.task_id.localeCompare(right.task_id));
  }

  getTask(taskId: string): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    return task === undefined ? undefined : { ...task };
  }

  insertTask(task: TaskRecord): void {
    if (this.tasks.has(task.task_id)) {
      throw new StorageError("CONSTRAINT_VIOLATION", "task already exists");
    }
    this.tasks.set(task.task_id, { ...task });
    this.versions.set(task.task_id, 0);
  }

  updateTask(task: TaskRecord, expectedVersion: number): void {
    const current = this.versions.get(task.task_id);
    if (current !== expectedVersion) {
      throw new StorageError(
        "VERSION_CONFLICT",
        `Task ${task.task_id} is not at expected version ${expectedVersion}`
      );
    }
    const existing = this.tasks.get(task.task_id);
    const persistedUpdatedAt = existing !== undefined
      && Date.parse(existing.updated_at) > Date.parse(task.updated_at)
      ? existing.updated_at
      : task.updated_at;
    this.tasks.set(task.task_id, { ...task, updated_at: persistedUpdatedAt });
    this.versions.set(task.task_id, current + 1);
  }

  upsertProject(project: ProjectRecord): void {
    const existing = this.projects.get(project.project_id);
    this.projects.set(project.project_id, {
      ...project,
      archived_at: existing?.archived_at ?? null,
      archived_by: existing?.archived_by ?? null
    });
  }

  archiveProject(
    projectId: string,
    archivedBy: string,
    archivedAt: string
  ): ArchiveProjectOutcome {
    const project = this.projects.get(projectId);
    if (project === undefined) {
      return { status: "not_found" };
    }
    if (project.archived_at !== null && project.archived_at !== undefined) {
      return { status: "archived", changed: false, project: { ...project } };
    }
    const openTasks = [...this.tasks.values()]
      .filter((task) => this.repositories.get(task.repository_id)?.project_id === projectId
        && task.status !== "done"
        && task.status !== "cancelled")
      .map((task) => ({
        task_id: task.task_id,
        owner: task.owner ?? null,
        status: task.status,
        repository_id: task.repository_id
      }));
    if (openTasks.length > 0) {
      return { status: "open_tasks", open_tasks: openTasks };
    }
    const archived = {
      ...project,
      archived_at: archivedAt,
      archived_by: archivedBy,
      updated_at: archivedAt
    };
    this.projects.set(projectId, archived);
    return { status: "archived", changed: true, project: { ...archived } };
  }

  unarchiveProject(projectId: string, updatedAt: string): UnarchiveProjectOutcome {
    const project = this.projects.get(projectId);
    if (project === undefined) {
      return { status: "not_found" };
    }
    if (project.archived_at === null || project.archived_at === undefined) {
      return { status: "unarchived", changed: false, project: { ...project } };
    }
    const restored = { ...project, archived_at: null, archived_by: null, updated_at: updatedAt };
    this.projects.set(projectId, restored);
    return { status: "unarchived", changed: true, project: { ...restored } };
  }

  upsertProjectMember(member: ProjectMemberRecord): void {
    this.projectMembers.set(`${member.project_id}\u0000${member.owner}`, { ...member });
  }

  revokeProjectMember(projectId: string, owner: string, revokedAt: string): boolean {
    const key = `${projectId}\u0000${owner}`;
    const member = this.projectMembers.get(key);
    if (member === undefined || member.revoked_at !== null) {
      return false;
    }
    this.projectMembers.set(key, { ...member, revoked_at: revokedAt });
    return true;
  }

  createProjectShare(share: ProjectShareRecord): void {
    this.projectShares.set(share.share_id, { ...share });
  }

  getProjectShareByTokenHash(tokenHash: string): ProjectShareRecord | undefined {
    const share = [...this.projectShares.values()].find((candidate) => (
      candidate.token_hash === tokenHash
    ));
    return share === undefined ? undefined : { ...share };
  }

  consumeProjectShare(shareId: string, tokenHash: string, consumedAt: string): boolean {
    const share = this.projectShares.get(shareId);
    if (share === undefined || share.token_hash !== tokenHash
      || share.consumed_at !== null || share.revoked_at !== null
      || Date.parse(share.expires_at) <= Date.parse(consumedAt)) {
      return false;
    }
    this.projectShares.set(shareId, { ...share, consumed_at: consumedAt });
    return true;
  }

  revokeProjectShare(shareId: string, projectId: string, revokedAt: string): boolean {
    const share = this.projectShares.get(shareId);
    if (share === undefined || share.project_id !== projectId || share.revoked_at !== null) {
      return false;
    }
    this.projectShares.set(shareId, { ...share, revoked_at: revokedAt });
    return true;
  }

  upsertRepository(repository: RepositoryRecord): void {
    for (const existing of this.repositories.values()) {
      if (existing.path === repository.path
        && existing.repository_id !== repository.repository_id) {
        throw new StorageError("CONSTRAINT_VIOLATION", "duplicate repository path");
      }
    }
    this.repositories.set(repository.repository_id, { ...repository });
  }

  getSessionByTransportId(transportSessionId: string): SessionRecord | undefined {
    for (const session of this.sessions.values()) {
      if (session.transport_session_id === transportSessionId) {
        return { ...session };
      }
    }
    return undefined;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : { ...session };
  }

  getSessionBySuccessorId(successorSessionId: string): SessionRecord | undefined {
    return [...this.sessions.values()].find((session) => (
      session.successor_session_id === successorSessionId
    ));
  }

  insertSession(session: SessionRecord): void {
    if (this.sessions.has(session.session_id)) {
      throw new StorageError("CONSTRAINT_VIOLATION", "session already exists");
    }
    this.sessions.set(session.session_id, { ...session });
  }

  updateSessionActivity(sessionId: string, lastActivityAt: string): void {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      session.last_activity_at = lastActivityAt;
      session.stale_at = undefined;
    }
  }

  updateSessionTransport(
    sessionId: string,
    transportSessionId: string,
    lastActivityAt: string
  ): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new StorageError("CONSTRAINT_VIOLATION", `Session ${sessionId} disappeared`);
    }
    session.transport_session_id = transportSessionId;
    session.last_activity_at = lastActivityAt;
    session.stale_at = undefined;
  }

  setSessionResumeTokenHash(sessionId: string, resumeTokenHash: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new StorageError("CONSTRAINT_VIOLATION", `Session ${sessionId} disappeared`);
    }
    session.resume_token_hash = resumeTokenHash;
  }

  updateSessionContext(
    sessionId: string,
    workspacePath: string,
    worktreePath: string,
    lastActivityAt: string
  ): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new StorageError("CONSTRAINT_VIOLATION", "session disappeared");
    }
    session.workspace_path = workspacePath;
    session.worktree_path = worktreePath;
    session.last_activity_at = lastActivityAt;
    session.stale_at = undefined;
  }

  insertSessionEvent(event: SessionEventRecord): void {
    this.sessionEvents.push({ ...event });
  }

  listSessionsInactiveBefore(cutoff: string): SessionRecord[] {
    return [...this.sessions.values()]
      .filter((session) => session.last_activity_at !== undefined
        && session.last_activity_at <= cutoff)
      .map((session) => ({ ...session }));
  }

  setSessionStaleAt(sessionId: string, staleAt: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new StorageError("CONSTRAINT_VIOLATION", "session disappeared");
    }
    session.stale_at = staleAt;
  }

  setSessionSuccessor(
    sessionId: string,
    successorSessionId: string,
    successorCtxId: string | undefined,
    staleAt: string
  ): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.successor_session_id !== undefined) {
      throw new StorageError("VERSION_CONFLICT", "session already succeeded or disappeared");
    }
    session.successor_session_id = successorSessionId;
    if (successorCtxId !== undefined) {
      session.successor_ctx_id = successorCtxId;
    }
    session.stale_at = staleAt;
  }

  getLeaseByTask(taskId: string): ActiveTaskLease | undefined {
    const lease = this.leases.get(taskId);
    return lease === undefined ? undefined : { ...lease };
  }

  getLeaseBySession(sessionId: string): ActiveTaskLease | undefined {
    for (const lease of this.leases.values()) {
      if (lease.session_id === sessionId) {
        return { ...lease };
      }
    }
    return undefined;
  }

  putLease(lease: ActiveTaskLease): void {
    if (this.leases.has(lease.task_id)) {
      throw new StorageError("CONSTRAINT_VIOLATION", "task lease already exists");
    }
    for (const existing of this.leases.values()) {
      if (existing.session_id === lease.session_id) {
        throw new StorageError("CONSTRAINT_VIOLATION", "session lease already exists");
      }
    }
    this.leases.set(lease.task_id, { ...lease });
  }

  deleteLeaseByTask(taskId: string): void {
    this.leases.delete(taskId);
  }

  insertCheckpoint(checkpoint: CheckpointRecord): void {
    this.checkpoints.push({ ...checkpoint });
  }

  insertRepoSnapshot(snapshot: RepoSnapshotRecord): void {
    this.snapshots.push({
      ...snapshot,
      ...(snapshot.changed_files === undefined
        ? {}
        : { changed_files: [...snapshot.changed_files] })
    });
  }

  getLatestRepoSnapshot(taskId: string): RepoSnapshotRecord | undefined {
    return this.snapshots
      .filter((snapshot) => snapshot.task_id === taskId)
      .sort((left, right) => right.captured_at.localeCompare(left.captured_at))[0];
  }

  getHostKey(hostKeyId: string): HostKeyRecord | undefined {
    return this.hostKeys.get(hostKeyId);
  }

  findHostKeyByPublicKey(publicKeyB64: string): HostKeyRecord | undefined {
    return [...this.hostKeys.values()]
      .find((key) => key.public_key_b64 === publicKeyB64);
  }

  listHostKeys(owner?: string): HostKeyRecord[] {
    return [...this.hostKeys.values()]
      .filter((key) => owner === undefined || key.owner === owner)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  getHostEvidenceChallenge(challengeId: string): HostEvidenceChallengeRecord | undefined {
    return this.hostChallenges.get(challengeId);
  }

  getHostEvidence(evidenceId: string): HostEvidenceRecord | undefined {
    return this.hostEvidence.get(evidenceId);
  }

  getHostEvidenceByChallenge(challengeId: string): HostEvidenceRecord | undefined {
    return [...this.hostEvidence.values()]
      .find((evidence) => evidence.challenge_id === challengeId);
  }

  getLatestValidHostEvidence(
    repositoryId: string,
    worktreePath: string,
    nowIso: string
  ): HostEvidenceRecord | undefined {
    let latest: HostEvidenceRecord | undefined;
    // Map iteration preserves insertion order, so the last match wins just
    // like the SQL rowid tiebreaker on the server.
    for (const evidence of this.hostEvidence.values()) {
      if (evidence.repository_id === repositoryId
        && evidence.worktree_path === worktreePath
        && evidence.expires_at > nowIso) {
        latest = evidence;
      }
    }
    return latest;
  }

  insertHostKey(record: HostKeyRecord): void {
    this.hostKeys.set(record.host_key_id, { ...record });
  }

  updateHostKey(record: HostKeyRecord): void {
    this.hostKeys.set(record.host_key_id, { ...record });
  }

  touchHostKeyUsed(hostKeyId: string, usedAtIso: string): void {
    const key = this.hostKeys.get(hostKeyId);
    if (key !== undefined) {
      this.hostKeys.set(hostKeyId, { ...key, last_used_at: usedAtIso });
    }
  }

  insertHostEvidenceChallenge(record: HostEvidenceChallengeRecord): void {
    this.hostChallenges.set(record.challenge_id, { ...record });
  }

  consumeHostEvidenceChallenge(challengeId: string, consumedAtIso: string): boolean {
    const challenge = this.hostChallenges.get(challengeId);
    if (challenge === undefined || challenge.consumed_at !== undefined) {
      return false;
    }
    this.hostChallenges.set(challengeId, { ...challenge, consumed_at: consumedAtIso });
    return true;
  }

  insertHostEvidence(record: HostEvidenceRecord): void {
    this.hostEvidence.set(record.evidence_id, {
      ...record,
      changed_files: [...record.changed_files]
    });
  }

  appendTaskEvent(event: TaskEventRecord): void {
    this.events.push({ ...event });
  }

  findTaskAttemptEvent(taskId: string, attemptId: string): TaskEventRecord | undefined {
    const found = this.events.find((event) => {
      if (event.task_id !== taskId || event.event_type !== "task_attempt_recorded") {
        return false;
      }
      const payload = event.payload;
      return typeof payload === "object" && payload !== null && !Array.isArray(payload)
        && payload.attempt_id === attemptId;
    });
    return found === undefined ? undefined : { ...found };
  }

  listRecentTaskEvents(taskId: string, limit: number): TaskEventRecord[] {
    return this.events
      .filter((event) => event.task_id === taskId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, limit)
      .map((event) => ({ ...event }));
  }

  getOperationResult(sessionId: string, operationId: string): OperationResult | undefined {
    const found = this.operations.get(`${sessionId}|${operationId}`);
    return found === undefined ? undefined : { ...found };
  }

  putOperationResult(result: OperationResult): void {
    const key = `${result.session_id}|${result.operation_id}`;
    if (this.operations.has(key)) {
      throw new StorageError("CONSTRAINT_VIOLATION", "operation already recorded");
    }
    this.operations.set(key, { ...result });
  }

  findLegacyImport(legacyImportKey: string): LegacyTaskImport | undefined {
    const found = this.legacyImports.get(legacyImportKey);
    return found === undefined ? undefined : { ...found };
  }

  insertLegacyImport(record: LegacyTaskImport): void {
    if (this.legacyImports.has(record.legacy_import_key)) {
      throw new StorageError("CONSTRAINT_VIOLATION", "legacy import already exists");
    }
    this.legacyImports.set(record.legacy_import_key, { ...record });
  }

  insertTaskScope(scope: TaskScopeRecord): void {
    this.taskScopes.push({ ...scope });
  }

  replaceTaskWorktreeScope(scope: TaskScopeRecord): void {
    for (let index = this.taskScopes.length - 1; index >= 0; index -= 1) {
      const existing = this.taskScopes[index]!;
      if (existing.task_id === scope.task_id
        && existing.scope_type === "worktree_path") {
        this.taskScopes.splice(index, 1);
      }
    }
    this.taskScopes.push({ ...scope });
  }

  upsertTaskSessionLink(link: TaskSessionLinkRecord): void {
    const index = this.sessionLinks.findIndex((existing) => (
      existing.task_id === link.task_id && existing.session_id === link.session_id
    ));
    if (index === -1) {
      this.sessionLinks.push({ ...link });
    } else {
      this.sessionLinks[index] = { ...link };
    }
  }

  insertHumanDecision(decision: HumanDecisionRecord): void {
    this.decisions.push({ ...decision });
  }

  listPendingHumanDecisions(taskId: string): HumanDecisionRecord[] {
    return this.decisions
      .filter((decision) => decision.task_id === taskId && decision.status === "pending")
      .map((decision) => ({ ...decision }));
  }

  insertTaskDependency(dependency: TaskDependencyRecord): void {
    this.dependencies.push({ ...dependency });
  }

  listTaskDependencies(taskId: string): TaskDependencyRecord[] {
    return this.dependencies
      .filter((dependency) => dependency.task_id === taskId)
      .map((dependency) => ({ ...dependency }));
  }

  listActiveScopesByWorktree(worktreePath: string): ActiveTaskScope[] {
    return this.scopesForActiveTasks()
      .filter((scope) => scope.scope_type === "worktree_path"
        && normalizeWorktree(scope.scope_value) === normalizeWorktree(worktreePath))
      .map((scope) => ({
        task_id: scope.task_id,
        scope_type: scope.scope_type,
        scope_value: scope.scope_value
      }));
  }

  private scopesForActiveTasks(): TaskScopeRecord[] {
    return this.taskScopes.filter((scope) => {
      const task = this.tasks.get(scope.task_id);
      return task !== undefined && task.status !== "done" && task.status !== "cancelled";
    });
  }
}

function normalizeWorktree(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

class FakeProbe {
  readonly drafts = new Map<string, RepoSnapshotDraft>();
  readonly failures = new Map<string, Error>();
  readonly probedPaths: string[] = [];

  async inspect(input: RepoProbeInput): Promise<RepoSnapshotDraft> {
    this.probedPaths.push(input.worktree_path);
    const failure = this.failures.get(input.worktree_path);
    if (failure !== undefined) {
      throw failure;
    }
    const draft = this.drafts.get(input.worktree_path);
    if (draft === undefined) {
      throw new Error(`No fake probe draft for ${input.worktree_path}`);
    }
    return { ...draft, changed_files: [...draft.changed_files] };
  }
}

function draftFor(worktreePath: string, changedFiles: string[] = []): RepoSnapshotDraft {
  return {
    repository_id: "repo-1",
    repository_path: "/repos/project-one",
    worktree_path: worktreePath,
    head_commit: "0123456789abcdef0123456789abcdef01234567",
    content_digest: `sha256:${"a".repeat(64)}`,
    branch: "feature",
    changed_files: changedFiles,
    captured_at: "2026-08-17T10:00:00.000Z"
  };
}

function checkpoint(overrides: Partial<CheckpointPayload> = {}): CheckpointPayload {
  return checkpointPayloadSchema.parse({
    completed_items: ["setup"],
    current_state: "implementation underway",
    human_context: [],
    confirmed_decisions: [],
    pending_decisions: [],
    blockers: [],
    verification: [],
    next_action: "continue implementation",
    ...overrides
  });
}

interface Fixture {
  store: MemoryStore;
  probe: FakeProbe;
  service: TaskService;
  sessionA: SessionRecord;
  sessionB: SessionRecord;
}

let clockTick = 0;

function createFixture(): Fixture {
  const store = new MemoryStore();
  const probe = new FakeProbe();
  clockTick = 0;
  const service = new TaskService({
    store,
    probe,
    now: () => isoAt(clockTick++)
  });

  const sessionA: SessionRecord = {
    session_id: "session-a",
    repository_id: "repo-1",
    label: "Session A",
    owner: "jande",
    started_at: isoAt(0),
    worktree_path: WORKTREE_A,
    last_activity_at: isoAt(0)
  };
  const sessionB: SessionRecord = {
    session_id: "session-b",
    repository_id: "repo-1",
    label: "Session B",
    owner: "jande",
    started_at: isoAt(0),
    worktree_path: WORKTREE_B,
    last_activity_at: isoAt(0)
  };
  store.transaction((tx) => {
    tx.upsertProject({
      project_id: "project-1",
      name: "Project One",
      created_at: isoAt(0),
      updated_at: isoAt(0)
    });
    tx.upsertRepository({
      repository_id: "repo-1",
      project_id: "project-1",
      path: "/repos/project-one",
      label: "Project One",
      created_at: isoAt(0),
      updated_at: isoAt(0)
    });
    tx.insertSession(sessionA);
    tx.insertSession(sessionB);
  });
  probe.drafts.set(WORKTREE_A, draftFor(WORKTREE_A));
  probe.drafts.set(WORKTREE_B, draftFor(WORKTREE_B));

  return { store, probe, service, sessionA, sessionB };
}

function registerSecondRepository(store: MemoryStore): void {
  store.transaction((tx) => {
    tx.upsertProject({
      project_id: "project-2",
      name: "Project Two",
      created_at: isoAt(0),
      updated_at: isoAt(0)
    });
    tx.upsertRepository({
      repository_id: "repo-2",
      project_id: "project-2",
      path: "/repos/project-two",
      label: "Project Two",
      created_at: isoAt(0),
      updated_at: isoAt(0)
    });
    tx.insertSession({
      session_id: "session-c",
      repository_id: "repo-2",
      label: "Session C",
      started_at: isoAt(0),
      worktree_path: WORKTREE_C,
      last_activity_at: isoAt(0)
    });
  });
}

async function createTask(
  service: TaskService,
  overrides: Partial<Parameters<TaskService["createTask"]>[0]> = {}
): Promise<string> {
  const input: Parameters<TaskService["createTask"]>[0] = {
    session_id: overrides.session_id ?? "session-a",
    operation_id: overrides.operation_id
      ?? `op-create-${Math.random().toString(36).slice(2)}`,
    expected_version: 0,
    repository_id: "repo-1",
    title: overrides.title ?? "Implement feature",
    goal: overrides.goal ?? "Ship the feature safely",
    acceptance_criteria: overrides.acceptance_criteria ?? ["All tests pass"],
    next_action: overrides.next_action ?? "start implementation",
    priority: overrides.priority ?? "P1"
  };
  if (overrides.scopes !== undefined) {
    input.scopes = overrides.scopes;
  }
  if (overrides.dependencies !== undefined) {
    input.dependencies = overrides.dependencies;
  }
  const result = await service.createTask(input);
  return result.task_id;
}

async function startedTask(
  service: TaskService,
  sessionId: string,
  operationSuffix: string,
  overrides: Partial<StartTaskInput> = {}
): Promise<{ taskId: string; version: number }> {
  const taskId = await createTask(service, {
    session_id: sessionId,
    operation_id: `op-create-${operationSuffix}`
  });
  const started = await service.startTask({
    session_id: sessionId,
    operation_id: `op-start-${operationSuffix}`,
    task_id: taskId,
    expected_version: 0,
    ...overrides
  });
  return { taskId, version: started.version };
}

const agentActor: TaskActor = "agent";
const humanActor: TaskActor = "human";

async function seedPendingValidation(): Promise<{
  fixture: Fixture;
  validation: DependencyValidationRecord;
}> {
  const fixture = createFixture();
  const { store, service } = fixture;
  store.transaction((tx) => {
    tx.insertSession({
      session_id: "session-downstream",
      repository_id: "repo-1",
      label: "Downstream",
      owner: "owner-downstream",
      started_at: isoAt(0),
      worktree_path: WORKTREE_B,
      last_activity_at: isoAt(0)
    });
    tx.insertSession({
      session_id: "session-wrong-owner",
      repository_id: "repo-1",
      label: "Wrong",
      owner: "owner-other",
      started_at: isoAt(0),
      worktree_path: WORKTREE_C,
      last_activity_at: isoAt(0)
    });
  });
  const { taskId: upstreamId } = await startedTask(service, "session-a", "seed-upstream");
  const downstreamId = await createTask(service, {
    session_id: "session-downstream",
    operation_id: "op-create-downstream",
    owner: "owner-downstream"
  });
  store.insertTaskDependency({
    task_id: downstreamId,
    depends_on_task_id: upstreamId,
    created_at: isoAt(0)
  });
  await service.checkpointTask({
    session_id: "session-a",
    operation_id: "op-checkpoint-seed",
    task_id: upstreamId,
    expected_version: 1,
    checkpoint: checkpoint({
      verification: [{ command: "npm test", outcome: "passed", summary: "green" }]
    }),
    target_status: "verifying"
  });
  await service.submitTask({
    session_id: "session-a",
    operation_id: "op-submit-seed",
    task_id: upstreamId,
    expected_version: 2,
    verification: [{ command: "npm test", outcome: "passed", summary: "green" }]
  });
  return { fixture, validation: store.dependencyValidations[0]! };
}

describe("TaskService", () => {
  it("rejects operation id reuse for a changed request, another tool, or a legacy row", async () => {
    const { store, service } = createFixture();
    const input: CreateTaskInput = {
      session_id: "session-a",
      operation_id: "operation-fingerprint",
      expected_version: 0,
      repository_id: "repo-1",
      title: "Original request",
      goal: "Keep operation retries deterministic",
      acceptance_criteria: ["same request replays"],
      next_action: "create",
      priority: "P1"
    };
    const first = await service.createTask(input);
    expect(await service.createTask({ ...input })).toEqual(first);
    await expect(service.createTask({ ...input, title: "Changed request" }))
      .rejects.toMatchObject({ code: "OPERATION_ID_CONFLICT" });
    await expect(service.attachTask({
      session_id: input.session_id,
      operation_id: input.operation_id,
      task_id: first.task_id,
      role: "implementer"
    })).rejects.toMatchObject({ code: "OPERATION_ID_CONFLICT" });

    const startInput: StartTaskInput = {
      session_id: input.session_id,
      operation_id: "operation-fingerprint-start",
      task_id: first.task_id,
      expected_version: 0
    };
    const started = await service.startTask(startInput);
    expect(await service.startTask({ ...startInput })).toEqual(started);
    await expect(service.startTask({ ...startInput, expected_version: 1 }))
      .rejects.toMatchObject({ code: "OPERATION_ID_CONFLICT" });

    store.putOperationResult({
      session_id: "session-a",
      operation_id: "legacy-operation",
      result: { task_id: "legacy", status: "backlog", version: 0 },
      created_at: isoAt(0)
    });
    await expect(service.createTask({
      ...input,
      operation_id: "legacy-operation"
    })).rejects.toMatchObject({ code: "OPERATION_ID_CONFLICT" });
  });

  it("reads an operation result only from the current session or explicit predecessors", async () => {
    const { store, service } = createFixture();
    store.sessions.set("session-predecessor", {
      session_id: "session-predecessor",
      repository_id: "repo-1",
      label: "predecessor",
      owner: "jande",
      started_at: isoAt(-30),
      successor_session_id: "session-a"
    });
    store.putOperationResult({
      session_id: "session-predecessor",
      operation_id: "unknown-result-recovery",
      tool_name: "task_create",
      request_hash: `sha256:${"c".repeat(64)}`,
      result: { task_id: "task-recovered", status: "backlog", version: 0 },
      created_at: isoAt(-20)
    });

    await expect(service.getOperationResult({
      session_id: "session-a",
      operation_id: "unknown-result-recovery"
    })).resolves.toMatchObject({
      source_session_id: "session-predecessor",
      tool_name: "task_create",
      result: { task_id: "task-recovered" }
    });
    await expect(service.getOperationResult({
      session_id: "session-b",
      operation_id: "unknown-result-recovery"
    })).resolves.toBeUndefined();
  });

  it("creates a backlog task at version 0 with a task_created event and scopes", async () => {
    const { store, service } = createFixture();

    const result = await service.createTask({
      session_id: "session-a",
      operation_id: "op-create-1",
      expected_version: 0,
      repository_id: "repo-1",
      title: "Implement feature",
      goal: "Ship the cache layer safely",
      acceptance_criteria: ["npm test passes", "README updated"],
      next_action: "scaffold the module",
      priority: "P2",
      scopes: [
        { scope_type: "worktree_path", scope_value: WORKTREE_A },
        { scope_type: "module_path", scope_value: "src/core" }
      ]
    });

    expect(result).toMatchObject({ status: "backlog", version: 0 });
    expect(store.getTaskDetail(result.task_id)).toMatchObject({
      status: "backlog",
      version: 0,
      title: "Implement feature",
      goal: "Ship the cache layer safely",
      acceptance_criteria: ["npm test passes", "README updated"],
      priority: "P2"
    });
    expect(store.getTaskDetail(result.task_id)?.checkpoint).toMatchObject({
      completed_items: [],
      current_state: "backlog",
      next_action: "scaffold the module"
    });
    expect(store.getTaskDetail(result.task_id)?.checkpoint?.source).toBeUndefined();
    expect(store.events.map((event) => event.event_type)).toEqual(["task_created"]);
    expect(store.taskScopes.map((scope) => ({
      type: scope.scope_type,
      value: scope.scope_value
    }))).toEqual([
      { type: "worktree_path", value: WORKTREE_A },
      { type: "module_path", value: "src/core" }
    ]);
  });

  it("persists goal and acceptance criteria with a seeded next_action checkpoint", async () => {
    const { store, service } = createFixture();

    const result = await service.createTask({
      session_id: "session-a",
      operation_id: "op-create-seed",
      expected_version: 0,
      repository_id: "repo-1",
      title: "Implement feature",
      goal: "Make the retry path safe",
      acceptance_criteria: ["no flaky retries"],
      next_action: "write the failing test",
      priority: "P1"
    });

    const detail = store.getTaskDetail(result.task_id);
    expect(detail).toMatchObject({
      goal: "Make the retry path safe",
      acceptance_criteria: ["no flaky retries"],
      checkpoint: {
        completed_items: [],
        current_state: "backlog",
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification: [],
        next_action: "write the failing test"
      }
    });
    expect(detail?.checkpoint?.human_context).toEqual([]);
    expect(detail?.checkpoint?.source).toBeUndefined();
    expect(store.checkpoints).toHaveLength(1);
    expect(store.checkpoints[0]).toMatchObject({
      task_id: result.task_id,
      session_id: "session-a",
      payload: detail?.checkpoint
    });
  });

  it("rejects creating a task outside the session repository", async () => {
    const { store, service } = createFixture();
    registerSecondRepository(store);

    await expect(service.createTask({
      session_id: "session-a",
      operation_id: "op-create-cross-repository",
      expected_version: 0,
      repository_id: "repo-2",
      title: "Wrong repository",
      goal: "Must not be created",
      acceptance_criteria: ["creation is rejected"],
      next_action: "stop",
      priority: "P1"
    })).rejects.toMatchObject({ code: "REPOSITORY_NOT_ALLOWED" });
    expect(store.listTasks({ repositoryId: "repo-2" })).toHaveLength(0);
  });

  it("reports a hard conflict for a proposed scope on a leased worktree without probing or writing", async () => {
    const { store, probe, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});
    const probedBefore = probe.probedPaths.length;

    const report = await service.checkTaskConflicts({
      session_id: "session-b",
      proposed: {
        repository_id: "repo-1",
        worktree_path: WORKTREE_A,
        changed_files: ["src/core/new-file.ts"]
      }
    });

    expect(report).toMatchObject({ level: "hard" });
    expect(probe.probedPaths).toHaveLength(probedBefore);
    expect(store.getTaskDetail(taskId)).toMatchObject({ status: "in_progress" });
  });

  it("reports no conflict for a proposed scope on an uncontested worktree", async () => {
    const { probe, service } = createFixture();
    await startedTask(service, "session-a", "1", {});
    const probedBefore = probe.probedPaths.length;

    const report = await service.checkTaskConflicts({
      session_id: "session-b",
      proposed: {
        repository_id: "repo-1",
        worktree_path: "/wt/elsewhere",
        scopes: [{ scope_type: "module_path", scope_value: "src/untouched" }],
        changed_files: ["src/untouched/thing.ts"]
      }
    });

    expect(report).toMatchObject({ level: "none" });
    expect(probe.probedPaths).toHaveLength(probedBefore);
  });

  it("rejects a proposed scope for an unregistered repository", async () => {
    const { service } = createFixture();

    await expect(service.checkTaskConflicts({
      session_id: "session-a",
      proposed: { repository_id: "repo-unknown", worktree_path: "/wt/anywhere" }
    })).rejects.toMatchObject({
      code: "REPOSITORY_NOT_ALLOWED",
      evidence: ["repo-unknown"]
    });
  });

  it("starts a backlog task, moves it to in_progress at version 1, and takes the lease", async () => {
    const { store, service } = createFixture();
    const taskId = await createTask(service, { operation_id: "op-create-1" });
    const startInput: StartTaskInput = {
      session_id: "session-a",
      operation_id: "op-start-1",
      task_id: taskId,
      expected_version: 0
    };

    await expect(service.startTask(startInput)).resolves.toMatchObject({
      status: "in_progress",
      version: 1
    });

    expect(store.getTaskDetail(taskId)).toMatchObject({
      status: "in_progress",
      version: 1,
      session_id: "session-a"
    });
    expect(store.transaction((tx) => tx.getLeaseByTask(taskId))).toMatchObject({
      task_id: taskId,
      session_id: "session-a"
    });
    expect(store.events.map((event) => event.event_type)).toEqual([
      "task_created",
      "task_started"
    ]);
    expect(store.taskScopes).toContainEqual({
      task_scope_id: expect.any(String),
      task_id: taskId,
      scope_type: "worktree_path",
      scope_value: WORKTREE_A
    });
    expect(store.snapshots).toContainEqual(expect.objectContaining({
      task_id: taskId,
      repository_id: "repo-1",
      worktree_path: WORKTREE_A,
      branch: "feature",
      changed_files: []
    }));
  });

  it("rechecks file conflicts inside the start transaction", async () => {
    const { store, probe, service } = createFixture();
    const targetId = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-create-race-target"
    });
    const competitorId = await createTask(service, {
      session_id: "session-b",
      operation_id: "op-create-race-competitor"
    });
    probe.drafts.set(WORKTREE_A, draftFor(WORKTREE_A, ["src/shared.ts"]));
    probe.drafts.set(WORKTREE_B, draftFor(WORKTREE_B, ["src/shared.ts"]));

    let transactionCount = 0;
    const injectCompetitor = (): void => {
      transactionCount += 1;
      if (transactionCount === 1) {
        store.beforeTransaction = injectCompetitor;
        return;
      }
      const competitor = store.getTask(competitorId)!;
      store.updateTask({
        ...competitor,
        status: "in_progress",
        session_id: "session-b",
        updated_at: isoAt(20)
      }, 0);
      store.insertTaskScope({
        task_scope_id: "scope-race-competitor",
        task_id: competitorId,
        scope_type: "worktree_path",
        scope_value: WORKTREE_B
      });
      store.insertRepoSnapshot({
        snapshot_id: "snapshot-race-competitor",
        task_id: competitorId,
        repository_id: "repo-1",
        repository_path: "/repos/project-one",
        head_commit: "fedcba9876543210fedcba9876543210fedcba98",
        captured_at: isoAt(20),
        worktree_path: WORKTREE_B,
        branch: "competitor",
        changed_files: ["src/shared.ts"]
      });
      store.putLease({
        task_id: competitorId,
        session_id: "session-b",
        acquired_at: isoAt(20),
        heartbeat_at: isoAt(20),
        expires_at: isoAt(3_620)
      });
    };
    store.beforeTransaction = injectCompetitor;

    await expect(service.startTask({
      session_id: "session-a",
      operation_id: "op-start-race-target",
      task_id: targetId,
      expected_version: 0
    })).rejects.toMatchObject({ code: "FILE_CONFLICT" });
    expect(store.getTaskDetail(targetId)).toMatchObject({
      status: "backlog",
      version: 0
    });
    expect(store.getLeaseByTask(targetId)).toBeUndefined();
  });

  it("rejects switching without a checkpoint", async () => {
    const { service } = createFixture();
    const { taskId: currentId } = await startedTask(service, "session-a", "1", {});
    const targetId = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-create-2"
    });
    const switchInput: SwitchTaskInput = {
      session_id: "session-a",
      operation_id: "op-switch-1",
      task_id: currentId,
      expected_version: 1,
      checkpoint: checkpoint(),
      target_task_id: targetId,
      target_expected_version: 0
    };

    await expect(service.switchTask({
      ...switchInput,
      checkpoint: undefined
    })).rejects.toMatchObject({ code: "CHECKPOINT_REQUIRED" });
  });

  it("rejects a non-human actor calling humanAccept", async () => {
    const { service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});

    await expect(service.humanAccept(taskId, agentActor)).rejects.toMatchObject({
      code: "HUMAN_CONFIRMATION_REQUIRED"
    });
  });

  it("resumes pending acceptance without recording a rejection", async () => {
    const { store, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});
    await service.checkpointTask({
      session_id: "session-a", operation_id: "resume-checkpoint", task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint({
        verification: [{ command: "npm test", outcome: "passed", summary: "all green" }]
      }),
      target_status: "verifying"
    });
    await service.submitTask({
      session_id: "session-a", operation_id: "resume-submit", task_id: taskId,
      expected_version: 2, verification: [{ command: "npm test", outcome: "passed", summary: "all green" }]
    });
    const result = await service.humanResume(taskId, humanActor);
    expect(result).toMatchObject({ status: "paused", version: 4 });
    expect(store.getTaskDetail(taskId)?.status).toBe("paused");
    expect(store.events.at(-1)?.event_type).toBe("task_resumed");
    const resumed = await service.startTask({
      session_id: "session-a", operation_id: "resume-start", task_id: taskId,
      expected_version: result.version
    });
    expect(store.transaction((tx) => tx.getLeaseByTask(taskId))?.session_id).toBe("session-a");
    await expect(service.checkpointTask({
      session_id: "session-a", operation_id: "resume-continued", task_id: taskId,
      expected_version: resumed.version, checkpoint: checkpoint()
    })).resolves.toMatchObject({ status: "in_progress" });
  });

  it("submits verification evidence and moves the task to pending_acceptance without a lease", async () => {
    const { store, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint-1",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint({
        verification: [{
          command: "npm test",
          outcome: "passed",
          summary: "all green"
        }]
      }),
      target_status: "verifying"
    });

    await expect(service.submitTask({
      session_id: "session-a",
      operation_id: "op-submit-1",
      task_id: taskId,
      expected_version: 2,
      verification: [{
        command: "npm test",
        outcome: "passed",
        summary: "all green"
      }]
    })).resolves.toMatchObject({ status: "pending_acceptance" });

    expect(store.getTaskDetail(taskId)).toMatchObject({
      status: "pending_acceptance",
      version: 3
    });
    expect(store.transaction((tx) => tx.getLeaseByTask(taskId))).toBeUndefined();
    expect(store.events.map((event) => event.event_type)).toEqual([
      "task_created",
      "task_started",
      "task_checkpointed",
      "task_submitted"
    ]);
  });

  it("rejects submission without passing verification evidence", async () => {
    const { service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});

    await expect(service.submitTask({
      session_id: "session-a",
      operation_id: "op-submit-1",
      task_id: taskId,
      expected_version: 1,
      verification: [{
        command: "npm test",
        outcome: "failed",
        summary: "one failing test"
      }]
    })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    await expect(service.submitTask({
      session_id: "session-a",
      operation_id: "op-submit-2",
      task_id: taskId,
      expected_version: 1,
      verification: []
    })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("requires every warning code to be acknowledged before starting", async () => {
    const { store, service } = createFixture();
    store.transaction((tx) => {
      tx.insertTask({
        task_id: "task-other",
        repository_id: "repo-1",
        session_id: "session-b",
        title: "Other feature",
        status: "in_progress",
        priority: "P1",
        created_at: isoAt(0),
        updated_at: isoAt(0)
      });
      tx.insertTaskScope({
        task_scope_id: "scope-other-1",
        task_id: "task-other",
        scope_type: "worktree_path",
        scope_value: WORKTREE_B
      });
      tx.insertTaskScope({
        task_scope_id: "scope-other-2",
        task_id: "task-other",
        scope_type: "module_path",
        scope_value: "src/shared"
      });
      tx.putLease({
        task_id: "task-other",
        session_id: "session-b",
        acquired_at: isoAt(0),
        heartbeat_at: isoAt(0),
        expires_at: isoAt(1_800)
      });
    });
    const taskId = await createTask(service, {
      operation_id: "op-create-1",
      scopes: [{ scope_type: "module_path", scope_value: "src/shared" }]
    });
    const warningInput: StartTaskInput = {
      session_id: "session-a",
      operation_id: "op-start-1",
      task_id: taskId,
      expected_version: 0,
      acknowledged_warning_codes: ["MODULE_OVERLAP"]
    };

    await expect(service.startTask({
      ...warningInput,
      acknowledged_warning_codes: []
    })).rejects.toMatchObject({ code: "HUMAN_CONFIRMATION_REQUIRED" });

    await expect(service.startTask(warningInput)).resolves.toMatchObject({
      status: "in_progress",
      version: 1
    });
  });

  it("rejects a hard worktree conflict when starting", async () => {
    const { store, service } = createFixture();
    store.transaction((tx) => {
      tx.insertTask({
        task_id: "task-other",
        repository_id: "repo-1",
        session_id: "session-b",
        title: "Other feature",
        status: "in_progress",
        priority: "P1",
        created_at: isoAt(0),
        updated_at: isoAt(0)
      });
      tx.insertTaskScope({
        task_scope_id: "scope-other-1",
        task_id: "task-other",
        scope_type: "worktree_path",
        scope_value: WORKTREE_A
      });
      tx.putLease({
        task_id: "task-other",
        session_id: "session-b",
        acquired_at: isoAt(0),
        heartbeat_at: isoAt(0),
        expires_at: isoAt(1_800)
      });
    });
    const taskId = await createTask(service, { operation_id: "op-create-1" });

    await expect(service.startTask({
      session_id: "session-a",
      operation_id: "op-start-1",
      task_id: taskId,
      expected_version: 0
    })).rejects.toMatchObject({
      code: "WORKTREE_CONFLICT",
      retryable: false,
      evidence: expect.any(Array),
      recovery_actions: expect.any(Array)
    });
  });

  it.each(["done", "cancelled", "foreign-lease"])("protects dependency updates on %s tasks", async (kind) => {
    const { fixture, validation } = await seedPendingValidation();
    const taskId = validation.downstream_task_id;
    if (kind === "foreign-lease") {
      fixture.store.putLease({ task_id: taskId, session_id: "session-b", acquired_at: isoAt(0), heartbeat_at: isoAt(0), expires_at: isoAt(10000) });
    } else {
      fixture.store.tasks.get(taskId)!.status = kind as "done" | "cancelled";
    }
    await expect(fixture.service.updateTaskDependencies({
      session_id: "session-downstream", operation_id: `protected-policy-${kind}`,
      task_id: taskId, expected_version: 0, dependencies: [validation.upstream_task_id],
      policies: { [validation.upstream_task_id]: "validation_gate" }
    })).rejects.toMatchObject({ code: kind === "foreign-lease" ? "TASK_LEASE_CONFLICT" : "INVALID_TRANSITION" });
    expect(fixture.store.dependencies[0]!.policy).toBeUndefined();
  });

  it("persists policy-only updates and preserves a true policy no-op", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const { store, service } = fixture;
    const downstreamId = validation.downstream_task_id;
    store.dependencies[0]!.policy = "validation_gate";
    const originalEdge = { ...store.dependencies[0]! };
    await service.updateTaskDependencies({
      session_id: "session-downstream", operation_id: "policy-only",
      task_id: downstreamId, expected_version: 0,
      dependencies: [validation.upstream_task_id],
      policies: { [validation.upstream_task_id]: "acceptance_gate" }
    });
    expect(store.dependencies[0]!.policy).toBe("acceptance_gate");
    expect(store.dependencies[0]!.created_at).not.toBe(originalEdge.created_at);
    expect(store.dependencyValidations[0]!.status).toBe("superseded");
    await expect(service.humanAccept(validation.upstream_task_id, humanActor))
      .rejects.toMatchObject({ code: "DEPENDENCY_VALIDATION_REQUIRED" });
    const changedEdge = { ...store.dependencies[0]! };
    await service.updateTaskDependencies({
      session_id: "session-downstream", operation_id: "policy-noop",
      task_id: downstreamId, expected_version: 1,
      dependencies: [validation.upstream_task_id],
      policies: { [validation.upstream_task_id]: "acceptance_gate" }
    });
    expect(store.dependencies[0]).toEqual(changedEdge);
  });

  it("preserves a current passed response and acceptance gate on an equivalent policy no-op", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const run = await fixture.service.receiveDependencyValidation({ session_id: "session-downstream", operation_id: "noop-receive", validation_id: validation.validation_id, owner: "owner-downstream" });
    await fixture.service.completeDependencyValidation({ session_id: "session-downstream", operation_id: "noop-pass", validation_id: validation.validation_id, run_id: run.run_id, owner: "owner-downstream", status: "passed", verification: [{ command: "npm test", outcome: "passed", summary: "green" }] });
    const before = structuredClone(fixture.store.dependencyValidations[0]);
    const edge = { ...fixture.store.dependencies[0]! };
    await fixture.service.updateTaskDependencies({ session_id: "session-downstream", operation_id: "passed-noop", task_id: validation.downstream_task_id, expected_version: 0, dependencies: [validation.upstream_task_id], policies: { [validation.upstream_task_id]: "acceptance_gate" } });
    expect(fixture.store.dependencies[0]).toEqual(edge);
    expect(fixture.store.dependencyValidations[0]).toEqual(before);
    expect(fixture.store.getDependencyValidationGate(validation.upstream_task_id)).toMatchObject({ ready_for_acceptance: true });
  });

  it("binds new validation requests to the edge context rather than the cycle number", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const { store, service } = fixture;
    await service.updateTaskDependencies({
      session_id: "session-downstream", operation_id: "new-generation",
      task_id: validation.downstream_task_id, expected_version: 0,
      dependencies: [validation.upstream_task_id],
      policies: { [validation.upstream_task_id]: "hard_block" }
    });
    const edge = store.dependencies[0]!;
    edge.ctx_id = "edge-generation-7";
    edge.generation = 7;
    await service.requestTaskDependencyValidation({
      session_id: "session-a", operation_id: "new-generation-request",
      task_id: validation.upstream_task_id, expected_version: 3,
      verification: [{ command: "npm test", outcome: "passed", summary: "green" }]
    });
    expect(store.dependencyValidations[1]).toMatchObject({ ctx_id: "edge-generation-7", cycle: 2 });
    expect(store.events.at(-1)).toMatchObject({ payload: expect.objectContaining({ ctx_ids: ["edge-generation-7"] }) });
  });

  it("backfills only missing current-edge validations without resubmitting or rewriting history", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const { store, service } = fixture;
    const lateDownstream = await createTask(service, { session_id: "session-b" });
    await service.updateTaskDependencies({
      session_id: "session-b", operation_id: "late-edge", task_id: lateDownstream,
      expected_version: 0, dependencies: [validation.upstream_task_id]
    });
    const passedRun = await service.receiveDependencyValidation({ session_id: "session-downstream", operation_id: "existing-receive", validation_id: validation.validation_id, owner: "owner-downstream" });
    await service.completeDependencyValidation({ session_id: "session-downstream", operation_id: "existing-pass", validation_id: validation.validation_id, run_id: passedRun.run_id, owner: "owner-downstream", status: "passed", verification: [{ command: "npm test", outcome: "passed", summary: "green" }] });
    const before = structuredClone(store.dependencyValidations[0]);
    const snapshotsBefore = store.snapshots.length;
    const request = {
      session_id: "session-a", operation_id: "backfill", task_id: validation.upstream_task_id,
      expected_version: 3,
      verification: [{ command: "npm test", outcome: "passed" as const, summary: "green" }]
    };
    const result = await service.requestTaskDependencyValidation(request);
    expect(result).toMatchObject({ status: "pending_acceptance", version: 4 });
    expect(store.dependencyValidations).toHaveLength(2);
    expect(store.dependencyValidations[0]).toEqual(before);
    expect(store.dependencyValidations[1]).toMatchObject({ downstream_task_id: lateDownstream, cycle: 2 });
    expect(store.snapshots).toHaveLength(snapshotsBefore);
    expect(await service.requestTaskDependencyValidation(request)).toEqual(result);
    await expect(service.requestTaskDependencyValidation({ ...request, operation_id: "backfill-noop", expected_version: 4 }))
      .resolves.toMatchObject({ version: 4 });
    expect(store.dependencyValidations).toHaveLength(2);
    await expect(service.requestTaskDependencyValidation({ ...request, verification: [] }))
      .rejects.toMatchObject({ code: "OPERATION_ID_CONFLICT" });
    expect(store.events.filter(event => event.event_type === "task_submitted")).toHaveLength(1);
    await expect(service.humanAccept(validation.upstream_task_id, humanActor))
      .rejects.toMatchObject({ code: "DEPENDENCY_VALIDATION_REQUIRED" });
  });

  it.each([
    ["owner", "OWNER_MISMATCH"], ["repository", "REPOSITORY_NOT_ALLOWED"],
    ["worktree", "CHECKPOINT_REQUIRED"], ["changed", "CHECKPOINT_REQUIRED"],
    ["snapshot", "CHECKPOINT_REQUIRED"], ["evidence", "CHECKPOINT_REQUIRED"],
    ["lease", "TASK_LEASE_CONFLICT"], ["occupied", "TASK_LEASE_CONFLICT"],
    ["terminal", "INVALID_TRANSITION"], ["cancelled", "INVALID_TRANSITION"],
    ["empty", "CHECKPOINT_REQUIRED"], ["missing", "CHECKPOINT_REQUIRED"], ["context-race", "SESSION_CONTEXT_CONFLICT"],
    ["version", "TASK_VERSION_CONFLICT"]
  ])("rejects unsafe validation backfill: %s", async (kind, code) => {
    const { fixture, validation } = await seedPendingValidation();
    const { store, service, probe } = fixture;
    const task = store.tasks.get(validation.upstream_task_id)!;
    if (kind === "owner") store.sessions.get("session-a")!.owner = "intruder";
    if (kind === "repository") store.sessions.get("session-a")!.repository_id = "repo-other";
    if (kind === "worktree") store.sessions.get("session-a")!.worktree_path = WORKTREE_B;
    if (kind === "changed") probe.drafts.set(WORKTREE_A, { ...draftFor(WORKTREE_A), content_digest: `sha256:${"b".repeat(64)}` });
    if (kind === "snapshot") store.snapshots.splice(0);
    if (kind === "evidence") task.checkpoint!.verification[0]!.code_fingerprint!.provenance = "client_reported";
    if (kind === "terminal") task.status = "done";
    if (kind === "cancelled") task.status = "cancelled";
    if (kind === "missing") task.checkpoint = undefined;
    if (kind === "context-race") {
      const inspect = probe.inspect.bind(probe);
      probe.inspect = async input => {
        const draft = await inspect(input);
        store.sessions.get("session-a")!.worktree_path = WORKTREE_B;
        return draft;
      };
    }
    if (kind === "occupied") {
      await startedTask(service, "session-a", "occupied-session");
    }
    if (kind === "lease") store.putLease({ task_id: task.task_id, session_id: "session-b", acquired_at: isoAt(0), heartbeat_at: isoAt(0), expires_at: isoAt(10000) });
    await expect(service.requestTaskDependencyValidation({
      session_id: "session-a", operation_id: `unsafe-${kind}`, task_id: task.task_id,
      expected_version: kind === "version" ? 0 : 3,
      verification: kind === "empty" ? [] : [{ command: "npm test", outcome: "passed", summary: "green" }]
    })).rejects.toMatchObject({ code });
    expect(store.dependencyValidations).toHaveLength(1);
  });

  it("replaces task dependencies with version bump and rejects unknown targets", async () => {
    const { store, service } = createFixture();
    const dep1 = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-dep-1"
    });
    const dep2 = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-dep-2"
    });
    const main = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-dep-main",
      dependencies: [dep1]
    });

    const updated = await service.updateTaskDependencies({
      session_id: "session-a",
      operation_id: "op-dep-replace",
      task_id: main,
      expected_version: 0,
      dependencies: [dep2]
    });
    expect(updated).toMatchObject({ task_id: main, version: 1 });

    const deps = store.transaction((tx) => tx.listTaskDependencies(main));
    expect(deps.map((d) => d.depends_on_task_id)).toEqual([dep2]);

    await expect(service.updateTaskDependencies({
      session_id: "session-a",
      operation_id: "op-dep-bad",
      task_id: main,
      expected_version: 1,
      dependencies: ["task-that-does-not-exist"]
    })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });

    await expect(service.updateTaskDependencies({
      session_id: "session-a",
      operation_id: "op-dep-stale",
      task_id: main,
      expected_version: 0,
      dependencies: []
    })).rejects.toMatchObject({ code: "TASK_VERSION_CONFLICT" });
  });

  it("requires the bound owner to update a task's dependency edges", async () => {
    const { store, service } = createFixture();
    const taskId = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-owner-dependency-task"
    });
    store.sessions.set("session-b", {
      ...store.sessions.get("session-b")!,
      owner: "owner-other"
    });

    await expect(service.updateTaskDependencies({
      session_id: "session-b",
      operation_id: "op-owner-dependency-write",
      task_id: taskId,
      expected_version: 0,
      dependencies: []
    })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });

  it("rejects starting a task in a different repository than the session is bound to", async () => {
    const { store, probe, service } = createFixture();
    registerSecondRepository(store);
    probe.drafts.set(WORKTREE_C, {
      ...draftFor(WORKTREE_C),
      repository_id: "repo-2",
      repository_path: "/repos/project-two"
    });
    // Create a task in a different repo
    const backendTask = await service.createTask({
      session_id: "session-a",
      operation_id: "op-cross-1",
      expected_version: 0,
      repository_id: "repo-1",
      title: "Backend task",
      goal: "belongs to repo-1",
      acceptance_criteria: ["cross-repo guard"],
      next_action: "should not be startable from repo-2 session",
      priority: "P1"
    });

    await expect(service.startTask({
      session_id: "session-c",
      operation_id: "op-cross-start",
      task_id: backendTask.task_id,
      expected_version: 0
    })).rejects.toMatchObject({ code: "REPOSITORY_NOT_ALLOWED" });

    await expect(service.checkpointTask({
      session_id: "session-c",
      operation_id: "op-cross-cp",
      task_id: backendTask.task_id,
      expected_version: 0,
      checkpoint: {
        completed_items: [], current_state: "x", human_context: [],
        confirmed_decisions: [], pending_decisions: [], blockers: [],
        verification: [], next_action: "x"
      }
    })).rejects.toMatchObject({ code: "REPOSITORY_NOT_ALLOWED" });
  });

  it("rejects implicit takeover by a same-family session on the same worktree", async () => {
    const { store, service } = createFixture();
    // Two sessions with the same client_family and worktree
    store.transaction((tx) => {
      tx.insertSession({
        session_id: "session-old",
        repository_id: "repo-1",
        label: "codex old",
        started_at: new Date().toISOString(),
        client_family: "codex",
        owner: "jande",
        worktree_path: WORKTREE_A
      });
      tx.insertSession({
        session_id: "session-new",
        repository_id: "repo-1",
        label: "codex new",
        started_at: new Date().toISOString(),
        client_family: "codex",
        owner: "jande",
        worktree_path: WORKTREE_A
      });
    });

    const { taskId } = await startedTask(service, "session-old", "succ");
    await expect(service.checkpointTask({
      session_id: "session-new",
      operation_id: "op-succ-1",
      task_id: taskId,
      expected_version: 1,
      checkpoint: {
        completed_items: [],
        current_state: "after transport rotation",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification: [],
        next_action: "continue seamlessly"
      }
    })).rejects.toMatchObject({ code: "TASK_LEASE_CONFLICT" });
    expect(store.transaction((tx) => tx.getLeaseByTask(taskId)))
      .toMatchObject({ session_id: "session-old" });
    expect(store.transaction((tx) => tx.getTask(taskId)))
      .toMatchObject({ session_id: "session-old" });
    expect(store.transaction((tx) => tx.listActiveScopesByWorktree(WORKTREE_A)))
      .toEqual([expect.objectContaining({ task_id: taskId })]);
  });

  it("rejects implicit takeover on the task_start path", async () => {
    const { store, service } = createFixture();
    store.transaction((tx) => {
      tx.insertSession({
        session_id: "session-old-start",
        repository_id: "repo-1",
        label: "codex old",
        started_at: new Date().toISOString(),
        client_family: "codex",
        owner: "jande",
        worktree_path: WORKTREE_A
      });
      tx.insertSession({
        session_id: "session-new-start",
        repository_id: "repo-1",
        label: "codex new",
        started_at: new Date().toISOString(),
        client_family: "codex",
        owner: "jande",
        worktree_path: WORKTREE_A
      });
    });

    const { taskId } = await startedTask(service, "session-old-start", "succ-start");
    // Pause to release the worktree but leave a scenario where the lease lingers
    // (simulate: lease still on old session, task in paused via direct store write)
    const detail = store.getTaskDetail(taskId);
    if (detail !== undefined) {
      store.transaction((tx) => {
        tx.updateTask({
          ...detail,
          status: "paused" as const,
          updated_at: new Date().toISOString()
        }, 1);
      });
    }
    await expect(service.startTask({
      session_id: "session-new-start",
      operation_id: "op-succ-start",
      task_id: taskId,
      expected_version: 2
    })).rejects.toMatchObject({ code: "TASK_LEASE_CONFLICT" });
  });

  it("treats an expired lingering lease as absent on the task_start path", async () => {
    const { store, service } = createFixture();
    store.transaction((tx) => {
      tx.insertSession({
        session_id: "session-dead-holder",
        repository_id: "repo-1",
        label: "codex dead",
        started_at: new Date().toISOString(),
        client_family: "codex",
        owner: "jande",
        worktree_path: WORKTREE_A
      });
      tx.insertSession({
        session_id: "session-next",
        repository_id: "repo-1",
        label: "codex next",
        started_at: new Date().toISOString(),
        client_family: "codex",
        owner: "jande",
        worktree_path: WORKTREE_A
      });
    });

    const { taskId } = await startedTask(service, "session-dead-holder", "expired-lease");
    const detail = store.getTaskDetail(taskId);
    if (detail !== undefined) {
      store.transaction((tx) => {
        tx.updateTask({
          ...detail,
          status: "paused" as const,
          updated_at: new Date().toISOString()
        }, 1);
        // The holder died without releasing: the lease row lingers but expired long ago.
        tx.deleteLeaseByTask(taskId);
        tx.putLease({
          task_id: taskId,
          session_id: "session-dead-holder",
          acquired_at: isoAt(-7_200),
          heartbeat_at: isoAt(-7_200),
          expires_at: isoAt(-3_600)
        });
      });
    }

    const started = await service.startTask({
      session_id: "session-next",
      operation_id: "op-expired-lease-start",
      task_id: taskId,
      expected_version: 2
    });
    expect(started.status).toBe("in_progress");
    expect(store.transaction((tx) => tx.getLeaseByTask(taskId)))
      .toMatchObject({ session_id: "session-next" });
  });

  it("recovers an in-progress task whose previous session lease expired", async () => {
    const { store, service } = createFixture();
    store.transaction((tx) => {
      tx.insertSession({
        session_id: "session-next",
        repository_id: "repo-1",
        label: "next session",
        owner: "jande",
        started_at: isoAt(0),
        worktree_path: WORKTREE_A
      });
    });
    const { taskId } = await startedTask(service, "session-a", "in-progress-expired");
    store.transaction((tx) => {
      tx.deleteLeaseByTask(taskId);
      tx.putLease({
        task_id: taskId,
        session_id: "session-a",
        acquired_at: isoAt(-7_200),
        heartbeat_at: isoAt(-7_200),
        expires_at: isoAt(-3_600)
      });
    });

    const recovered = await service.startTask({
      session_id: "session-next",
      operation_id: "op-in-progress-expired-recovery",
      task_id: taskId,
      expected_version: 1
    });

    expect(recovered).toMatchObject({ status: "in_progress", version: 2 });
    expect(store.transaction((tx) => tx.getLeaseByTask(taskId)))
      .toMatchObject({ session_id: "session-next" });
    expect(store.getTaskDetail(taskId)).toMatchObject({ session_id: "session-next", version: 2 });
    expect(store.events).toContainEqual(expect.objectContaining({
      event_type: "task_lease_recovered",
      payload: expect.objectContaining({
        reason: "expired_lease",
        previous_session_id: "session-a"
      })
    }));

    const checkpointed = await service.checkpointTask({
      session_id: "session-next",
      operation_id: "op-after-expired-recovery",
      task_id: taskId,
      expected_version: 2,
      checkpoint: {
        completed_items: ["recovered"], current_state: "working", human_context: [],
        confirmed_decisions: [], pending_decisions: [], blockers: [],
        verification: [], next_action: "continue"
      }
    });
    expect(checkpointed).toMatchObject({ status: "in_progress", version: 3 });
  });

  it("recovers an in-progress task after its expired lease row was already removed", async () => {
    const { store, service } = createFixture();
    store.transaction((tx) => {
      tx.insertSession({
        session_id: "session-next",
        repository_id: "repo-1",
        label: "next session",
        owner: "jande",
        started_at: isoAt(0),
        worktree_path: WORKTREE_A
      });
      tx.insertSession({
        session_id: "session-late",
        repository_id: "repo-1",
        label: "late session",
        owner: "jande",
        started_at: isoAt(0),
        worktree_path: WORKTREE_A
      });
    });
    const { taskId } = await startedTask(service, "session-a", "in-progress-no-lease");
    store.transaction((tx) => tx.deleteLeaseByTask(taskId));

    await expect(service.startTask({
      session_id: "session-next",
      operation_id: "op-in-progress-no-lease-recovery",
      task_id: taskId,
      expected_version: 1
    })).resolves.toMatchObject({ status: "in_progress", version: 2 });
    expect(store.events).toContainEqual(expect.objectContaining({
      event_type: "task_lease_recovered",
      payload: expect.objectContaining({ reason: "missing_lease" })
    }));
    expect(store.transaction((tx) => tx.getLeaseByTask(taskId)))
      .toMatchObject({ session_id: "session-next" });
    await expect(service.startTask({
      session_id: "session-late",
      operation_id: "op-in-progress-racing-recovery",
      task_id: taskId,
      expected_version: 1
    })).rejects.toMatchObject({ code: "TASK_VERSION_CONFLICT" });
  });

  it("uses one lease-expiry decision when a lease reaches its deadline during recovery", async () => {
    const { store, probe, service } = createFixture();
    store.transaction((tx) => {
      tx.insertSession({
        session_id: "session-next",
        repository_id: "repo-1",
        label: "next session",
        owner: "jande",
        started_at: isoAt(0),
        worktree_path: WORKTREE_A
      });
    });
    const { taskId } = await startedTask(service, "session-a", "lease-deadline");
    store.transaction((tx) => {
      tx.deleteLeaseByTask(taskId);
      tx.putLease({
        task_id: taskId,
        session_id: "session-a",
        acquired_at: isoAt(0),
        heartbeat_at: isoAt(0),
        expires_at: isoAt(101)
      });
    });
    let clockReads = 0;
    const boundaryService = new TaskService({
      store,
      probe,
      now: () => isoAt(100 + clockReads++ * 2)
    });

    await expect(boundaryService.startTask({
      session_id: "session-next",
      operation_id: "op-lease-deadline-recovery",
      task_id: taskId,
      expected_version: 1
    })).rejects.toMatchObject({ code: "TASK_LEASE_CONFLICT" });
    expect(store.transaction((tx) => tx.getLeaseByTask(taskId)))
      .toMatchObject({ session_id: "session-a" });
  });

  it("does not reclaim an in-progress task while another session lease is valid", async () => {
    const { store, service } = createFixture();
    store.transaction((tx) => {
      tx.insertSession({
        session_id: "session-next",
        repository_id: "repo-1",
        label: "next session",
        owner: "jande",
        started_at: isoAt(0),
        worktree_path: WORKTREE_A
      });
    });
    const { taskId } = await startedTask(service, "session-a", "in-progress-valid-lease");

    await expect(service.startTask({
      session_id: "session-next",
      operation_id: "op-in-progress-valid-lease",
      task_id: taskId,
      expected_version: 1
    })).rejects.toMatchObject({ code: "TASK_LEASE_CONFLICT" });
    expect(store.getTaskDetail(taskId)).toMatchObject({ session_id: "session-a", version: 1 });
    expect(store.transaction((tx) => tx.getLeaseByTask(taskId)))
      .toMatchObject({ session_id: "session-a" });
  });

  it("keeps expired-lease recovery on the original worktree and owner", async () => {
    const { store, service } = createFixture();
    store.transaction((tx) => {
      tx.insertSession({
        session_id: "session-other-owner",
        repository_id: "repo-1",
        label: "other owner",
        owner: "other",
        started_at: isoAt(0),
        worktree_path: WORKTREE_A
      });
    });
    const { taskId } = await startedTask(service, "session-a", "in-progress-guards");
    store.transaction((tx) => {
      tx.deleteLeaseByTask(taskId);
      tx.putLease({
        task_id: taskId,
        session_id: "session-a",
        acquired_at: isoAt(-7_200),
        heartbeat_at: isoAt(-7_200),
        expires_at: isoAt(-3_600)
      });
    });

    await expect(service.startTask({
      session_id: "session-b", operation_id: "op-expired-wrong-worktree",
      task_id: taskId, expected_version: 1
    })).rejects.toMatchObject({ code: "WORKTREE_CONFLICT" });
    await expect(service.startTask({
      session_id: "session-other-owner", operation_id: "op-expired-wrong-owner",
      task_id: taskId, expected_version: 1
    })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    await expect(service.startTask({
      session_id: "session-a", operation_id: "op-expired-stale-version",
      task_id: taskId, expected_version: 0
    })).rejects.toMatchObject({ code: "TASK_VERSION_CONFLICT" });
    expect(store.getTaskDetail(taskId)).toMatchObject({ session_id: "session-a", version: 1 });
    expect(store.transaction((tx) => tx.getLeaseByTask(taskId)))
      .toMatchObject({ session_id: "session-a" });
  });

  it("never infers succession from owner, client family, repository, or worktree", async () => {
    const { store, service } = createFixture();
    store.transaction((tx) => {
      tx.insertSession({
        session_id: "session-codex-a",
        repository_id: "repo-1",
        label: "codex wt-a",
        started_at: new Date().toISOString(),
        client_family: "codex",
        owner: "jande",
        worktree_path: WORKTREE_A
      });
      tx.insertSession({
        session_id: "session-claude",
        repository_id: "repo-1",
        label: "claude wt-a",
        started_at: new Date().toISOString(),
        client_family: "claude_code",
        owner: "jande",
        worktree_path: WORKTREE_A
      });
      tx.insertSession({
        session_id: "session-codex-b",
        repository_id: "repo-1",
        label: "codex wt-b",
        started_at: new Date().toISOString(),
        client_family: "codex",
        owner: "jande",
        worktree_path: WORKTREE_B
      });
      tx.insertSession({
        session_id: "session-codex-other-owner",
        repository_id: "repo-1",
        label: "codex other owner",
        started_at: new Date().toISOString(),
        client_family: "codex",
        owner: "other-user",
        worktree_path: WORKTREE_B
      });
    });

    const { taskId } = await startedTask(service, "session-codex-a", "nosucc");

    // Different family, same worktree → still rejects
    await expect(service.checkpointTask({
      session_id: "session-claude",
      operation_id: "op-nosucc-1",
      task_id: taskId,
      expected_version: 1,
      checkpoint: {
        completed_items: [], current_state: "x", human_context: [],
        confirmed_decisions: [], pending_decisions: [], blockers: [],
        verification: [], next_action: "x"
      }
    })).rejects.toMatchObject({ code: "TASK_LEASE_CONFLICT" });

    await expect(service.checkpointTask({
      session_id: "session-codex-other-owner",
      operation_id: "op-nosucc-owner",
      task_id: taskId,
      expected_version: 1,
      checkpoint: {
        completed_items: [], current_state: "different owner", human_context: [],
        confirmed_decisions: [], pending_decisions: [], blockers: [],
        verification: [], next_action: "x"
      }
    })).rejects.toMatchObject({ code: "TASK_LEASE_CONFLICT" });

    await expect(service.checkpointTask({
      session_id: "session-codex-b",
      operation_id: "op-succ-b",
      task_id: taskId,
      expected_version: 1,
      checkpoint: {
        completed_items: [], current_state: "cross-worktree succession", human_context: [],
        confirmed_decisions: [], pending_decisions: [], blockers: [],
        verification: [], next_action: "x"
      }
    })).rejects.toMatchObject({ code: "TASK_LEASE_CONFLICT" });
    expect(store.transaction((tx) => tx.getTask(taskId)))
      .toMatchObject({ session_id: "session-codex-a" });
    expect(store.transaction((tx) => tx.listActiveScopesByWorktree(WORKTREE_A)))
      .toEqual([expect.objectContaining({ task_id: taskId })]);
  });

  it("rejects checkpoint and submit from a session that does not hold the lease", async () => {
    const { service } = createFixture();
    const { taskId, version } = await startedTask(service, "session-a", "lease-guard");

    await expect(service.checkpointTask({
      session_id: "session-b",
      operation_id: "op-b-1",
      task_id: taskId,
      expected_version: version,
      checkpoint: {
        completed_items: [],
        current_state: "intruder checkpoint",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification: [],
        next_action: "should be rejected"
      }
    })).rejects.toMatchObject({ code: "TASK_LEASE_CONFLICT" });

    await expect(service.submitTask({
      session_id: "session-b",
      operation_id: "op-b-2",
      task_id: taskId,
      expected_version: version,
      verification: [{ command: "npm test", outcome: "passed", summary: "green" }]
    })).rejects.toMatchObject({ code: "TASK_LEASE_CONFLICT" });
  });

  it("requires an active lease for checkpoint and submit after human release", async () => {
    const { service } = createFixture();
    const paused = await startedTask(service, "session-a", "lease-required-paused");
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "lease-required-pause",
      task_id: paused.taskId,
      expected_version: paused.version,
      checkpoint: checkpoint(),
      target_status: "paused"
    });
    await expect(service.checkpointTask({
      session_id: "session-b",
      operation_id: "lease-required-checkpoint-without-start",
      task_id: paused.taskId,
      expected_version: 2,
      checkpoint: checkpoint()
    })).rejects.toMatchObject({ code: "LEASE_NOT_FOUND" });

    const verifying = await startedTask(service, "session-a", "lease-required-verifying");
    const verification = [{ command: "npm test", outcome: "passed" as const, summary: "green" }];
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "lease-required-verification",
      task_id: verifying.taskId,
      expected_version: verifying.version,
      checkpoint: checkpoint({ verification }),
      target_status: "verifying"
    });
    await service.humanReleaseSession("session-a", humanActor);
    await expect(service.submitTask({
      session_id: "session-b",
      operation_id: "lease-required-submit-without-start",
      task_id: verifying.taskId,
      expected_version: 3,
      verification
    })).rejects.toMatchObject({ code: "LEASE_NOT_FOUND" });
  });

  it("checkpoints to waiting_human, releases the lease, and stores checkpoint plus snapshot", async () => {
    const { store, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});
    const payload = checkpoint({
      pending_decisions: ["Approve the cache strategy?"],
      next_action: "wait for the human decision"
    });

    await expect(service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint-1",
      task_id: taskId,
      expected_version: 1,
      checkpoint: payload,
      target_status: "waiting_human"
    })).resolves.toMatchObject({ status: "waiting_human", version: 2 });

    expect(store.transaction((tx) => tx.getLeaseByTask(taskId))).toBeUndefined();
    // One initial checkpoint from task_create plus the waiting_human checkpoint.
    expect(store.checkpoints).toHaveLength(2);
    expect(store.checkpoints.at(-1)).toMatchObject({
      task_id: taskId,
      session_id: "session-a",
      payload
    });
    expect(store.snapshots).toHaveLength(2);
    expect(store.snapshots.at(-1)).toMatchObject({
      task_id: taskId,
      checkpoint_id: store.checkpoints.at(-1)?.checkpoint_id,
      head_commit: "0123456789abcdef0123456789abcdef01234567"
    });
    expect(store.getTaskDetail(taskId)?.checkpoint?.pending_decisions)
      .toEqual(["Approve the cache strategy?"]);
    expect(store.events.at(-1)?.event_type).toBe("task_checkpointed");
  });

  it("keeps the lease when checkpointing without a target status change", async () => {
    const { store, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});
    const before = store.transaction((tx) => tx.getLeaseByTask(taskId))!;

    await expect(service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint-1",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint()
    })).resolves.toMatchObject({ status: "in_progress", version: 2 });

    const after = store.transaction((tx) => tx.getLeaseByTask(taskId))!;
    expect(after).toMatchObject({
      session_id: "session-a",
      acquired_at: before.acquired_at,
      generation: before.generation ?? 1
    });
    expect(Date.parse(after.heartbeat_at)).toBeGreaterThan(Date.parse(before.heartbeat_at));
    expect(Date.parse(after.expires_at)).toBeGreaterThan(Date.parse(before.expires_at));
  });

  it("merges task attempts append-only with server timestamps", async () => {
    const { store, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "attempts", {});
    const attempt = {
      attempt_id: "attempt-1",
      summary: "Tried the legacy parser",
      outcome: "failed" as const,
      evidence_refs: ["test:parser"]
    };
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "attempt-checkpoint-1",
      task_id: taskId,
      expected_version: 1,
      checkpoint: { ...checkpoint(), attempts: [attempt] } as CheckpointPayload
    });
    const recorded = store.getTaskDetail(taskId)?.checkpoint?.attempts?.[0];
    expect(recorded).toMatchObject(attempt);
    expect(recorded?.recorded_at).toMatch(/^2026-08-17T/);
    expect(store.events.filter((event) => event.event_type === "task_attempt_recorded"))
      .toHaveLength(1);

    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "attempt-checkpoint-2",
      task_id: taskId,
      expected_version: 2,
      checkpoint: { ...checkpoint(), attempts: [attempt] } as CheckpointPayload
    });
    expect(store.getTaskDetail(taskId)?.checkpoint?.attempts).toEqual([recorded]);
    expect(store.events.filter((event) => event.event_type === "task_attempt_recorded"))
      .toHaveLength(1);

    await expect(service.checkpointTask({
      session_id: "session-a",
      operation_id: "attempt-checkpoint-conflict",
      task_id: taskId,
      expected_version: 3,
      checkpoint: {
        ...checkpoint(),
        attempts: [{ ...attempt, summary: "Changed history" }]
      } as CheckpointPayload
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("keeps attempt ids immutable after older entries leave the 20-item recovery window", async () => {
    const { store, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "attempt-history", {});
    const firstTwenty = Array.from({ length: 20 }, (_, index) => ({
      attempt_id: `attempt-${String(index)}`,
      summary: `failed approach ${String(index)}`,
      outcome: "failed" as const,
      evidence_refs: [`test:${String(index)}`]
    }));
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "attempt-history-first-20",
      task_id: taskId,
      expected_version: 1,
      checkpoint: { ...checkpoint(), attempts: firstTwenty } as CheckpointPayload
    });
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "attempt-history-21",
      task_id: taskId,
      expected_version: 2,
      checkpoint: {
        ...checkpoint(),
        attempts: [{
          attempt_id: "attempt-20",
          summary: "failed approach 20",
          outcome: "failed",
          evidence_refs: ["test:20"]
        }]
      } as CheckpointPayload
    });
    expect(store.getTaskDetail(taskId)?.checkpoint?.attempts).toHaveLength(20);
    expect(store.getTaskDetail(taskId)?.checkpoint?.attempts?.[0]?.attempt_id)
      .toBe("attempt-1");

    await expect(service.checkpointTask({
      session_id: "session-a",
      operation_id: "attempt-history-rewrite-evicted",
      task_id: taskId,
      expected_version: 3,
      checkpoint: {
        ...checkpoint(),
        attempts: [{
          attempt_id: "attempt-0",
          summary: "rewritten after eviction",
          outcome: "failed",
          evidence_refs: ["test:changed"]
        }]
      } as CheckpointPayload
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(store.events.filter((event) => (
      event.event_type === "task_attempt_recorded"
      && typeof event.payload === "object"
      && event.payload !== null
      && !Array.isArray(event.payload)
      && event.payload.attempt_id === "attempt-0"
    ))).toHaveLength(1);
  });

  it("keeps imported attempt ids immutable after adoption history leaves the recovery window", async () => {
    const { service } = createFixture();
    const importedAttempts = Array.from({ length: 20 }, (_, index) => ({
      attempt_id: `imported-attempt-${String(index)}`,
      summary: `imported failed approach ${String(index)}`,
      outcome: "failed" as const,
      evidence_refs: [`legacy:${String(index)}`],
      recorded_at: isoAt(index)
    }));
    const adopted = await service.adoptTask({
      session_id: "session-a",
      operation_id: "adopt-attempt-history",
      expected_version: 0,
      owner: "jande",
      legacy_import_key: "legacy-attempt-history",
      source_session_label: "Legacy attempt session",
      project_id: "project-1",
      repository_id: "repo-1",
      worktree_path: WORKTREE_A,
      normalized_title: "legacy attempt history",
      goal: "preserve imported attempt history",
      acceptance_criteria: ["attempt ids remain immutable"],
      priority: "P1",
      status: "in_progress",
      checkpoint: checkpoint({
        attempts: importedAttempts,
        source: {
          source_type: "legacy_adoption",
          source_session_label: "Legacy attempt session",
          adoption_method: "mcp",
          adopted_at: isoAt(0)
        }
      }),
      snapshot: {
        head_commit: "0123456789abcdef0123456789abcdef01234567"
      }
    });
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "adopt-attempt-history-append",
      task_id: adopted.task_id,
      expected_version: 0,
      checkpoint: {
        ...checkpoint(),
        attempts: [{
          attempt_id: "imported-attempt-20",
          summary: "new failed approach",
          outcome: "failed",
          evidence_refs: ["legacy:20"]
        }]
      } as CheckpointPayload
    });
    await expect(service.checkpointTask({
      session_id: "session-a",
      operation_id: "adopt-attempt-history-rewrite",
      task_id: adopted.task_id,
      expected_version: 1,
      checkpoint: {
        ...checkpoint(),
        attempts: [{
          attempt_id: "imported-attempt-0",
          summary: "rewritten imported history",
          outcome: "failed",
          evidence_refs: ["legacy:changed"]
        }]
      } as CheckpointPayload
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects submission when checkpoint evidence no longer matches code content", async () => {
    const { probe, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "stale-evidence", {});
    const verification = [{ command: "npm test", outcome: "passed" as const, summary: "green" }];
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "stale-evidence-checkpoint",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint({ verification })
    });
    probe.drafts.set(WORKTREE_A, {
      ...draftFor(WORKTREE_A),
      content_digest: `sha256:${"b".repeat(64)}`
    });

    await expect(service.submitTask({
      session_id: "session-a",
      operation_id: "stale-evidence-submit",
      task_id: taskId,
      expected_version: 2,
      verification
    })).rejects.toMatchObject({
      code: "CHECKPOINT_REQUIRED",
      evidence: expect.arrayContaining([
        expect.stringContaining(`sha256:${"a".repeat(64)}`),
        expect.stringContaining(`sha256:${"b".repeat(64)}`)
      ])
    });
  });

  it("refuses to substitute the registered server checkout for a remote client worktree", async () => {
    const { probe, service, store } = createFixture();
    const remoteFailure = Object.assign(new Error("client worktree is remote"), {
      code: "REPOSITORY_NOT_ALLOWED"
    });
    probe.drafts.set("/repos/project-one", draftFor("/repos/project-one"));
    probe.drafts.set(WORKTREE_A, draftFor(WORKTREE_A));
    const { taskId } = await startedTask(service, "session-a", "remote-checkout", {});
    probe.failures.set(WORKTREE_A, remoteFailure);
    const snapshotsBefore = store.snapshots.filter((s) => s.task_id === taskId).length;
    const verification = [{ command: "npm test", outcome: "passed" as const, summary: "green" }];

    await expect(service.checkpointTask({
      session_id: "session-a",
      operation_id: "remote-checkout-checkpoint",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint({ verification })
    })).rejects.toMatchObject({ code: "REMOTE_WORKTREE_EVIDENCE_REQUIRED" });
    const fingerprints = (store.getTaskDetail(taskId)?.checkpoint?.verification ?? [])
      .flatMap((entry) => entry.code_fingerprint === undefined ? [] : [entry.code_fingerprint]);
    expect(fingerprints).toEqual([]);
    expect(store.snapshots.filter((s) => s.task_id === taskId).length)
      .toBe(snapshotsBefore);
  });

  it("fails closed on submit when the session worktree becomes unreachable after checkpoint", async () => {
    const { probe, service } = createFixture();
    probe.drafts.set(WORKTREE_A, draftFor(WORKTREE_A));
    const { taskId } = await startedTask(service, "session-a", "remote-checkout-stale", {});
    const verification = [{ command: "npm test", outcome: "passed" as const, summary: "green" }];
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "remote-checkout-stale-checkpoint",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint({ verification })
    });
    probe.failures.set(WORKTREE_A, Object.assign(new Error("client worktree went remote"), {
      code: "REPOSITORY_NOT_ALLOWED"
    }));

    await expect(service.submitTask({
      session_id: "session-a",
      operation_id: "remote-checkout-stale-submit",
      task_id: taskId,
      expected_version: 2,
      verification
    })).rejects.toMatchObject({ code: "REMOTE_WORKTREE_EVIDENCE_REQUIRED" });
  });

  it("assembles a compact recovery view and detects stale evidence", async () => {
    const { probe, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "recovery", {});
    const verification = [{ command: "npm test", outcome: "passed" as const, summary: "green" }];
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "recovery-checkpoint",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint({ verification })
    });

    await expect(service.getTaskRecovery({
      session_id: "session-a",
      task_id: taskId
    })).resolves.toMatchObject({
      task: { task_id: taskId, version: 2 },
      checkpoint: { verification: [expect.objectContaining({ command: "npm test" })] },
      active_lease: { task_id: taskId, session_id: "session-a" },
      lease_session: { session_id: "session-a", worktree_path: WORKTREE_A },
      latest_snapshot: { task_id: taskId, content_digest: `sha256:${"a".repeat(64)}` },
      evidence_state: "fresh",
      pending_decisions: [],
      dependency_validation_gate: { ready_for_acceptance: true },
      active_repair: null,
      next_action: "continue implementation"
    });

    probe.drafts.set(WORKTREE_A, {
      ...draftFor(WORKTREE_A),
      content_digest: `sha256:${"b".repeat(64)}`
    });
    await expect(service.getTaskRecovery({
      session_id: "session-a",
      task_id: taskId
    })).resolves.toMatchObject({
      evidence_state: "stale",
      next_action: expect.stringContaining("verification")
    });
  });

  it("blocks resuming until the Agent records the user's exact confirmed decision", async () => {
    const { store, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint-1",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint({
        pending_decisions: ["Approve the cache strategy?"]
      }),
      target_status: "waiting_human"
    });

    await expect(service.startTask({
      session_id: "session-a",
      operation_id: "op-start-2",
      task_id: taskId,
      expected_version: 2
    })).rejects.toMatchObject({
      code: "HUMAN_CONFIRMATION_REQUIRED",
      evidence: ["Approve the cache strategy?"]
    });

    const confirmation = {
      session_id: "session-a",
      operation_id: "op-confirm-1",
      task_id: taskId,
      expected_version: 2,
      question: "Approve the cache strategy?",
      decision: "use the LRU cache"
    } as const;
    await expect(service.confirmTaskDecision(confirmation))
      .resolves.toMatchObject({ status: "waiting_human", version: 3 });
    await expect(service.confirmTaskDecision(confirmation))
      .resolves.toMatchObject({ status: "waiting_human", version: 3 });

    expect(store.decisions).toHaveLength(1);
    expect(store.decisions[0]).toMatchObject({
      task_id: taskId,
      question: "Approve the cache strategy?",
      decision: "use the LRU cache",
      status: "decided",
      decided_at: expect.any(String)
    });
    const detail = store.getTaskDetail(taskId);
    expect(detail?.checkpoint?.pending_decisions).toEqual([]);
    expect(detail?.checkpoint?.confirmed_decisions)
      .toEqual(["Approve the cache strategy? => use the LRU cache"]);
    expect(store.events.at(-1)).toMatchObject({
      event_type: "task_decision_confirmed",
      session_id: "session-a",
      payload: {
        actor: "agent",
        confirmation_source: "current_user_message",
        owner: "jande"
      }
    });

    await expect(service.startTask({
      session_id: "session-a",
      operation_id: "op-start-3",
      task_id: taskId,
      expected_version: 3
    })).resolves.toMatchObject({ status: "in_progress", version: 4 });
  });

  it("blocks checkpointing a waiting_human task without reacquiring its lease", async () => {
    const { store, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint-1",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint({
        pending_decisions: ["Approve the cache strategy?"]
      }),
      target_status: "waiting_human"
    });

    await expect(service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint-2",
      task_id: taskId,
      expected_version: 2,
      checkpoint: checkpoint({
        verification: [{ command: "npm test", outcome: "passed", summary: "all green" }]
      }),
      target_status: "in_progress"
    })).rejects.toMatchObject({ code: "LEASE_NOT_FOUND" });
    expect(store.getTaskDetail(taskId)).toMatchObject({
      status: "waiting_human",
      version: 2
    });
    expect(store.checkpoints).toHaveLength(2);
  });

  it("requires task_start after waiting_human decisions conclude", async () => {
    const { service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint-1",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint({
        pending_decisions: ["Approve the cache strategy?"]
      }),
      target_status: "waiting_human"
    });
    await service.confirmTaskDecision({
      session_id: "session-a",
      operation_id: "op-confirm-1",
      task_id: taskId,
      expected_version: 2,
      question: "Approve the cache strategy?",
      decision: "use the LRU cache"
    });

    await expect(service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint-2",
      task_id: taskId,
      expected_version: 3,
      checkpoint: checkpoint(),
      target_status: "in_progress"
    })).rejects.toMatchObject({ code: "LEASE_NOT_FOUND" });
    await expect(service.startTask({
      session_id: "session-a",
      operation_id: "op-start-after-decision",
      task_id: taskId,
      expected_version: 3
    })).resolves.toMatchObject({ status: "in_progress", version: 4 });
  });

  it("rejects decision confirmation from another owner or outside waiting_human", async () => {
    const { store, service, sessionB } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});

    await expect(service.confirmTaskDecision({
      session_id: "session-a",
      operation_id: "op-confirm-too-early",
      task_id: taskId,
      expected_version: 1,
      question: "Approve the cache strategy?",
      decision: "use the LRU cache"
    })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint-owner",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint({
        pending_decisions: ["Approve the cache strategy?"]
      }),
      target_status: "waiting_human"
    });

    await expect(service.confirmTaskDecision({
      session_id: "session-a",
      operation_id: "op-confirm-wrong-question",
      task_id: taskId,
      expected_version: 2,
      question: "Use PostgreSQL?",
      decision: "yes"
    })).rejects.toMatchObject({ code: "DECISION_NOT_PENDING" });
    await expect(service.confirmTaskDecision({
      session_id: "session-a",
      operation_id: "op-confirm-stale-version",
      task_id: taskId,
      expected_version: 1,
      question: "Approve the cache strategy?",
      decision: "use the LRU cache"
    })).rejects.toMatchObject({ code: "TASK_VERSION_CONFLICT" });

    registerSecondRepository(store);
    const sessionC = store.sessions.get("session-c");
    if (sessionC === undefined) {
      throw new Error("second-repository session missing");
    }
    store.sessions.set("session-c", { ...sessionC, owner: "jande" });
    await expect(service.confirmTaskDecision({
      session_id: "session-c",
      operation_id: "op-confirm-other-repo",
      task_id: taskId,
      expected_version: 2,
      question: "Approve the cache strategy?",
      decision: "use the LRU cache"
    })).rejects.toMatchObject({ code: "REPOSITORY_NOT_ALLOWED" });

    store.sessions.set("session-b", { ...sessionB, owner: "other-owner" });

    await expect(service.confirmTaskDecision({
      session_id: "session-b",
      operation_id: "op-confirm-other-owner",
      task_id: taskId,
      expected_version: 2,
      question: "Approve the cache strategy?",
      decision: "use the LRU cache"
    })).rejects.toMatchObject({
      code: "OWNER_MISMATCH",
      evidence: ["other-owner", "jande"]
    });
    expect(store.decisions).toHaveLength(0);
  });

  it("blocks switching to a waiting_human target whose decisions are unresolved", async () => {
    const { store, service } = createFixture();
    const { taskId: currentId } = await startedTask(service, "session-a", "1", {});
    const targetId = await createTask(service, {
      session_id: "session-b",
      operation_id: "op-create-2"
    });
    const targetStarted = await service.startTask({
      session_id: "session-b",
      operation_id: "op-start-2",
      task_id: targetId,
      expected_version: 0
    });
    await service.checkpointTask({
      session_id: "session-b",
      operation_id: "op-checkpoint-2",
      task_id: targetId,
      expected_version: targetStarted.version,
      checkpoint: checkpoint({
        pending_decisions: ["Pick the rollout plan?"]
      }),
      target_status: "waiting_human"
    });

    await expect(service.switchTask({
      session_id: "session-a",
      operation_id: "op-switch-1",
      task_id: currentId,
      expected_version: 1,
      checkpoint: checkpoint(),
      target_task_id: targetId,
      target_expected_version: 2
    })).rejects.toMatchObject({
      code: "HUMAN_CONFIRMATION_REQUIRED",
      evidence: ["Pick the rollout plan?"]
    });

    expect(store.getTaskDetail(currentId)).toMatchObject({
      status: "in_progress",
      version: 1
    });
    expect(store.transaction((tx) => tx.getLeaseByTask(currentId))).toMatchObject({
      session_id: "session-a"
    });
    expect(store.getTaskDetail(targetId)).toMatchObject({
      status: "waiting_human",
      version: 2
    });
  });

  it("releases a verifying task lease into paused", async () => {
    const { store, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint-1",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint(),
      target_status: "verifying"
    });

    await expect(service.humanReleaseSession("session-a", humanActor))
      .resolves.toMatchObject({ task_id: taskId, status: "paused", version: 3 });

    expect(store.transaction((tx) => tx.getLeaseBySession("session-a"))).toBeUndefined();
    expect(store.getTaskDetail(taskId)).toMatchObject({ status: "paused", version: 3 });
    expect(store.events.at(-1)).toMatchObject({
      event_type: "task_released",
      payload: { actor: "human" }
    });
  });

  it("records human accept, reject, and cancel decisions with human events", async () => {
    const { store, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint-1",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint({
        verification: [{ command: "npm test", outcome: "passed", summary: "green" }]
      }),
      target_status: "verifying"
    });
    await service.submitTask({
      session_id: "session-a",
      operation_id: "op-submit-1",
      task_id: taskId,
      expected_version: 2,
      verification: [{ command: "npm test", outcome: "passed", summary: "green" }]
    });

    await expect(service.humanAccept(taskId, agentActor)).rejects.toMatchObject({
      code: "HUMAN_CONFIRMATION_REQUIRED"
    });

    await expect(service.humanAccept(taskId, humanActor)).resolves.toMatchObject({
      status: "done",
      version: 4
    });
    expect(store.getTaskDetail(taskId)).toMatchObject({ status: "done", version: 4 });
    const acceptDecision = store.decisions.find((decision) => (
      decision.decision === "accepted"
    ));
    expect(acceptDecision).toMatchObject({
      task_id: taskId,
      status: "decided",
      decided_at: expect.any(String)
    });
    expect(store.events.at(-1)).toMatchObject({
      event_type: "task_accepted",
      payload: { actor: "human" }
    });
  });

  it("rejects a human accept from a state that cannot reach done", async () => {
    const { service } = createFixture();
    const taskId = await createTask(service, { operation_id: "op-create-1" });

    await expect(service.humanAccept(taskId, humanActor)).rejects.toMatchObject({
      code: "INVALID_TRANSITION"
    });
  });

  it("requires every open dependent to validate before final acceptance", async () => {
    const { store, service } = createFixture();
    const { taskId: upstreamId } = await startedTask(service, "session-a", "1", {});
    const openDependentId = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-create-open",
      title: "Frontend integration"
    });
    const { taskId: closedDependentId } = await startedTask(service, "session-b", "2", {});
    await service.humanCancel(closedDependentId, humanActor);

    const linkedAt = isoAt(0);
    store.insertTaskDependency({
      task_id: openDependentId,
      depends_on_task_id: upstreamId,
      created_at: linkedAt
    });
    store.insertTaskDependency({
      task_id: closedDependentId,
      depends_on_task_id: upstreamId,
      created_at: linkedAt
    });

    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint-1",
      task_id: upstreamId,
      expected_version: 1,
      checkpoint: checkpoint({
        verification: [{ command: "npm test", outcome: "passed", summary: "green" }]
      }),
      target_status: "verifying"
    });
    await service.submitTask({
      session_id: "session-a",
      operation_id: "op-submit-1",
      task_id: upstreamId,
      expected_version: 2,
      verification: [{ command: "npm test", outcome: "passed", summary: "green" }]
    });

    expect(store.dependencyValidations).toHaveLength(1);
    expect(store.dependencyValidations[0]).toMatchObject({
      upstream_task_id: upstreamId,
      downstream_task_id: openDependentId,
      cycle: 1,
      status: "pending",
      requested_by_actor: "agent"
    });
    await expect(service.humanAccept(upstreamId, humanActor)).rejects.toMatchObject({
      code: "DEPENDENCY_VALIDATION_REQUIRED"
    });
    await expect(service.humanRespondDependencyValidation(
      store.dependencyValidations[0]!.validation_id,
      humanActor,
      store.tasks.get(openDependentId)!.owner!,
      "passed"
    )).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const received = await service.receiveDependencyValidation({
      session_id: "session-a",
      operation_id: "op-agent-receive-gate",
      validation_id: store.dependencyValidations[0]!.validation_id,
      owner: store.tasks.get(openDependentId)!.owner!
    });
    await service.completeDependencyValidation({
      session_id: "session-a",
      operation_id: "op-agent-complete-gate",
      validation_id: store.dependencyValidations[0]!.validation_id,
      run_id: received.run_id,
      owner: store.tasks.get(openDependentId)!.owner!,
      status: "passed",
      verification: [{
        command: "npm test",
        outcome: "passed",
        summary: "green",
        revision: "0123456789abcdef0123456789abcdef01234567",
        target_revision: "0123456789abcdef0123456789abcdef01234567",
        worktree_path: WORKTREE_A
      }]
    });
    await expect(service.humanAccept(upstreamId, humanActor)).resolves.toMatchObject({
      status: "done"
    });

    expect(store.notifications).toHaveLength(0);
  });

  it("lets only the downstream owner receive a pending validation once", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const { service, store } = fixture;

    await expect(service.receiveDependencyValidation({
      session_id: "session-wrong-owner",
      operation_id: "op-receive-wrong",
      validation_id: validation.validation_id,
      owner: "owner-other"
    })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });

    const first = await service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-receive-1",
      validation_id: validation.validation_id,
      owner: "owner-downstream"
    });
    const retry = await service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-receive-2",
      validation_id: validation.validation_id,
      owner: "owner-downstream"
    });
    expect(retry.run_id).toBe(first.run_id);
    expect(store.dependencyValidationRuns).toHaveLength(1);
    expect(store.dependencyValidations[0]!.request_read_at).not.toBeNull();
  });

  it("checks the bound session owner before replaying validation operations", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const received = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-owner-replay-receive",
      validation_id: validation.validation_id,
      owner: "owner-downstream"
    });
    await expect(fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-owner-replay-receive",
      validation_id: validation.validation_id,
      owner: "owner-other"
    })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });

    await fixture.service.checkpointDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-owner-replay-checkpoint",
      validation_id: validation.validation_id,
      run_id: received.run_id,
      owner: "owner-downstream",
      progress: { phase: "running" }
    });
    await expect(fixture.service.checkpointDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-owner-replay-checkpoint",
      validation_id: validation.validation_id,
      run_id: received.run_id,
      owner: "owner-other",
      progress: { phase: "running" }
    })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });

    const completionInput = {
      session_id: "session-downstream",
      operation_id: "op-owner-replay-complete",
      validation_id: validation.validation_id,
      run_id: received.run_id,
      owner: "owner-downstream" as const,
      status: "passed" as const,
      verification: [{ command: "npm test", outcome: "passed" as const, summary: "green" }]
    };
    await fixture.service.completeDependencyValidation(completionInput);
    await expect(fixture.service.completeDependencyValidation({
      ...completionInput,
      owner: "owner-other"
    })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });

  it("rejects checkpoint writes when the run owner or session does not match", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const received = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream", operation_id: "op-receive-guard-owner",
      validation_id: validation.validation_id, owner: "owner-downstream"
    });

    await expect(fixture.service.checkpointDependencyValidation({
      session_id: "session-downstream", operation_id: "op-checkpoint-wrong-owner",
      validation_id: validation.validation_id, run_id: received.run_id,
      owner: "owner-other", progress: { phase: "running" }
    })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });

    fixture.store.dependencyValidationRuns[0]!.session_id = "session-a";
    await expect(fixture.service.checkpointDependencyValidation({
      session_id: "session-downstream", operation_id: "op-checkpoint-wrong-session",
      validation_id: validation.validation_id, run_id: received.run_id,
      owner: "owner-downstream", progress: { phase: "running" }
    })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });

  it("rejects checkpoint writes for repository, worktree, terminal, stale-cycle, expired, and invalid runs", async () => {
    const checkpointWith = async (
      mutate: (fixture: Fixture, validation: DependencyValidationRecord, runId: string) => void,
      expectedCode: string,
      operationId: string
    ) => {
      const { fixture, validation } = await seedPendingValidation();
      const received = await fixture.service.receiveDependencyValidation({
        session_id: "session-downstream", operation_id: `${operationId}-receive`,
        validation_id: validation.validation_id, owner: "owner-downstream"
      });
      mutate(fixture, validation, received.run_id);
      await expect(fixture.service.checkpointDependencyValidation({
        session_id: "session-downstream", operation_id: operationId,
        validation_id: validation.validation_id, run_id: received.run_id,
        owner: "owner-downstream", progress: { phase: "running" }
      })).rejects.toMatchObject({ code: expectedCode });
    };

    await checkpointWith((fixture) => {
      fixture.store.sessions.get("session-downstream")!.repository_id = "repo-2";
    }, "REPOSITORY_NOT_ALLOWED", "op-checkpoint-repository");
    await checkpointWith((fixture) => {
      fixture.store.sessions.get("session-downstream")!.worktree_path = WORKTREE_C;
    }, "SESSION_CONTEXT_CONFLICT", "op-checkpoint-worktree");
    await checkpointWith((fixture, validation) => {
      fixture.store.tasks.get(validation.downstream_task_id)!.status = "done";
    }, "DEPENDENCY_VALIDATION_ALREADY_RESPONDED", "op-checkpoint-terminal");
    await checkpointWith((fixture, validation) => {
      fixture.store.transaction((tx) => {
        tx.supersedePendingDependencyValidations(validation.upstream_task_id, isoAt(2));
        tx.insertDependencyValidation(validationAtCycle(
          { ...validation, validation_id: `${validation.validation_id}-new`, requested_at: isoAt(2) },
          validation.cycle + 1
        ));
      });
    }, "TASK_VERSION_CONFLICT", "op-checkpoint-stale-cycle");
    await checkpointWith((fixture, _validation, runId) => {
      fixture.store.dependencyValidationRuns.find((run) => run.run_id === runId)!.expires_at = isoAt(-1);
    }, "TASK_LEASE_CONFLICT", "op-checkpoint-expired");
    await checkpointWith((fixture, _validation, runId) => {
      fixture.store.dependencyValidationRuns.find((run) => run.run_id === runId)!.status = "passed";
    }, "INVALID_TRANSITION", "op-checkpoint-invalid-status");
  });

  it("lists pending requests for the bound downstream owner and repository", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const listed = await fixture.service.listDependencyValidationRequests({
      session_id: "session-downstream",
      owner: "owner-downstream"
    });
    expect(listed.map((item) => item.validation_id)).toEqual([validation.validation_id]);
    expect(listed[0]?.validation_spec).toMatchObject({
      upstream_task_id: validation.upstream_task_id,
      upstream_task_version: fixture.store.getTaskVersion(validation.upstream_task_id),
      target_revision: "0123456789abcdef0123456789abcdef01234567",
      command: "npm test",
      timeout_strategy: { kind: "rolling_lease", max_attempts: 2 }
    });
  });

  it("does not publish orphaned or terminal-downstream validation requests", async () => {
    const terminal = await seedPendingValidation();
    terminal.fixture.store.tasks.get(terminal.validation.downstream_task_id)!.status = "done";
    await expect(terminal.fixture.service.listDependencyValidationRequests({
      session_id: "session-downstream",
      owner: "owner-downstream"
    })).resolves.toEqual([]);

    const orphan = await seedPendingValidation();
    const edgeIndex = orphan.fixture.store.dependencies.findIndex((dependency) => (
      dependency.task_id === orphan.validation.downstream_task_id
        && dependency.depends_on_task_id === orphan.validation.upstream_task_id
    ));
    orphan.fixture.store.dependencies.splice(edgeIndex, 1);
    await expect(orphan.fixture.service.listDependencyValidationRequests({
      session_id: "session-downstream",
      owner: "owner-downstream"
    })).resolves.toEqual([]);
    await expect(orphan.fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-orphan-receive",
      validation_id: orphan.validation.validation_id,
      owner: "owner-downstream"
    })).rejects.toMatchObject({ code: "DEPENDENCY_VALIDATION_NOT_FOUND" });
  });

  it("preserves prior validation responses when a downstream edge changes", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const received = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-edge-change-receive",
      validation_id: validation.validation_id,
      owner: "owner-downstream"
    });
    await fixture.service.completeDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-edge-change-complete",
      validation_id: validation.validation_id,
      run_id: received.run_id,
      owner: "owner-downstream",
      status: "passed",
      verification: [{ command: "npm test", outcome: "passed", summary: "green" }],
      reason: "validated against committed target"
    });
    const downstream = fixture.store.tasks.get(validation.downstream_task_id)!;
    await fixture.service.updateTaskDependencies({
      session_id: "session-downstream",
      operation_id: "op-edge-remove",
      task_id: downstream.task_id,
      expected_version: fixture.store.getTaskVersion(downstream.task_id) ?? 0,
      dependencies: []
    });
    // Terminal responses are immutable history.  The removed edge makes the
    // response ineligible for the gate, but does not rewrite the audit row.
    expect(fixture.store.dependencyValidations[0]!.status).toBe("passed");
    expect(fixture.store.dependencyValidations[0]).toMatchObject({
      response_reason: "validated against committed target",
      responded_by_owner: "owner-downstream"
    });

    // A metadata update between remove and re-add must not lower the
    // persisted task timestamp when the service clock rolls backwards.
    clockTick = 0;
    await fixture.service.humanUpdateTask(
      downstream.task_id,
      humanActor,
      { priority: "P0" }
    );

    await fixture.service.updateTaskDependencies({
      session_id: "session-downstream",
      operation_id: "op-edge-readd",
      task_id: downstream.task_id,
      expected_version: fixture.store.getTaskVersion(downstream.task_id) ?? 0,
      dependencies: [validation.upstream_task_id]
    });
    expect(fixture.store.getDependencyValidationGate(validation.upstream_task_id))
      .toMatchObject({ ready_for_acceptance: false });
    await expect(fixture.service.humanAccept(validation.upstream_task_id, humanActor))
      .rejects.toMatchObject({ code: "DEPENDENCY_VALIDATION_REQUIRED" });
  });

  it("keeps dependency edge generations monotonic across clock rollback and re-add", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const downstream = fixture.store.tasks.get(validation.downstream_task_id)!;
    const originalEdge = fixture.store.dependencies.find((dependency) => (
      dependency.task_id === downstream.task_id
        && dependency.depends_on_task_id === validation.upstream_task_id
    ))!;

    // Remove and re-add the edge while the service clock moves backwards.
    // The persisted task timestamp must still advance so the old passed (or
    // seeded) validation can never become current again by timestamp tie.
    clockTick = 0;
    await fixture.service.updateTaskDependencies({
      session_id: "session-downstream",
      operation_id: "op-edge-generation-remove",
      task_id: downstream.task_id,
      expected_version: fixture.store.getTaskVersion(downstream.task_id) ?? 0,
      dependencies: []
    });
    // A no-op dependency write must not move the persisted generation marker
    // backwards when the wall clock has rolled back.
    clockTick = 0;
    await fixture.service.updateTaskDependencies({
      session_id: "session-downstream",
      operation_id: "op-edge-generation-noop",
      task_id: downstream.task_id,
      expected_version: 1,
      dependencies: []
    });
    clockTick = 0;
    await fixture.service.updateTaskDependencies({
      session_id: "session-downstream",
      operation_id: "op-edge-generation-readd",
      task_id: downstream.task_id,
      expected_version: 2,
      dependencies: [validation.upstream_task_id]
    });

    const readdedEdge = fixture.store.dependencies.find((dependency) => (
      dependency.task_id === downstream.task_id
        && dependency.depends_on_task_id === validation.upstream_task_id
    ))!;
    expect(Date.parse(readdedEdge.created_at)).toBeGreaterThan(Date.parse(originalEdge.created_at));
    expect(fixture.store.getDependencyValidationGate(validation.upstream_task_id))
      .toMatchObject({ ready_for_acceptance: false });
  });

  it("lets the same owner reclaim an expired run from a fresh session", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const first = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-expiry-first",
      validation_id: validation.validation_id,
      owner: "owner-downstream"
    });
    fixture.store.dependencyValidationRuns[0]!.expires_at = isoAt(-1);
    fixture.store.transaction((tx) => {
      tx.insertSession({
        session_id: "session-downstream-new",
        repository_id: "repo-1",
        label: "Downstream rotated",
        owner: "owner-downstream",
        started_at: isoAt(0),
        worktree_path: WORKTREE_B,
        last_activity_at: isoAt(0)
      });
    });
    const reclaimed = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream-new",
      operation_id: "op-expiry-reclaim",
      validation_id: validation.validation_id,
      owner: "owner-downstream"
    });
    expect(reclaimed).toMatchObject({ status: "claimed", attempt: 2 });
    expect(fixture.store.dependencyValidationRuns.find((run) => run.run_id === first.run_id))
      .toMatchObject({ status: "error", error_reason: "lease expired" });
  });

  it("supersedes incoming validation runs when a downstream task is accepted", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const downstream = fixture.store.tasks.get(validation.downstream_task_id)!;
    // Seed a legacy inconsistent state: the request is already passed, but an
    // active run remains. A terminal human accept must still clean it up.
    fixture.store.dependencyValidations[0] = {
      ...fixture.store.dependencyValidations[0]!,
      status: "passed",
      responded_by_owner: "owner-downstream",
      response_reason: "legacy pass",
      responded_at: isoAt(1)
    };
    fixture.store.tasks.set(downstream.task_id, {
      ...downstream,
      status: "pending_acceptance",
      updated_at: isoAt(1)
    });
    fixture.store.versions.set(downstream.task_id, 1);
    fixture.store.insertDependencyValidationRun({
      run_id: "legacy-active-run",
      validation_id: validation.validation_id,
      attempt: 2,
      status: "running",
      owner: "owner-downstream",
      session_id: "session-downstream",
      worktree_path: WORKTREE_B,
      heartbeat_at: isoAt(1),
      expires_at: isoAt(60),
      started_at: isoAt(1),
      completed_at: null,
      verification: [],
      progress: { phase: "legacy" },
      failure_reason: null,
      error_reason: null,
      operation_id: "legacy-active-op",
      created_at: isoAt(1),
      updated_at: isoAt(1)
    });

    await expect(fixture.service.humanAccept(downstream.task_id, humanActor))
      .resolves.toMatchObject({ status: "done" });
    expect(fixture.store.dependencyValidations[0]).toMatchObject({
      status: "passed",
      response_reason: "legacy pass"
    });
    expect(fixture.store.dependencyValidationRuns.find((run) => run.run_id === "legacy-active-run"))
      .toMatchObject({ status: "cancelled" });
  });

  it("atomically claims a queued run before returning it", async () => {
    const { fixture, validation } = await seedPendingValidation();
    fixture.store.transaction((tx) => {
      tx.insertDependencyValidationRun({
        run_id: "queued-run",
        validation_id: validation.validation_id,
        attempt: 1,
        status: "queued",
        owner: "owner-downstream",
        session_id: "session-downstream",
        worktree_path: WORKTREE_B,
        heartbeat_at: isoAt(0),
        expires_at: isoAt(1_800),
        started_at: null,
        completed_at: null,
        verification: [],
        progress: {},
        failure_reason: null,
        error_reason: null,
        operation_id: "queued-op",
        created_at: isoAt(0),
        updated_at: isoAt(0)
      });
    });
    const received = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-queued-receive",
      validation_id: validation.validation_id,
      owner: "owner-downstream"
    });
    expect(received).toMatchObject({ status: "claimed", run_id: "queued-run", attempt: 1 });
    await expect(fixture.service.checkpointDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-queued-checkpoint",
      validation_id: validation.validation_id,
      run_id: "queued-run",
      owner: "owner-downstream",
      progress: { phase: "running" }
    })).resolves.toMatchObject({ status: "claimed" });
  });

  it("cancels active validation runs when a downstream task is cancelled", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const received = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-cancel-receive",
      validation_id: validation.validation_id,
      owner: "owner-downstream"
    });
    // Make cancellation legal without exercising the separate active-upstream
    // guard; this test focuses on validation-run cleanup.
    fixture.store.tasks.get(validation.upstream_task_id)!.status = "done";
    const downstream = fixture.store.tasks.get(validation.downstream_task_id)!;
    await fixture.service.humanCancel(downstream.task_id, "human");
    expect(fixture.store.dependencyValidations[0]!.status).toBe("superseded");
    expect(fixture.store.dependencyValidationRuns.find((run) => run.run_id === received.run_id))
      .toMatchObject({ status: "cancelled" });
    await expect(fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-cancel-retry",
      validation_id: validation.validation_id,
      owner: "owner-downstream"
    })).rejects.toMatchObject({ code: "DEPENDENCY_VALIDATION_ALREADY_RESPONDED" });
  });

  it("rolls the validation lease on checkpoint", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const { service, store } = fixture;
    const received = await service.receiveDependencyValidation({
      session_id: "session-downstream", operation_id: "op-receive-heartbeat",
      validation_id: validation.validation_id, owner: "owner-downstream"
    });
    const before = store.dependencyValidationRuns.find((run) => run.run_id === received.run_id)!;
    await service.checkpointDependencyValidation({
      session_id: "session-downstream", operation_id: "op-validation-heartbeat",
      validation_id: validation.validation_id, run_id: received.run_id,
      owner: "owner-downstream", progress: { phase: "running" }
    });
    const after = store.dependencyValidationRuns.find((run) => run.run_id === received.run_id)!;
    expect(after.heartbeat_at).not.toBe(before.heartbeat_at);
    expect(Date.parse(after.expires_at)).toBeGreaterThan(Date.parse(before.expires_at));
  });

  it("maps passed, rejected, and error terminal results", async () => {
    const runCase = async (status: "passed" | "rejected" | "error", reason?: string) => {
      const { fixture, validation } = await seedPendingValidation();
      const received = await fixture.service.receiveDependencyValidation({
        session_id: "session-downstream", operation_id: `op-receive-${status}`,
        validation_id: validation.validation_id, owner: "owner-downstream"
      });
      return fixture.service.completeDependencyValidation({
        session_id: "session-downstream", operation_id: `op-complete-${status}`,
        validation_id: validation.validation_id, run_id: received.run_id,
        owner: "owner-downstream", status,
        ...(reason === undefined ? {} : { reason }),
        verification: status === "error" ? [] : [{ command: "npm test", outcome: status === "passed" ? "passed" : "failed", summary: status }]
      });
    };
    expect((await runCase("passed")).validation.status).toBe("passed");
    expect((await runCase("rejected", "contract mismatch")).validation.status).toBe("rejected");
    expect((await runCase("error", "runner timeout")).validation.status).toBe("pending");
  });

  it("creates exactly one upstream repair request for rejected validation and none for error", async () => {
    const rejectedSeed = await seedPendingValidation();
    const rejectedRun = await rejectedSeed.fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "repair-receive-rejected",
      validation_id: rejectedSeed.validation.validation_id,
      owner: "owner-downstream"
    });
    const rejectInput = {
      session_id: "session-downstream",
      operation_id: "repair-complete-rejected",
      validation_id: rejectedSeed.validation.validation_id,
      run_id: rejectedRun.run_id,
      owner: "owner-downstream",
      status: "rejected" as const,
      reason: "public contract changed",
      verification: [{ command: "npm test", outcome: "failed" as const, summary: "contract mismatch" }]
    };
    await rejectedSeed.fixture.service.completeDependencyValidation(rejectInput);
    await rejectedSeed.fixture.service.completeDependencyValidation(rejectInput);
    expect(rejectedSeed.fixture.store.dependencyRepairs).toEqual([
      expect.objectContaining({
        validation_id: rejectedSeed.validation.validation_id,
        source_run_id: rejectedRun.run_id,
        upstream_task_id: rejectedSeed.validation.upstream_task_id,
        downstream_task_id: rejectedSeed.validation.downstream_task_id,
        cycle: rejectedSeed.validation.cycle,
        status: "pending",
        rejection_reason: "public contract changed"
      })
    ]);

    const errorSeed = await seedPendingValidation();
    const errorRun = await errorSeed.fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "repair-receive-error",
      validation_id: errorSeed.validation.validation_id,
      owner: "owner-downstream"
    });
    await errorSeed.fixture.service.completeDependencyValidation({
      session_id: "session-downstream",
      operation_id: "repair-complete-error",
      validation_id: errorSeed.validation.validation_id,
      run_id: errorRun.run_id,
      owner: "owner-downstream",
      status: "error",
      reason: "runner unavailable",
      verification: []
    });
    expect(errorSeed.fixture.store.dependencyRepairs).toEqual([]);
  });

  it("claims a current rejected validation as normal upstream repair work", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const run = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "claim-repair-validation-receive",
      validation_id: validation.validation_id,
      owner: "owner-downstream"
    });
    await fixture.service.completeDependencyValidation({
      session_id: "session-downstream",
      operation_id: "claim-repair-validation-complete",
      validation_id: validation.validation_id,
      run_id: run.run_id,
      owner: "owner-downstream",
      status: "rejected",
      reason: "contract mismatch",
      verification: [{ command: "npm test", outcome: "failed", summary: "mismatch" }]
    });
    const repair = fixture.store.dependencyRepairs[0]!;

    await expect(fixture.service.listDependencyRepairRequests({
      session_id: "session-a",
      owner: "jande",
      repository_id: "repo-1"
    })).resolves.toEqual([expect.objectContaining({ repair_id: repair.repair_id })]);
    await expect(fixture.service.receiveDependencyRepair({
      session_id: "session-downstream",
      operation_id: "claim-repair-wrong-owner",
      repair_id: repair.repair_id,
      owner: "owner-downstream",
      expected_version: 3
    })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });

    const claimInput = {
      session_id: "session-a",
      operation_id: "claim-repair-upstream",
      repair_id: repair.repair_id,
      owner: "jande",
      expected_version: 3
    };
    const claimed = await fixture.service.receiveDependencyRepair(claimInput);
    expect(claimed).toMatchObject({
      task_id: validation.upstream_task_id,
      status: "in_progress",
      version: 4,
      repair: {
        repair_id: repair.repair_id,
        status: "claimed",
        claimed_session_id: "session-a",
        claimed_worktree_path: WORKTREE_A
      }
    });
    expect(fixture.store.getLeaseByTask(validation.upstream_task_id)).toMatchObject({
      session_id: "session-a",
      generation: 4
    });
    await expect(fixture.service.receiveDependencyRepair(claimInput)).resolves.toEqual(claimed);
  });

  it("resolves claimed repair on fresh resubmission and gates acceptance on the new cycle", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const firstRun = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "repair-cycle-receive-1",
      validation_id: validation.validation_id,
      owner: "owner-downstream"
    });
    await fixture.service.completeDependencyValidation({
      session_id: "session-downstream",
      operation_id: "repair-cycle-reject-1",
      validation_id: validation.validation_id,
      run_id: firstRun.run_id,
      owner: "owner-downstream",
      status: "rejected",
      reason: "contract mismatch",
      verification: [{ command: "npm test", outcome: "failed", summary: "mismatch" }]
    });
    const repair = fixture.store.dependencyRepairs[0]!;
    await fixture.service.receiveDependencyRepair({
      session_id: "session-a",
      operation_id: "repair-cycle-claim",
      repair_id: repair.repair_id,
      owner: "jande",
      expected_version: 3
    });
    const verification = [{ command: "npm test", outcome: "passed" as const, summary: "green" }];
    await fixture.service.checkpointTask({
      session_id: "session-a",
      operation_id: "repair-cycle-checkpoint",
      task_id: validation.upstream_task_id,
      expected_version: 4,
      checkpoint: checkpoint({ verification }),
      target_status: "verifying"
    });
    const submitted = await fixture.service.submitTask({
      session_id: "session-a",
      operation_id: "repair-cycle-submit",
      task_id: validation.upstream_task_id,
      expected_version: 5,
      verification
    });
    expect(submitted).toMatchObject({ status: "pending_acceptance", version: 6 });
    expect(fixture.store.dependencyRepairs[0]).toMatchObject({
      repair_id: repair.repair_id,
      status: "resolved",
      resolved_at: expect.any(String)
    });
    const newValidation = fixture.store.dependencyValidations.find((candidate) => (
      candidate.cycle === 2
    ));
    expect(newValidation).toMatchObject({
      upstream_task_id: validation.upstream_task_id,
      downstream_task_id: validation.downstream_task_id,
      status: "pending"
    });
    await expect(fixture.service.humanAccept(
      validation.upstream_task_id,
      humanActor
    )).rejects.toMatchObject({ code: "DEPENDENCY_VALIDATION_REQUIRED" });

    const secondRun = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "repair-cycle-receive-2",
      validation_id: newValidation!.validation_id,
      owner: "owner-downstream"
    });
    await fixture.service.completeDependencyValidation({
      session_id: "session-downstream",
      operation_id: "repair-cycle-pass-2",
      validation_id: newValidation!.validation_id,
      run_id: secondRun.run_id,
      owner: "owner-downstream",
      status: "passed",
      verification: [{ command: "npm test", outcome: "passed", summary: "green" }]
    });
    await expect(fixture.service.humanAccept(
      validation.upstream_task_id,
      humanActor
    )).resolves.toMatchObject({ status: "done" });
  });

  it("supersedes repair work when its dependency edge changes and cancels it with the upstream task", async () => {
    const reject = async () => {
      const seeded = await seedPendingValidation();
      const run = await seeded.fixture.service.receiveDependencyValidation({
        session_id: "session-downstream",
        operation_id: "invalidate-repair-receive",
        validation_id: seeded.validation.validation_id,
        owner: "owner-downstream"
      });
      await seeded.fixture.service.completeDependencyValidation({
        session_id: "session-downstream",
        operation_id: "invalidate-repair-reject",
        validation_id: seeded.validation.validation_id,
        run_id: run.run_id,
        owner: "owner-downstream",
        status: "rejected",
        reason: "contract mismatch",
        verification: [{ command: "npm test", outcome: "failed", summary: "mismatch" }]
      });
      return seeded;
    };

    const edgeSeed = await reject();
    const edgeRepair = edgeSeed.fixture.store.dependencyRepairs[0]!;
    await edgeSeed.fixture.service.updateTaskDependencies({
      session_id: "session-downstream",
      operation_id: "invalidate-repair-remove-edge",
      task_id: edgeSeed.validation.downstream_task_id,
      expected_version: 0,
      dependencies: []
    });
    expect(edgeSeed.fixture.store.dependencyRepairs[0]).toMatchObject({
      repair_id: edgeRepair.repair_id,
      status: "superseded",
      superseded_at: expect.any(String)
    });
    await expect(edgeSeed.fixture.service.receiveDependencyRepair({
      session_id: "session-a",
      operation_id: "invalidate-repair-claim-old",
      repair_id: edgeRepair.repair_id,
      owner: "jande",
      expected_version: 3
    })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const cancelSeed = await reject();
    await cancelSeed.fixture.service.humanCancel(
      cancelSeed.validation.upstream_task_id,
      humanActor
    );
    expect(cancelSeed.fixture.store.dependencyRepairs[0]).toMatchObject({
      status: "cancelled",
      updated_at: expect.any(String)
    });
    expect(cancelSeed.fixture.store.events).toContainEqual(expect.objectContaining({
      task_id: cancelSeed.validation.upstream_task_id,
      event_type: "dependency_repair_cancelled",
      payload: expect.objectContaining({
        actor: "human",
        downstream_task_id: cancelSeed.validation.downstream_task_id
      })
    }));
  });

  it("supersedes active repair work when the downstream task becomes terminal", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const run = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "terminal-repair-receive",
      validation_id: validation.validation_id,
      owner: "owner-downstream"
    });
    await fixture.service.completeDependencyValidation({
      session_id: "session-downstream",
      operation_id: "terminal-repair-reject",
      validation_id: validation.validation_id,
      run_id: run.run_id,
      owner: "owner-downstream",
      status: "rejected",
      reason: "contract mismatch",
      verification: [{ command: "npm test", outcome: "failed", summary: "mismatch" }]
    });
    const repair = fixture.store.dependencyRepairs[0]!;
    // The downstream can close once the upstream relationship is otherwise
    // terminal; this isolates repair cleanup from the active-upstream guard.
    fixture.store.tasks.get(validation.upstream_task_id)!.status = "done";
    await fixture.service.humanCancel(validation.downstream_task_id, humanActor);

    expect(fixture.store.dependencyRepairs[0]).toMatchObject({
      repair_id: repair.repair_id,
      status: "superseded",
      superseded_at: expect.any(String)
    });
    await expect(fixture.service.listDependencyRepairRequests({
      session_id: "session-a",
      owner: "jande",
      repository_id: "repo-1"
    })).resolves.toEqual([]);
    await expect(fixture.service.getTaskRecovery({
      session_id: "session-a",
      task_id: validation.upstream_task_id
    })).resolves.toMatchObject({ active_repair: null });
    expect(fixture.store.events).toContainEqual(expect.objectContaining({
      task_id: validation.upstream_task_id,
      event_type: "dependency_repair_superseded",
      payload: expect.objectContaining({
        actor: "human",
        repair_id: repair.repair_id,
        downstream_task_id: validation.downstream_task_id
      })
    }));
  });

  it("does not turn a validation_gate dependency into an acceptance blocker", async () => {
    const { store, service } = createFixture();
    const { taskId: upstreamId } = await startedTask(service, "session-a", "1", {});
    const { taskId: downstreamId } = await startedTask(service, "session-b", "2", {});
    store.transaction((tx) => {
      tx.insertTaskDependency({
        task_id: downstreamId,
        depends_on_task_id: upstreamId,
        created_at: "2026-08-19T00:00:00.000Z",
        policy: "validation_gate"
      });
    });
    await service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-validation-gate-checkpoint",
      task_id: upstreamId,
      expected_version: 1,
      checkpoint: checkpoint({
        verification: [{ command: "npm test", outcome: "passed", summary: "all green" }]
      }),
      target_status: "verifying"
    });
    await service.submitTask({
      session_id: "session-a",
      operation_id: "op-validation-gate-submit",
      task_id: upstreamId,
      expected_version: 2,
      verification: [{ command: "npm test", outcome: "passed", summary: "all green" }]
    });
    await expect(service.humanAccept(upstreamId, humanActor)).resolves.toMatchObject({
      status: "done"
    });
  });

  it("enforces hard_block dependencies when starting a task", async () => {
    const { store, service } = createFixture();
    const { taskId: upstreamId } = await startedTask(service, "session-a", "1", {});
    const downstreamId = await createTask(service, {
      session_id: "session-b",
      operation_id: "op-hard-block-downstream"
    });
    store.transaction((tx) => {
      tx.insertTaskDependency({
        task_id: downstreamId,
        depends_on_task_id: upstreamId,
        created_at: "2026-08-19T00:00:00.000Z",
        policy: "hard_block"
      });
    });
    await expect(service.startTask({
      session_id: "session-b",
      operation_id: "op-hard-block-start",
      task_id: downstreamId,
      expected_version: 0,
      acknowledged_warning_codes: ["SOFT_DEPENDENCY"]
    })).rejects.toMatchObject({
      code: "ACTIVE_UPSTREAM_DEPENDENCY",
      evidence: [`${upstreamId}:in_progress`]
    });
  });

  it("requires a reason and failed evidence when completing as rejected", async () => {
    const missingReason = await seedPendingValidation();
    const first = await missingReason.fixture.service.receiveDependencyValidation({
      session_id: "session-downstream", operation_id: "op-receive-reject-no-reason",
      validation_id: missingReason.validation.validation_id, owner: "owner-downstream"
    });
    await expect(missingReason.fixture.service.completeDependencyValidation({
      session_id: "session-downstream", operation_id: "op-complete-reject-no-reason",
      validation_id: missingReason.validation.validation_id, run_id: first.run_id,
      owner: "owner-downstream", status: "rejected", verification: [{ command: "npm test", outcome: "failed", summary: "failed" }]
    })).rejects.toMatchObject({ code: "DEPENDENCY_VALIDATION_REQUIRED" });

    const missingEvidence = await seedPendingValidation();
    const second = await missingEvidence.fixture.service.receiveDependencyValidation({
      session_id: "session-downstream", operation_id: "op-receive-reject-no-evidence",
      validation_id: missingEvidence.validation.validation_id, owner: "owner-downstream"
    });
    await expect(missingEvidence.fixture.service.completeDependencyValidation({
      session_id: "session-downstream", operation_id: "op-complete-reject-no-evidence",
      validation_id: missingEvidence.validation.validation_id, run_id: second.run_id,
      owner: "owner-downstream", status: "rejected", reason: "contract mismatch",
      verification: [{ command: "npm test", outcome: "passed", summary: "green" }]
    })).rejects.toMatchObject({ code: "DEPENDENCY_VALIDATION_REQUIRED" });
  });

  it("keeps error completion pending without a responded event", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const received = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream", operation_id: "op-receive-error-event",
      validation_id: validation.validation_id, owner: "owner-downstream"
    });
    const before = fixture.store.events.filter((event) => event.event_type === "dependency_validation_responded").length;
    const result = await fixture.service.completeDependencyValidation({
      session_id: "session-downstream", operation_id: "op-complete-error-event",
      validation_id: validation.validation_id, run_id: received.run_id,
      owner: "owner-downstream", status: "error", reason: "runner timeout", verification: []
    });
    expect(result.validation.status).toBe("pending");
    expect(fixture.store.events.filter((event) => event.event_type === "dependency_validation_responded")).toHaveLength(before);
  });

  it("rejects completion when the run owner or session does not match", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const received = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream", operation_id: "op-receive-complete-owner",
      validation_id: validation.validation_id, owner: "owner-downstream"
    });
    const verification = [{ command: "npm test", outcome: "passed" as const, summary: "green" }];
    await expect(fixture.service.completeDependencyValidation({
      session_id: "session-downstream", operation_id: "op-complete-wrong-owner",
      validation_id: validation.validation_id, run_id: received.run_id,
      owner: "owner-other", status: "passed", verification
    })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });

    fixture.store.dependencyValidationRuns[0]!.session_id = "session-a";
    await expect(fixture.service.completeDependencyValidation({
      session_id: "session-downstream", operation_id: "op-complete-wrong-session",
      validation_id: validation.validation_id, run_id: received.run_id,
      owner: "owner-downstream", status: "passed", verification
    })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });

  it("rejects completion for repository, worktree, terminal, stale-cycle, expired, and invalid runs", async () => {
    const completeWith = async (
      mutate: (fixture: Fixture, validation: DependencyValidationRecord, runId: string) => void,
      expectedCode: string,
      operationId: string
    ) => {
      const { fixture, validation } = await seedPendingValidation();
      const received = await fixture.service.receiveDependencyValidation({
        session_id: "session-downstream", operation_id: `${operationId}-receive`,
        validation_id: validation.validation_id, owner: "owner-downstream"
      });
      mutate(fixture, validation, received.run_id);
      await expect(fixture.service.completeDependencyValidation({
        session_id: "session-downstream", operation_id: operationId,
        validation_id: validation.validation_id, run_id: received.run_id,
        owner: "owner-downstream", status: "passed",
        verification: [{ command: "npm test", outcome: "passed", summary: "green" }]
      })).rejects.toMatchObject({ code: expectedCode });
    };

    await completeWith((fixture) => {
      fixture.store.sessions.get("session-downstream")!.repository_id = "repo-2";
    }, "REPOSITORY_NOT_ALLOWED", "op-complete-repository");
    await completeWith((fixture) => {
      fixture.store.sessions.get("session-downstream")!.worktree_path = WORKTREE_C;
    }, "SESSION_CONTEXT_CONFLICT", "op-complete-worktree");
    await completeWith((fixture, validation) => {
      fixture.store.tasks.get(validation.downstream_task_id)!.status = "done";
    }, "DEPENDENCY_VALIDATION_ALREADY_RESPONDED", "op-complete-terminal");
    await completeWith((fixture, validation) => {
      fixture.store.transaction((tx) => {
        tx.supersedePendingDependencyValidations(validation.upstream_task_id, isoAt(2));
        tx.insertDependencyValidation(validationAtCycle(
          { ...validation, validation_id: `${validation.validation_id}-new`, requested_at: isoAt(2) },
          validation.cycle + 1
        ));
      });
    }, "TASK_VERSION_CONFLICT", "op-complete-stale-cycle");
    await completeWith((fixture, _validation, runId) => {
      fixture.store.dependencyValidationRuns.find((run) => run.run_id === runId)!.expires_at = isoAt(-1);
    }, "TASK_LEASE_CONFLICT", "op-complete-expired");
    await completeWith((fixture, _validation, runId) => {
      fixture.store.dependencyValidationRuns.find((run) => run.run_id === runId)!.status = "passed";
    }, "INVALID_TRANSITION", "op-complete-invalid-status");
  });

  it("rejects an altered validation completion retry payload", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const received = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream", operation_id: "op-receive-idempotent",
      validation_id: validation.validation_id, owner: "owner-downstream"
    });
    const input = {
      session_id: "session-downstream", operation_id: "op-complete-idempotent",
      validation_id: validation.validation_id, run_id: received.run_id,
      owner: "owner-downstream" as const, status: "passed" as const,
      verification: [{ command: "npm test", outcome: "passed" as const, summary: "green" }]
    };
    const first = await fixture.service.completeDependencyValidation(input);
    await expect(fixture.service.completeDependencyValidation({
      ...input,
      status: "rejected",
      reason: "altered payload",
      verification: [{ command: "npm test", outcome: "failed", summary: "changed" }]
    })).rejects.toMatchObject({ code: "OPERATION_ID_CONFLICT" });
    expect(first.run.status).toBe("passed");
  });

  it("sanitizes completion evidence before returning or caching it", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const received = await fixture.service.receiveDependencyValidation({
      session_id: "session-downstream",
      operation_id: "op-evidence-sanitize-receive",
      validation_id: validation.validation_id,
      owner: "owner-downstream"
    });
    const input = {
      session_id: "session-downstream",
      operation_id: "op-evidence-sanitize-complete",
      validation_id: validation.validation_id,
      run_id: received.run_id,
      owner: "owner-downstream" as const,
      status: "passed" as const,
      verification: [{
        command: "API_KEY=MCP_SECRET_MUST_NOT_ESCAPE npm test",
        outcome: "passed" as const,
        summary: "MCP_SECRET_MUST_NOT_ESCAPE",
        revision: "agent-revision",
        target_revision: "target-revision",
        worktree_path: WORKTREE_B
      }]
    };

    const completed = await fixture.service.completeDependencyValidation(input);
    expect(completed.run.verification).toEqual([{
      command: "[redacted command]",
      outcome: "passed",
      summary: "[redacted sensitive output]",
      revision: "agent-revision",
      target_revision: "target-revision",
      worktree_path: WORKTREE_B
    }]);
    expect(JSON.stringify(completed)).not.toContain("MCP_SECRET_MUST_NOT_ESCAPE");

    const replay = await fixture.service.completeDependencyValidation(input);
    expect(replay).toEqual(completed);
    expect(JSON.stringify(replay)).not.toContain("MCP_SECRET_MUST_NOT_ESCAPE");
  });

  it("caps automatic retries after two validation attempts", async () => {
    const { fixture, validation } = await seedPendingValidation();
    const receive = (operation_id: string) => fixture.service.receiveDependencyValidation({
      session_id: "session-downstream", operation_id,
      validation_id: validation.validation_id, owner: "owner-downstream"
    });
    const first = await receive("op-cap-1");
    fixture.store.dependencyValidationRuns[0]!.expires_at = isoAt(-1);
    const second = await receive("op-cap-2");
    fixture.store.dependencyValidationRuns.find((run) => run.run_id === second.run_id)!.expires_at = isoAt(-1);
    const capped = await receive("op-cap-3");
    expect(capped).toMatchObject({ status: "capped", capped: true, attempt: 2 });
    expect(capped.run).toMatchObject({ status: "error", error_reason: "lease expired" });
    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
  });

  it("rejects receiving a request from a stale validation cycle", async () => {
    const { fixture, validation } = await seedPendingValidation();
    fixture.store.transaction((tx) => {
      tx.supersedePendingDependencyValidations(validation.upstream_task_id, isoAt(2));
      tx.insertDependencyValidation(validationAtCycle({
        ...validation,
        validation_id: "validation-new-cycle",
        requested_at: isoAt(2)
      }, validation.cycle + 1));
    });
    await expect(fixture.service.receiveDependencyValidation({
      session_id: "session-downstream", operation_id: "op-stale-receive",
      validation_id: validation.validation_id, owner: "owner-downstream"
    })).rejects.toMatchObject({ code: "TASK_VERSION_CONFLICT" });
  });

  it("cancels a non-terminal task as a human and releases its lease", async () => {
    const { store, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});

    await expect(service.humanCancel(taskId, humanActor)).resolves.toMatchObject({
      status: "cancelled",
      version: 2
    });

    expect(store.transaction((tx) => tx.getLeaseByTask(taskId))).toBeUndefined();
    expect(store.events.at(-1)).toMatchObject({
      event_type: "task_cancelled",
      payload: { actor: "human" }
    });
    expect(store.decisions.at(-1)).toMatchObject({ status: "decided" });
  });

  it("cancels while a direct upstream dependency is active and records the context", async () => {
    const { store, service } = createFixture();
    const { taskId: upstreamId } = await startedTask(service, "session-a", "1", {});
    const { taskId: downstreamId } = await startedTask(service, "session-b", "2", {});
    store.insertTaskDependency({
      task_id: downstreamId,
      depends_on_task_id: upstreamId,
      created_at: "2026-08-19T00:00:00.000Z"
    });
    await expect(service.humanCancel(
      downstreamId,
      humanActor,
      { expected_version: 1 }
    )).resolves.toMatchObject({ status: "cancelled", version: 2 });

    expect(store.getTaskDetail(downstreamId)).toMatchObject({
      status: "cancelled",
      version: 2
    });
    expect(store.transaction((tx) => tx.getLeaseByTask(downstreamId))).toBeUndefined();
    expect(store.events.at(-1)).toMatchObject({
      event_type: "task_cancelled",
      payload: {
        dependency_contexts: [{
          upstream_task_id: upstreamId,
          downstream_task_id: downstreamId,
          status: "cancelled"
        }]
      }
    });
  });

  it("cancels when terminal and active direct upstreams are mixed", async () => {
    const { store, service } = createFixture();
    const terminalUpstreamId = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-create-terminal-upstream"
    });
    const activeUpstreamId = await createTask(service, {
      session_id: "session-b",
      operation_id: "op-create-active-upstream"
    });
    const downstreamId = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-create-mixed-downstream"
    });
    store.transaction((tx) => {
      const terminalUpstream = tx.getTask(terminalUpstreamId)!;
      tx.updateTask({ ...terminalUpstream, status: "done" }, 0);
      tx.insertTaskDependency({
        task_id: downstreamId,
        depends_on_task_id: terminalUpstreamId,
        created_at: "2026-08-19T00:00:00.000Z"
      });
      tx.insertTaskDependency({
        task_id: downstreamId,
        depends_on_task_id: activeUpstreamId,
        created_at: "2026-08-19T00:00:01.000Z"
      });
    });

    await expect(service.humanCancel(downstreamId, humanActor)).resolves.toMatchObject({
      status: "cancelled",
      version: 1
    });
  });

  it("allows cancellation when every direct upstream is done or cancelled", async () => {
    const { store, service } = createFixture();
    const doneUpstreamId = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-create-done-upstream"
    });
    const cancelledUpstreamId = await createTask(service, {
      session_id: "session-b",
      operation_id: "op-create-cancelled-upstream"
    });
    const downstreamId = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-create-terminal-downstream"
    });
    store.transaction((tx) => {
      const doneUpstream = tx.getTask(doneUpstreamId)!;
      const cancelledUpstream = tx.getTask(cancelledUpstreamId)!;
      tx.updateTask({ ...doneUpstream, status: "done" }, 0);
      tx.updateTask({ ...cancelledUpstream, status: "cancelled" }, 0);
      tx.insertTaskDependency({
        task_id: downstreamId,
        depends_on_task_id: doneUpstreamId,
        created_at: "2026-08-19T00:00:00.000Z"
      });
      tx.insertTaskDependency({
        task_id: downstreamId,
        depends_on_task_id: cancelledUpstreamId,
        created_at: "2026-08-19T00:00:01.000Z"
      });
    });

    await expect(service.humanCancel(downstreamId, humanActor)).resolves.toMatchObject({
      status: "cancelled",
      version: 1
    });
  });

  it("rejects a human reject on a task that is not pending acceptance", async () => {
    const { service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});

    await expect(service.humanReject(taskId, humanActor)).rejects.toMatchObject({
      code: "INVALID_TRANSITION"
    });
  });

  it("attaches a session without creating a lease or changing task state", async () => {
    const { store, service } = createFixture();
    const taskId = await createTask(service, { operation_id: "op-create-1" });

    await expect(service.attachTask({
      session_id: "session-b",
      operation_id: "op-attach-1",
      task_id: taskId,
      role: "reviewer"
    })).resolves.toMatchObject({
      task_id: taskId,
      status: "backlog",
      version: 0,
      session_id: "session-b",
      role: "reviewer"
    });

    expect(store.sessionLinks).toEqual([{
      task_id: taskId,
      session_id: "session-b",
      linked_at: expect.any(String)
    }]);
    expect(store.transaction((tx) => tx.getLeaseBySession("session-b"))).toBeUndefined();
    expect(store.getTaskDetail(taskId)).toMatchObject({ status: "backlog", version: 0 });
    expect(store.events.map((event) => event.event_type)).toEqual([
      "task_created",
      "task_attached"
    ]);
  });

  it("rejects attaching a task from another owner", async () => {
    const { store, service, sessionB } = createFixture();
    const taskId = await createTask(service, { operation_id: "op-create-owner-attach" });
    store.sessions.set("session-b", { ...sessionB, owner: "owner-other" });

    await expect(service.attachTask({
      session_id: "session-b",
      operation_id: "op-attach-owner-mismatch",
      task_id: taskId,
      role: "implementer"
    })).rejects.toMatchObject({
      code: "OWNER_MISMATCH",
      evidence: ["owner-other", "jande"]
    });
    expect(store.sessionLinks).toHaveLength(0);
  });

  it("rejects creating a task for another owner", async () => {
    const { service } = createFixture();

    await expect(service.createTask({
      session_id: "session-a",
      operation_id: "op-create-owner-mismatch",
      expected_version: 0,
      owner: "owner-other",
      repository_id: "repo-1",
      title: "Wrong owner",
      goal: "Must be rejected",
      acceptance_criteria: ["owner is bound"],
      next_action: "do not start",
      priority: "P1"
    })).rejects.toMatchObject({
      code: "OWNER_MISMATCH",
      evidence: ["jande", "owner-other"]
    });
  });

  it("rejects another owner starting a task after its Session was released", async () => {
    const { store, service, sessionB } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "owner-release");
    await service.humanReleaseSession("session-a", humanActor);
    store.sessions.set("session-b", { ...sessionB, owner: "owner-other" });

    await expect(service.startTask({
      session_id: "session-b",
      operation_id: "op-start-owner-after-release",
      task_id: taskId,
      expected_version: 2
    })).rejects.toMatchObject({
      code: "OWNER_MISMATCH",
      evidence: ["owner-other", "jande"]
    });
    expect(store.getTaskDetail(taskId)).toMatchObject({ status: "paused", version: 2 });
    expect(store.transaction((tx) => tx.getLeaseByTask(taskId))).toBeUndefined();
  });

  it("rejects switching to a task owned by another owner", async () => {
    const { store, service, sessionB } = createFixture();
    const { taskId: currentTaskId } = await startedTask(service, "session-a", "owner-switch-current");
    store.sessions.set("session-b", { ...sessionB, owner: "owner-other" });
    const targetTaskId = await createTask(service, {
      session_id: "session-b",
      operation_id: "op-create-owner-switch-target"
    });

    await expect(service.switchTask({
      session_id: "session-a",
      operation_id: "op-switch-owner-mismatch",
      task_id: currentTaskId,
      expected_version: 1,
      checkpoint: checkpoint(),
      target_task_id: targetTaskId,
      target_expected_version: 0
    })).rejects.toMatchObject({
      code: "OWNER_MISMATCH",
      evidence: ["jande", "owner-other"]
    });
    expect(store.getTaskDetail(currentTaskId)).toMatchObject({ status: "in_progress", version: 1 });
    expect(store.getTaskDetail(targetTaskId)).toMatchObject({ status: "backlog", version: 0 });
    expect(store.transaction((tx) => tx.getLeaseByTask(currentTaskId)))
      .toMatchObject({ session_id: "session-a" });
  });

  it("rejects checkpoint writes when the lease session owner does not match", async () => {
    const { store, service, sessionB } = createFixture();
    const taskId = await createTask(service, { operation_id: "op-create-owner-checkpoint" });
    store.sessions.set("session-b", { ...sessionB, owner: "owner-other" });
    const task = store.getTaskDetail(taskId)!;
    store.transaction((tx) => {
      tx.updateTask({ ...task, status: "in_progress", session_id: "session-b" }, 0);
      tx.putLease({
        task_id: taskId,
        session_id: "session-b",
        acquired_at: isoAt(0),
        heartbeat_at: isoAt(0),
        expires_at: isoAt(1_800)
      });
    });

    await expect(service.checkpointTask({
      session_id: "session-b",
      operation_id: "op-checkpoint-owner-mismatch",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint()
    })).rejects.toMatchObject({
      code: "OWNER_MISMATCH",
      evidence: ["owner-other", "jande"]
    });
  });

  it("rejects submit writes when the lease session owner does not match", async () => {
    const { store, service, sessionB } = createFixture();
    const taskId = await createTask(service, { operation_id: "op-create-owner-submit" });
    store.sessions.set("session-b", { ...sessionB, owner: "owner-other" });
    const task = store.getTaskDetail(taskId)!;
    store.transaction((tx) => {
      tx.updateTask({ ...task, status: "in_progress", session_id: "session-b" }, 0);
      tx.putLease({
        task_id: taskId,
        session_id: "session-b",
        acquired_at: isoAt(0),
        heartbeat_at: isoAt(0),
        expires_at: isoAt(1_800)
      });
    });

    await expect(service.submitTask({
      session_id: "session-b",
      operation_id: "op-submit-owner-mismatch",
      task_id: taskId,
      expected_version: 1,
      verification: [{ command: "npm test", outcome: "passed", summary: "green" }]
    })).rejects.toMatchObject({
      code: "OWNER_MISMATCH",
      evidence: ["owner-other", "jande"]
    });
  });

  it("rejects attach, switch, and dependency writes to another repository", async () => {
    const { store, service } = createFixture();
    registerSecondRepository(store);
    const foreignTaskId = await service.createTask({
      session_id: "session-c",
      operation_id: "op-create-foreign",
      expected_version: 0,
      repository_id: "repo-2",
      title: "Foreign task",
      goal: "Stay isolated",
      acceptance_criteria: ["repo isolation"],
      next_action: "wait",
      priority: "P1"
    }).then((result) => result.task_id);

    await expect(service.attachTask({
      session_id: "session-a",
      operation_id: "op-attach-foreign",
      task_id: foreignTaskId,
      role: "reviewer"
    })).rejects.toMatchObject({ code: "REPOSITORY_NOT_ALLOWED" });
    await expect(service.updateTaskDependencies({
      session_id: "session-a",
      operation_id: "op-dependencies-foreign",
      task_id: foreignTaskId,
      expected_version: 0,
      dependencies: []
    })).rejects.toMatchObject({ code: "REPOSITORY_NOT_ALLOWED" });

    const { taskId: currentTaskId } = await startedTask(
      service,
      "session-a",
      "cross-repository-switch"
    );
    await expect(service.switchTask({
      session_id: "session-a",
      operation_id: "op-switch-foreign",
      task_id: currentTaskId,
      expected_version: 1,
      checkpoint: checkpoint(),
      target_task_id: foreignTaskId,
      target_expected_version: 0
    })).rejects.toMatchObject({ code: "REPOSITORY_NOT_ALLOWED" });
    expect(store.getTaskDetail(foreignTaskId)).toMatchObject({
      status: "backlog",
      version: 0
    });
  });

  it("reports a structured version conflict with the current version", async () => {
    const { service } = createFixture();
    const taskId = await createTask(service, { operation_id: "op-create-1" });

    const error = await service.startTask({
      session_id: "session-a",
      operation_id: "op-start-1",
      task_id: taskId,
      expected_version: 7
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformDomainError);
    expect(error).toMatchObject({
      code: "TASK_VERSION_CONFLICT",
      current_version: "0",
      retryable: false,
      recovery_actions: expect.any(Array)
    });
  });

  it("refuses to start a second task while the session already holds a lease", async () => {
    const { service } = createFixture();
    await startedTask(service, "session-a", "1", {});
    const secondTaskId = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-create-2"
    });

    const error = await service.startTask({
      session_id: "session-a",
      operation_id: "op-start-2",
      task_id: secondTaskId,
      expected_version: 0
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "TASK_LEASE_CONFLICT",
      retryable: false,
      evidence: expect.arrayContaining([expect.stringContaining("session-a")]),
      recovery_actions: expect.any(Array)
    });
  });

  it("refuses to start a task whose lease another session already holds", async () => {
    const { service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});

    await expect(service.startTask({
      session_id: "session-b",
      operation_id: "op-start-2",
      task_id: taskId,
      expected_version: 1
    })).rejects.toMatchObject({
      code: "TASK_LEASE_CONFLICT",
      evidence: expect.arrayContaining([expect.stringContaining(taskId)])
    });
  });

  it("returns the recorded response for a repeated operation id without new effects", async () => {
    const { store, service } = createFixture();
    const taskId = await createTask(service, { operation_id: "op-create-1" });
    const startInput: StartTaskInput = {
      session_id: "session-a",
      operation_id: "op-start-1",
      task_id: taskId,
      expected_version: 0
    };

    const first = await service.startTask(startInput);
    const second = await service.startTask(startInput);

    expect(second).toEqual(first);
    expect(store.getTaskDetail(taskId)).toMatchObject({ version: 1 });
    expect(store.events.filter((event) => event.event_type === "task_started"))
      .toHaveLength(1);
  });

  it("switches atomically: pauses the current task and starts the target", async () => {
    const { store, service } = createFixture();
    const { taskId: currentId } = await startedTask(service, "session-a", "1", {});
    const targetId = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-create-2",
      scopes: [{ scope_type: "worktree_path", scope_value: WORKTREE_B }]
    });
    const switchInput: SwitchTaskInput = {
      session_id: "session-a",
      operation_id: "op-switch-1",
      task_id: currentId,
      expected_version: 1,
      checkpoint: checkpoint(),
      target_task_id: targetId,
      target_expected_version: 0
    };

    await expect(service.switchTask(switchInput)).resolves.toMatchObject({
      task_id: targetId,
      status: "in_progress",
      version: 1,
      paused_task_id: currentId,
      paused_task_version: 2,
      previous_worktree_path: WORKTREE_A,
      worktree_path: WORKTREE_B
    });

    expect(store.getTaskDetail(currentId)).toMatchObject({ status: "paused", version: 2 });
    expect(store.getTaskDetail(targetId)).toMatchObject({
      status: "in_progress",
      version: 1,
      session_id: "session-a"
    });
    expect(store.transaction((tx) => tx.getLeaseByTask(currentId))).toBeUndefined();
    expect(store.transaction((tx) => tx.getLeaseByTask(targetId))).toMatchObject({
      session_id: "session-a"
    });
    expect(store.transaction((tx) => tx.getSession("session-a"))).toMatchObject({
      workspace_path: WORKTREE_B,
      worktree_path: WORKTREE_B
    });
    expect(store.sessionEvents).toEqual([
      expect.objectContaining({
        session_id: "session-a",
        event_type: "session_rebound",
        payload: expect.objectContaining({
          previous_worktree_path: WORKTREE_A,
          worktree_path: WORKTREE_B,
          via: "task_switch"
        })
      })
    ]);
    expect(store.getTaskDetail(targetId)?.scopes
      .filter((scope) => scope.scope_type === "worktree_path"))
      .toEqual([
        expect.objectContaining({ scope_value: WORKTREE_B })
      ]);
    expect(store.checkpoints.at(-1)).toMatchObject({ task_id: currentId });
    expect(store.events.map((event) => event.event_type)).toEqual([
      "task_created",
      "task_started",
      "task_created",
      "task_checkpointed",
      "task_paused",
      "task_started"
    ]);
  });

  it("uses an explicit target worktree and replaces a stale target scope", async () => {
    const { store, service } = createFixture();
    const { taskId: currentId } = await startedTask(service, "session-a", "1", {});
    const targetId = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-create-stale-target",
      scopes: [{ scope_type: "worktree_path", scope_value: WORKTREE_A }]
    });

    await expect(service.switchTask({
      session_id: "session-a",
      operation_id: "op-switch-explicit-target",
      task_id: currentId,
      expected_version: 1,
      checkpoint: checkpoint(),
      target_task_id: targetId,
      target_expected_version: 0,
      target_worktree_path: WORKTREE_B
    })).resolves.toMatchObject({
      task_id: targetId,
      previous_worktree_path: WORKTREE_A,
      worktree_path: WORKTREE_B
    });

    expect(store.transaction((tx) => tx.getSession("session-a"))).toMatchObject({
      workspace_path: WORKTREE_B,
      worktree_path: WORKTREE_B
    });
    expect(store.getTaskDetail(targetId)?.scopes
      .filter((scope) => scope.scope_type === "worktree_path"))
      .toEqual([
        expect.objectContaining({ scope_value: WORKTREE_B })
      ]);
    expect(store.transaction((tx) => tx.getLeaseByTask(targetId))).toMatchObject({
      session_id: "session-a"
    });
  });

  it("fails closed for a remote worktree instead of attributing server checkout evidence", async () => {
    const { store, probe, service } = createFixture();
    const { taskId: currentId } = await startedTask(service, "session-a", "remote-current");
    const targetId = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-create-remote-target",
      scopes: [{ scope_type: "worktree_path", scope_value: WORKTREE_B }]
    });
    probe.failures.set(
      WORKTREE_B,
      Object.assign(new Error("remote path is opaque"), {
        code: "REPOSITORY_NOT_ALLOWED"
      })
    );

    await expect(service.switchTask({
      session_id: "session-a",
      operation_id: "op-switch-remote-target",
      task_id: currentId,
      expected_version: 1,
      checkpoint: checkpoint(),
      target_task_id: targetId,
      target_expected_version: 0
    })).rejects.toMatchObject({
      code: "REMOTE_WORKTREE_EVIDENCE_REQUIRED",
      retryable: true
    });
    expect(probe.probedPaths).toContain(WORKTREE_B);
    expect(store.getTaskDetail(targetId)).toMatchObject({ status: "backlog" });
    expect(store.getLatestRepoSnapshot(targetId)).toBeUndefined();
  });

  it("rejects checkpoint with REMOTE_WORKTREE_EVIDENCE_REQUIRED when the session worktree is unreachable", async () => {
    const { service, probe } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "evidence-required");
    probe.failures.set(
      WORKTREE_A,
      Object.assign(new Error("remote path is opaque"), {
        code: "REPOSITORY_NOT_ALLOWED"
      })
    );

    await expect(service.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint-remote",
      task_id: taskId,
      expected_version: 1,
      checkpoint: checkpoint()
    })).rejects.toMatchObject({
      code: "REMOTE_WORKTREE_EVIDENCE_REQUIRED",
      retryable: true,
      recovery_actions: expect.arrayContaining([
        expect.stringContaining("evidence collect")
      ])
    });
  });

  it("keeps the current task untouched when the target worktree is contested", async () => {
    const { store, service } = createFixture();
    const { taskId: currentId } = await startedTask(service, "session-a", "1", {});
    const targetId = await createTask(service, {
      session_id: "session-a",
      operation_id: "op-create-2",
      scopes: [{ scope_type: "worktree_path", scope_value: WORKTREE_B }]
    });
    store.transaction((tx) => {
      tx.insertTask({
        task_id: "task-other",
        repository_id: "repo-1",
        session_id: "session-b",
        title: "Other feature",
        status: "in_progress",
        priority: "P1",
        created_at: isoAt(0),
        updated_at: isoAt(0)
      });
      tx.insertTaskScope({
        task_scope_id: "scope-other-1",
        task_id: "task-other",
        scope_type: "worktree_path",
        scope_value: WORKTREE_B
      });
      tx.putLease({
        task_id: "task-other",
        session_id: "session-b",
        acquired_at: isoAt(0),
        heartbeat_at: isoAt(0),
        expires_at: isoAt(1_800)
      });
    });

    await expect(service.switchTask({
      session_id: "session-a",
      operation_id: "op-switch-1",
      task_id: currentId,
      expected_version: 1,
      checkpoint: checkpoint(),
      target_task_id: targetId,
      target_expected_version: 0
    })).rejects.toMatchObject({ code: "WORKTREE_CONFLICT" });

    expect(store.getTaskDetail(currentId)).toMatchObject({
      status: "in_progress",
      version: 1
    });
    expect(store.transaction((tx) => tx.getLeaseByTask(currentId))).toMatchObject({
      session_id: "session-a"
    });
    expect(store.getTaskDetail(targetId)).toMatchObject({ status: "backlog", version: 0 });
    expect(store.transaction((tx) => tx.getSession("session-a"))).toMatchObject({
      worktree_path: WORKTREE_A
    });
    expect(store.sessionEvents).toEqual([]);
    // Only the two task_create seed checkpoints exist; the failed switch added none.
    expect(store.checkpoints).toHaveLength(2);
  });

  it("releases a session lease as a human and pauses the leased task", async () => {
    const { store, service } = createFixture();
    const { taskId } = await startedTask(service, "session-a", "1", {});

    await expect(service.humanReleaseSession("session-a", humanActor))
      .resolves.toMatchObject({ task_id: taskId, status: "paused", version: 2 });

    expect(store.transaction((tx) => tx.getLeaseBySession("session-a"))).toBeUndefined();
    expect(store.getTaskDetail(taskId)).toMatchObject({ status: "paused", version: 2 });
    expect(store.events.at(-1)).toMatchObject({
      event_type: "task_released",
      payload: { actor: "human" }
    });

    await expect(service.humanReleaseSession("session-a", humanActor))
      .rejects.toMatchObject({ code: "LEASE_NOT_FOUND" });
  });

  it("rejects a non-human lease release", async () => {
    const { service } = createFixture();
    await startedTask(service, "session-a", "1", {});

    await expect(service.humanReleaseSession("session-a", agentActor))
      .rejects.toMatchObject({ code: "HUMAN_CONFIRMATION_REQUIRED" });
  });

  it("updates task metadata as a human with a version bump", async () => {
    const { store, service } = createFixture();
    const taskId = await createTask(service, { operation_id: "op-create-1" });

    await expect(service.humanUpdateTask(taskId, humanActor, { priority: "P0" }))
      .resolves.toMatchObject({ status: "backlog", version: 1, priority: "P0" });

    expect(store.getTaskDetail(taskId)).toMatchObject({ priority: "P0", version: 1 });
    expect(store.events.at(-1)).toMatchObject({
      event_type: "task_updated",
      payload: { actor: "human" }
    });

    await expect(service.humanUpdateTask(taskId, agentActor, { priority: "P1" }))
      .rejects.toMatchObject({ code: "HUMAN_CONFIRMATION_REQUIRED" });
  });

  it("exposes read-only queries without writing", async () => {
    const { store, service } = createFixture();
    const taskId = await createTask(service, { operation_id: "op-create-1" });
    const eventsBefore = store.events.length;
    const operationsBefore = store.operations.size;

    const tasks = await service.listTasks({ repositoryId: "repo-1" });
    const detail = await service.getTask(taskId);
    const report = await service.checkTaskConflicts({
      session_id: "session-a",
      task_id: taskId
    });

    expect(tasks).toHaveLength(1);
    expect(detail).toMatchObject({ task_id: taskId, status: "backlog" });
    expect(report).toMatchObject({ level: "none" });
    expect(store.events).toHaveLength(eventsBefore);
    expect(store.operations).toHaveLength(operationsBefore);
  });

  it("propagates probe failures as structured platform errors", async () => {
    const { probe, service } = createFixture();
    probe.failures.set(WORKTREE_A, new Error("git exploded"));
    const taskId = await createTask(service, { operation_id: "op-create-1" });

    await expect(service.startTask({
      session_id: "session-a",
      operation_id: "op-start-1",
      task_id: taskId,
      expected_version: 0
    })).rejects.toMatchObject({ code: "REPO_PROBE_FAILED" });
  });
});
