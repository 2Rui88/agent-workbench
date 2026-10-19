/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { TaskService } from "../../../src/core/task-service.js";
import { RepoProbe } from "../../../src/repo/repo-probe.js";
import { SqliteDatabase } from "../../../src/storage/database.js";

const directories: string[] = [];
const verification = [{ command: "npm test", outcome: "passed" as const, summary: "green" }];

async function fixture(useTmpAlias = false) {
  const directory = realpathSync(mkdtempSync(join(useTmpAlias ? "/tmp" : tmpdir(), "cli-dependency-repair-")));
  directories.push(directory);
  const repo = join(directory, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.name", "Test Owner");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(repo, "input.txt"), "unchanged submission\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  const config = createRuntimeConfig(join(directory, "data"));
  const database = SqliteDatabase.open(config);
  const store = database.createProgressStore();
  const now = new Date().toISOString();
  store.transaction(tx => {
    tx.upsertProject({ project_id: "review", name: "Review fixture", created_at: now, updated_at: now });
    tx.upsertRepository({ repository_id: "review", project_id: "review", label: "Review fixture", path: repo, created_at: now, updated_at: now });
    for (const session_id of ["upstream-session", "downstream-session"]) {
      tx.insertSession({ session_id, label: session_id, repository_id: "review", owner: "fixture-owner", worktree_path: repo, started_at: now, last_activity_at: now });
    }
  });
  const service = new TaskService({ store, probe: new RepoProbe() });
  const create = async (session_id: string, suffix: string) => (await service.createTask({
    session_id, operation_id: `create-${suffix}`, expected_version: 0, repository_id: "review",
    title: suffix, goal: "test dependency lifecycle", acceptance_criteria: ["gated acceptance"], next_action: "test", priority: "P1"
  })).task_id;
  const upstream = await create("upstream-session", "upstream");
  await service.startTask({ session_id: "upstream-session", task_id: upstream, operation_id: "start", expected_version: 0 });
  await service.checkpointTask({ session_id: "upstream-session", task_id: upstream, operation_id: "checkpoint", expected_version: 1,
    checkpoint: { completed_items: ["verified"], current_state: "verifying", human_context: [], confirmed_decisions: [], pending_decisions: [], blockers: [], verification, next_action: "submit" }, target_status: "verifying" });
  await service.submitTask({ session_id: "upstream-session", task_id: upstream, operation_id: "submit", expected_version: 2, verification });
  const downstream = await create("downstream-session", "downstream");
  await service.updateTaskDependencies({ session_id: "downstream-session", task_id: downstream, operation_id: "edge", expected_version: 0, dependencies: [upstream], policies: { [upstream]: "validation_gate" } });
  const request = { session_id: "upstream-session", task_id: upstream, operation_id: "request", expected_version: 3, verification };
  return { database, store, service, upstream, downstream, request, config, repo };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLite dependency policy and late-cycle repair", () => {
  it("persists policy-only generations, immutable responses, ctx identity, no-op and the full acceptance gate", async () => {
    const f = await fixture();
    try {
      await f.service.requestTaskDependencyValidation(f.request);
      const original = f.store.listDependencyValidationViews(f.upstream)[0]!;
      const run = await f.service.receiveDependencyValidation({ session_id: "downstream-session", operation_id: "receive", validation_id: original.validation_id, owner: "fixture-owner" });
      await f.service.completeDependencyValidation({ session_id: "downstream-session", operation_id: "pass", validation_id: original.validation_id, run_id: run.run_id, owner: "fixture-owner", status: "passed", verification });
      const immutable = f.store.listDependencyValidationViews(f.upstream)[0]!;
      const oldEdge = f.store.transaction(tx => tx.listTaskDependencies(f.downstream)[0]!);
      await f.service.updateTaskDependencies({ session_id: "downstream-session", operation_id: "policy", task_id: f.downstream, expected_version: 1, dependencies: [f.upstream], policies: { [f.upstream]: "acceptance_gate" } });
      await f.service.updateTaskDependencies({ session_id: "downstream-session", operation_id: "policy-next", task_id: f.downstream, expected_version: 2, dependencies: [f.upstream], policies: { [f.upstream]: "hard_block" } });
      const edge = f.store.transaction(tx => tx.listTaskDependencies(f.downstream)[0]!);
      expect(edge).toMatchObject({ policy: "hard_block", generation: 3 });
      expect(edge.ctx_id).not.toBe(oldEdge.ctx_id);
      expect(f.store.transaction(tx => tx.getDependencyContext!(oldEdge.ctx_id!))?.status).toBe("superseded");
      expect(f.store.listDependencyValidationViews(f.upstream)[0]).toEqual(immutable);
      await expect(f.service.humanAccept(f.upstream, "human")).rejects.toMatchObject({ code: "DEPENDENCY_VALIDATION_REQUIRED" });
      await f.service.requestTaskDependencyValidation({ ...f.request, operation_id: "request-policy", expected_version: 4 });
      const current = f.store.listDependencyValidationViews(f.upstream).find(v => v.cycle === 2)!;
      expect(current.ctx_id).toBe(edge.ctx_id);
      const context = f.store.transaction(tx => tx.getDependencyContext!(edge.ctx_id!));
      expect(context).toMatchObject({ current_cycle: 2, status: "active" });
      await f.service.updateTaskDependencies({ session_id: "downstream-session", operation_id: "noop", task_id: f.downstream, expected_version: 3, dependencies: [f.upstream] });
      expect(f.store.transaction(tx => tx.listTaskDependencies(f.downstream)[0])).toEqual(edge);
      const currentRun = await f.service.receiveDependencyValidation({ session_id: "downstream-session", operation_id: "receive-new", validation_id: current.validation_id, owner: "fixture-owner" });
      await f.service.completeDependencyValidation({ session_id: "downstream-session", operation_id: "pass-new", validation_id: current.validation_id, run_id: currentRun.run_id, owner: "fixture-owner", status: "passed", verification });
      expect(f.store.getDependencyValidationGate(f.upstream)).toMatchObject({ ready_for_acceptance: true });
      // Only the isolated fixture's human API is invoked; production tasks are never accepted.
      await expect(f.service.humanAccept(f.upstream, "human")).resolves.toMatchObject({ status: "done" });
    } finally { f.database.close(); }
  });

  it("accepts a stable session binding through the macOS tmp path alias", async () => {
    const f = await fixture(true);
    try {
      f.store.transaction(tx => {
        const session = tx.getSession("upstream-session")!;
        tx.updateSessionContext(session.session_id, f.repo, f.repo.replace(/^\/private\/tmp\//, "/tmp/"), new Date().toISOString());
      });
      await expect(f.service.requestTaskDependencyValidation(f.request)).resolves.toMatchObject({ status: "pending_acceptance", version: 4 });
    } finally { f.database.close(); }
  });

  it("serializes concurrent requests and rejects a changed submitted worktree", async () => {
    const f = await fixture();
    try {
      const results = await Promise.allSettled([
        f.service.requestTaskDependencyValidation(f.request),
        f.service.requestTaskDependencyValidation({ ...f.request, operation_id: "concurrent-request" })
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "TASK_VERSION_CONFLICT" } });
      expect(f.store.listDependencyValidationViews(f.upstream)).toHaveLength(1);
      writeFileSync(join(f.repo, "input.txt"), "changed after submission\n");
      await expect(f.service.requestTaskDependencyValidation({ ...f.request, operation_id: "stale", expected_version: 4 })).rejects.toMatchObject({ code: "CHECKPOINT_REQUIRED" });
      expect(f.store.getTaskDetail(f.upstream)).toMatchObject({ status: "pending_acceptance", version: 4 });
    } finally { f.database.close(); }
  });
});
