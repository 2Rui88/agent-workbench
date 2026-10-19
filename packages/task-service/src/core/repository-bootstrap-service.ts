import { randomUUID } from "node:crypto";
import { PlatformDomainError } from "./task-service.js";
import { canonicalRequestHash } from "./operation-fingerprint.js";
import {
  SessionService,
  type SessionContextResult
} from "./session-service.js";
import { RegistryService, type RegisterRepositoryResult } from "./registry-service.js";
import type {
  JsonValue,
  OperationResult,
  ProgressStore,
  ProgressTransaction
} from "../storage/progress-store.js";

export interface RepositoryBootstrapInput {
  transport_session_id: string;
  client_name: string;
  client_version: string;
  protocol_version: string;
  capabilities?: Record<string, unknown>;
  owner: string;
  operation_id: string;
  project_name: string;
  project_id?: string;
  repository_id: string;
  repository_name: string;
  path: string;
  workspace_path: string;
  worktree_path: string;
}

export interface RepositoryBootstrapResult {
  project: RegisterRepositoryResult["project"];
  repository: RegisterRepositoryResult["repository"];
  created_project: boolean;
  session: SessionContextResult;
}

export class RepositoryBootstrapService {
  readonly #store: ProgressStore;
  readonly #sessionService: SessionService;
  readonly #registryService: RegistryService;

  constructor(
    store: ProgressStore,
    sessionService: SessionService,
    registryService: RegistryService
  ) {
    this.#store = store;
    this.#sessionService = sessionService;
    this.#registryService = registryService;
  }

  bootstrapRepository(
    input: RepositoryBootstrapInput,
    now: string
  ): RepositoryBootstrapResult {
    const requestHash = canonicalRequestHash(input);
    return this.#store.transaction((tx) => {
      const existingSession = tx.getSessionByTransportId(input.transport_session_id);
      if (existingSession !== undefined) {
        if (existingSession.successor_session_id !== undefined) {
          throw new PlatformDomainError(
            "SESSION_SUPERSEDED",
            `Session ${existingSession.session_id} was replaced by explicit successor ${existingSession.successor_session_id}`,
            {
              evidence: [existingSession.session_id, existingSession.successor_session_id],
              recovery_actions: ["Continue from the explicit successor session."]
            }
          );
        }
        const cached = tx.getOperationResult(existingSession.session_id, input.operation_id);
        if (cached !== undefined) {
          this.#assertOperationFingerprint(cached, "repository_bootstrap", requestHash);
          return cached.result as unknown as RepositoryBootstrapResult;
        }
        throw new PlatformDomainError(
          "SESSION_CONTEXT_CONFLICT",
          "This transport already has a platform session; bootstrap can only run once",
          {
            evidence: [existingSession.session_id, existingSession.repository_id],
            recovery_actions: ["Call session_context with the existing repository binding."]
          }
        );
      }

      const registration = this.#registryService.registerRepositoryInTransaction(tx, {
        project_name: input.project_name,
        repository_id: input.repository_id,
        repository_name: input.repository_name,
        path: input.path,
        created_by: input.owner,
        ...(input.project_id === undefined ? {} : { project_id: input.project_id })
      });
      const session = this.#sessionService.sessionContextInTransaction(tx, {
        transport_session_id: input.transport_session_id,
        client_name: input.client_name,
        client_version: input.client_version,
        protocol_version: input.protocol_version,
        ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
        workspace_path: input.workspace_path,
        repository_id: input.repository_id,
        worktree_path: input.worktree_path,
        owner: input.owner
      }, now);
      const result: RepositoryBootstrapResult = {
        project: registration.project,
        repository: registration.repository,
        created_project: registration.created_project,
        session
      };
      tx.putOperationResult({
        session_id: session.session_id,
        operation_id: input.operation_id,
        result: result as unknown as JsonValue,
        created_at: now,
        tool_name: "repository_bootstrap",
        request_hash: requestHash
      });
      tx.insertSessionEvent({
        event_id: randomUUID(),
        session_id: session.session_id,
        event_type: "repository_bootstrapped",
        payload: {
          actor: "agent",
          repository_id: input.repository_id,
          owner: input.owner,
          project_id: registration.project.project_id,
          via: "repository_bootstrap"
        },
        created_at: now
      });
      return result;
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
}
