import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { SseHub } from "../../../src/server/sse-hub.js";

function client(): {
  request: Request;
  response: Response;
  frames: string[];
} {
  const request = new EventEmitter() as Request;
  const frames: string[] = [];
  const response = {
    writeHead: vi.fn(),
    write: (frame: string) => {
      frames.push(frame);
      return true;
    }
  } as unknown as Response;
  return { request, response, frames };
}

describe("SseHub dependency validation events", () => {
  it("refreshes both related owners with identifiers only", () => {
    const owners: Record<string, string> = {
      upstream: "owner-upstream",
      downstream: "owner-downstream"
    };
    const hub = new SseHub((taskId) => owners[taskId]);
    const upstreamClient = client();
    const downstreamClient = client();
    const unrelatedClient = client();
    hub.attach(upstreamClient.request, upstreamClient.response, "owner-upstream");
    hub.attach(downstreamClient.request, downstreamClient.response, "owner-downstream");
    hub.attach(unrelatedClient.request, unrelatedClient.response, "owner-other");

    hub.publishDependencyValidationChanged({
      validation_id: "validation-1",
      upstream_task_id: "upstream",
      downstream_task_id: "downstream",
      status: "passed",
      attempt: 2
    });

    for (const frames of [upstreamClient.frames, downstreamClient.frames]) {
      expect(frames).toHaveLength(2); // connection + validation event
      expect(frames[1]).toContain("event: dependency_validation.changed");
      expect(frames[1]).toContain('"validation_id":"validation-1"');
      expect(frames[1]).toContain('"upstream_task_id":"upstream"');
      expect(frames[1]).toContain('"downstream_task_id":"downstream"');
      expect(frames[1]).toContain('"status":"passed"');
      expect(frames[1]).not.toContain("secret");
    }
    expect(unrelatedClient.frames).toHaveLength(1);
  });

  it("sends task changes to project viewers using the authenticated owner", () => {
    const hub = new SseHub({
      resolveTaskOwner: (taskId) => taskId === "creator-task" ? "creator" : "member",
      resolveTaskProjectId: (taskId) => taskId === "creator-task" ? "project-shared" : undefined,
      canViewProject: (projectId, owner) => projectId === "project-shared" && owner === "member"
    });
    const creatorClient = client();
    const memberClient = client();
    const outsiderClient = client();
    hub.attach(creatorClient.request, creatorClient.response, "creator", "creator");
    hub.attach(memberClient.request, memberClient.response, "creator", "member");
    hub.attach(outsiderClient.request, outsiderClient.response, "outsider", "outsider");

    hub.publishTaskChanged({ task_id: "creator-task", version: 4 });

    expect(creatorClient.frames).toHaveLength(2);
    expect(memberClient.frames).toHaveLength(2);
    expect(outsiderClient.frames).toHaveLength(1);
    expect(memberClient.frames[1]).toContain('"task_id":"creator-task"');
  });

  it("publishes repair identity and status without rejection details", () => {
    const owners: Record<string, string> = {
      upstream: "owner-upstream",
      downstream: "owner-downstream"
    };
    const hub = new SseHub((taskId) => owners[taskId]);
    const upstreamClient = client();
    hub.attach(upstreamClient.request, upstreamClient.response, "owner-upstream");

    hub.publishDependencyRepairChanged({
      repair_id: "repair-1",
      validation_id: "validation-1",
      upstream_task_id: "upstream",
      downstream_task_id: "downstream",
      cycle: 2,
      status: "claimed"
    });

    expect(upstreamClient.frames[1]).toContain("event: dependency_repair.changed");
    expect(upstreamClient.frames[1]).toContain('"repair_id":"repair-1"');
    expect(upstreamClient.frames[1]).toContain('"cycle":2');
    expect(upstreamClient.frames[1]).not.toContain("reason");
    expect(upstreamClient.frames[1]).not.toContain("evidence");
  });
});
