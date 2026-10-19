import type { Request, Response } from "express";

export interface TaskChangedEvent {
  task_id: string;
  version: number;
}

export interface DependencyValidationChangedEvent {
  validation_id: string;
  upstream_task_id: string;
  downstream_task_id: string;
  status?: string;
  attempt?: number;
}

export interface DependencyRepairChangedEvent {
  repair_id: string;
  validation_id: string;
  upstream_task_id: string;
  downstream_task_id: string;
  cycle: number;
  status: string;
}

interface SseClient {
  response: Response;
  targetOwner: string;
  principalOwner: string;
}

export interface SseHubOptions {
  resolveTaskOwner?: (taskId: string) => string | undefined;
  resolveTaskProjectId?: (taskId: string) => string | undefined;
  canViewProject?: (projectId: string, owner: string) => boolean;
}

/**
 * Minimal SSE hub for the board. Clients connect on `GET /events`; task
 * mutations publish `task.changed` frames with the exact wire format the
 * plan fixes: an `event:` line, a `data:` JSON line, and a blank line. A
 * project viewer may receive a task event across owners, while the target
 * owner remains the compatibility filter for read-only owner views.
 */
export class SseHub {
  readonly #clients = new Set<SseClient>();
  readonly #resolveTaskOwner: ((taskId: string) => string | undefined) | undefined;
  readonly #resolveTaskProjectId: ((taskId: string) => string | undefined) | undefined;
  readonly #canViewProject: ((projectId: string, owner: string) => boolean) | undefined;

  constructor(options?: SseHubOptions | ((taskId: string) => string | undefined)) {
    if (typeof options === "function") {
      this.#resolveTaskOwner = options;
      return;
    }
    this.#resolveTaskOwner = options?.resolveTaskOwner;
    this.#resolveTaskProjectId = options?.resolveTaskProjectId;
    this.#canViewProject = options?.canViewProject;
  }

  attach(
    request: Request,
    response: Response,
    targetOwner: string,
    principalOwner = targetOwner
  ): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    response.write(": connected\n\n");
    const client: SseClient = { response, targetOwner, principalOwner };
    this.#clients.add(client);
    request.on("close", () => {
      this.#clients.delete(client);
    });
  }

  publishTaskChanged(event: TaskChangedEvent): void {
    const frame = `event: task.changed\ndata: ${JSON.stringify({
      task_id: event.task_id,
      version: event.version
    })}\n\n`;
    const taskOwner = this.#resolveTaskOwner?.(event.task_id);
    const projectId = this.#resolveTaskProjectId?.(event.task_id);
    for (const client of this.#clients) {
      const canViewProject = projectId !== undefined
        && this.#canViewProject?.(projectId, client.principalOwner) === true;
      if (client.targetOwner !== taskOwner && !canViewProject) {
        continue;
      }
      client.response.write(frame);
    }
  }

  /** Broadcast only relationship identifiers and terminal/run state.  The
   * validation contract, progress, reasons, and evidence remain available
   * through the authenticated Board API and are never placed on SSE frames. */
  publishDependencyValidationChanged(event: DependencyValidationChangedEvent): void {
    const frame = `event: dependency_validation.changed\ndata: ${JSON.stringify({
      validation_id: event.validation_id,
      upstream_task_id: event.upstream_task_id,
      downstream_task_id: event.downstream_task_id,
      ...(event.status === undefined ? {} : { status: event.status }),
      ...(event.attempt === undefined ? {} : { attempt: event.attempt })
    })}\n\n`;
    const owners = new Set<string>();
    const upstreamOwner = this.#resolveTaskOwner?.(event.upstream_task_id);
    const downstreamOwner = this.#resolveTaskOwner?.(event.downstream_task_id);
    if (upstreamOwner !== undefined) owners.add(upstreamOwner);
    if (downstreamOwner !== undefined) owners.add(downstreamOwner);
    for (const client of this.#clients) {
      if (owners.has(client.targetOwner)) {
        client.response.write(frame);
      }
    }
  }

  /** Repair frames carry relationship identity and state only. Rejection
   * reasons and validation evidence stay behind the authenticated API. */
  publishDependencyRepairChanged(event: DependencyRepairChangedEvent): void {
    const frame = `event: dependency_repair.changed\ndata: ${JSON.stringify({
      repair_id: event.repair_id,
      validation_id: event.validation_id,
      upstream_task_id: event.upstream_task_id,
      downstream_task_id: event.downstream_task_id,
      cycle: event.cycle,
      status: event.status
    })}\n\n`;
    const owners = new Set<string>();
    const upstreamOwner = this.#resolveTaskOwner?.(event.upstream_task_id);
    const downstreamOwner = this.#resolveTaskOwner?.(event.downstream_task_id);
    if (upstreamOwner !== undefined) owners.add(upstreamOwner);
    if (downstreamOwner !== undefined) owners.add(downstreamOwner);
    for (const client of this.#clients) {
      if (owners.has(client.targetOwner)) {
        client.response.write(frame);
      }
    }
  }

  publishOverviewChanged(): void {
    const frame = "event: overview.changed\ndata: {}\n\n";
    for (const client of this.#clients) {
      client.response.write(frame);
    }
  }

  clientCount(): number {
    return this.#clients.size;
  }
}
