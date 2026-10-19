import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  archiveProject,
  fetchProjects,
  subscribeTaskChanged,
  unarchiveProject
} from "../../../src/web/api-client.js";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, (event: Event) => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data = "{}"): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data }));
  }

  close(): void {
    this.closed = true;
  }
}

afterEach(() => {
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe("subscribeTaskChanged", () => {
  it("forwards overview changes and connection state to the board", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onTask = vi.fn();
    const onConnection = vi.fn();
    const onOverview = vi.fn();
    const onValidation = vi.fn();
    const onRepair = vi.fn();
    const cancel = subscribeTaskChanged(
      "jande",
      onTask,
      onConnection,
      onOverview,
      onValidation,
      onRepair
    );
    const source = FakeEventSource.instances[0];

    expect(source?.url).toBe("/events?owner=jande");
    source?.onopen?.();
    source?.emit("overview.changed");
    source?.emit("task.changed", JSON.stringify({ task_id: "task-1", version: 2 }));
    source?.emit("dependency_repair.changed", JSON.stringify({
      repair_id: "repair-1",
      validation_id: "validation-1",
      upstream_task_id: "task-1",
      downstream_task_id: "task-2",
      cycle: 2,
      status: "pending"
    }));

    expect(onConnection).toHaveBeenCalledWith(true);
    expect(onOverview).toHaveBeenCalledTimes(1);
    expect(onTask).toHaveBeenCalledWith({ task_id: "task-1", version: 2 });
    expect(onRepair).toHaveBeenCalledWith(expect.objectContaining({
      repair_id: "repair-1",
      cycle: 2,
      status: "pending"
    }));

    cancel();
    expect(source?.closed).toBe(true);
  });
});

describe("project archive requests", () => {
  function stubFetch(status: number, body: unknown) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("requests archived projects only when asked", async () => {
    const fetchMock = stubFetch(200, { projects: [] });
    await fetchProjects("jande", { includeArchived: true });
    await fetchProjects("jande");
    await fetchProjects(undefined, { includeArchived: true });
    expect(fetchMock.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "/api/projects?owner=jande&include_archived=true",
      "/api/projects?owner=jande",
      "/api/projects?include_archived=true"
    ]);
  });

  it("posts archive and unarchive with an operation id", async () => {
    const fetchMock = stubFetch(200, { project: { project_id: "p 1", archived_at: null } });
    await archiveProject("p 1");
    await unarchiveProject("p 1");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([path]) => path)).toEqual([
      "/api/projects/p%201/archive",
      "/api/projects/p%201/unarchive"
    ]);
    for (const [, init] of calls) {
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ operation_id: expect.any(String) });
    }
  });

  it("keeps structured rejection details on the ApiError", async () => {
    stubFetch(409, {
      code: "PROJECT_HAS_OPEN_TASKS",
      message: "still open",
      retryable: false,
      evidence: ["in_progress: 1"],
      recovery_actions: [],
      details: { open_task_counts: { in_progress: 1 }, open_tasks: [] }
    });
    const error = await archiveProject("p").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "PROJECT_HAS_OPEN_TASKS",
      details: { open_task_counts: { in_progress: 1 } }
    });
  });
});
