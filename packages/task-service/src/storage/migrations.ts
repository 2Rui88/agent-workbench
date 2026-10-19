export interface MigrationMetadata {
  readonly version: number;
  readonly name: string;
}

export const migrationMetadata: readonly Readonly<MigrationMetadata>[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "create_initial_schema"
  }),
  Object.freeze({
    version: 2,
    name: "extend_sessions_for_client_metadata"
  }),
  Object.freeze({
    version: 3,
    name: "extend_tasks_with_goal_and_acceptance"
  }),
  Object.freeze({
    version: 4,
    name: "extend_repo_snapshots_for_conflicts"
  }),
  Object.freeze({
    version: 5,
    name: "add_task_owner_and_notifications"
  }),
  Object.freeze({
    version: 6,
    name: "add_board_pairing_and_sessions"
  }),
  Object.freeze({
    version: 7,
    name: "add_session_context_events"
  }),
  Object.freeze({
    version: 8,
    name: "add_dependency_validation_workflow"
  }),
  Object.freeze({
    version: 9,
    name: "add_dependency_validation_runs"
  }),
  Object.freeze({
    version: 10,
    name: "add_project_creator"
  }),
  Object.freeze({
    version: 11,
    name: "add_project_collaboration"
  }),
  Object.freeze({
    version: 12,
    name: "add_dependency_context_and_successor_links"
  }),
  Object.freeze({
    version: 13,
    name: "add_task_memory_and_repair_loop"
  }),
  Object.freeze({
    version: 14,
    name: "add_host_verified_evidence"
  }),
  Object.freeze({
    version: 15,
    name: "add_session_resume_tokens"
  }),
  Object.freeze({
    version: 16,
    name: "add_project_archive"
  })
]);
