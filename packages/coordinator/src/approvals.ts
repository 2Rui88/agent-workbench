import { randomUUID, timingSafeEqual } from 'node:crypto';
import { CoordinatorError } from './errors.js';
import type { Actor } from './protocol.js';

export interface HumanCapability { readonly id: string; }
export interface ApprovalRequest { id: string; runtimeRequestId: string; groupId: string; roleId: string; state: 'waiting_human'; request: unknown; createdAt: string; }

export class HumanApprovalGate {
  private readonly requests = new Map<string, ApprovalRequest>();
  constructor(private readonly humanCapability: HumanCapability) {}

  request(actor: Actor, runtimeRequestId: string, request: unknown): ApprovalRequest {
    const item: ApprovalRequest = { id: randomUUID(), runtimeRequestId, groupId: actor.groupId, roleId: actor.roleId, state: 'waiting_human', request, createdAt: new Date().toISOString() };
    this.requests.set(item.id, item);
    return item;
  }

  list(): ApprovalRequest[] { return [...this.requests.values()].filter((request) => request.state === 'waiting_human'); }

  respond(requestId: string, capability: HumanCapability, decision: unknown): { runtimeRequestId: string; decision: unknown } {
    const request = this.requests.get(requestId);
    if (!request || !this.isHuman(capability)) throw new CoordinatorError('FORBIDDEN', 'Only the independent human capability can resolve approval requests.', 'Use the human control channel for this decision.');
    this.requests.delete(requestId);
    return { runtimeRequestId: request.runtimeRequestId, decision };
  }

  private isHuman(capability: HumanCapability): boolean {
    const expected = Buffer.from(this.humanCapability.id);
    const actual = Buffer.from(capability?.id ?? '');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
