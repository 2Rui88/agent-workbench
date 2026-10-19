import { CoordinatorError } from './errors.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CoordinatorStore } from './store.js';
import { ContractRegistry } from './contracts.js';
import { ValidationRegistry } from './validation.js';
import { OperationLedger } from './operations.js';
import type { Actor } from './protocol.js';
import { roleEnum } from './roles.js';

const role = roleEnum;
export const commandEvidence = z.object({ command: z.string().min(1), outcome: z.enum(['passed','failed','not_run']), summary: z.string().min(1) }).strict();
export const collaborationSchemas = {
  automation_message_send: z.object({ type: z.enum(['assistance_request','contract_update','test_debug','dispute','arbitration_suggested']), recipientRole: role, payload: z.record(z.string(),z.unknown()), operationId: z.string().min(1) }).strict(),
  automation_message_claim: z.object({ leaseMs: z.number().int().min(1000).max(300000).default(60000) }).strict(),
  automation_message_complete: z.object({ messageId: z.string().min(1), leaseToken: z.string().min(1), result: z.object({ summary: z.string().min(1), evidence: z.array(z.string().min(1)).min(1) }).strict() }).strict(),
  automation_message_renew: z.object({ messageId: z.string().min(1), leaseToken: z.string().min(1), leaseMs: z.number().int().min(1000).max(300000).default(60000) }).strict(),
  automation_contract_publish: z.object({ artifactRef: z.string().min(1), revision: z.string().min(1), digest: z.string().min(1), baselineRef: z.string().min(1), compatibility: z.enum(['compatible','breaking']), affectedRoles: z.array(role), operationId: z.string().min(1) }).strict(),
  automation_contract_ack: z.object({ contractId: z.string().min(1), revision: z.string().min(1) }).strict(),
  automation_validation_create: z.object({ contractRef: z.string().min(1), baselineRef: z.string().min(1), operationId: z.string().min(1) }).strict(),
  automation_validation_record: z.object({ validationId: z.string().min(1), outcome: z.enum(['passed','rejected','error']), evidence: z.array(commandEvidence).min(1) }).strict(),
  automation_events: z.object({ afterSequence: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(100) }).strict(),
  automation_operation_get: z.object({ operationId: z.string().min(1) }).strict()
};
export type CollaborationCommand = keyof typeof collaborationSchemas;
export class CollaborationService {
  readonly validations: ValidationRegistry;
  readonly operations: OperationLedger;
  constructor(path: string, private readonly store: CoordinatorStore, private readonly contracts: ContractRegistry, private readonly suggestAfterRejections = 2) { this.validations = new ValidationRegistry(path); this.operations = new OperationLedger(path); }
  close(): void { this.operations.close(); this.validations.close(); }
  async execute(actor: Actor, command: CollaborationCommand, raw: unknown): Promise<unknown> {
    switch (command) {
      case 'automation_message_send': {
        const { operationId, ...input } = collaborationSchemas[command].parse(raw);
        if (input.payload.kind === 'execution_package') throw new CoordinatorError('FORBIDDEN', 'Execution packages require lead dispatch.', 'Use automation_dispatch after task and runtime binding checks.');
        if (input.type === 'arbitration_suggested') throw new CoordinatorError('FORBIDDEN', 'Arbitration suggestions are issued by the coordinator.', 'Send a dispute to lead instead.');
        if (input.type !== 'dispute') return this.store.send(actor, input, operationId);
        const run = typeof input.payload.validationId === 'string' ? this.validations.get(input.payload.validationId) : undefined;
        if (input.recipientRole !== 'lead' || !run || run.groupId !== actor.groupId || run.state !== 'rejected') throw new CoordinatorError('INVALID_INPUT', 'A dispute must go to lead and reference a rejected validation.', 'Attach the rejected validationId.');
        const message = this.store.send(actor, input, operationId);
        this.store.send(actor, { type: 'arbitration_suggested', recipientRole: 'lead', payload: { kind: 'arbitration_suggested', reason: 'dispute', contractRef: run.contractRef, validationIds: [run.validationId], disputeMessageId: message.messageId } }, `${operationId}:arbitration`);
        return message;
      }
      case 'automation_message_claim': return this.store.claim(actor,randomUUID(),collaborationSchemas[command].parse(raw).leaseMs,true) ?? { empty: true };
      case 'automation_message_complete': { const input = collaborationSchemas[command].parse(raw); this.store.complete(actor,input.messageId,input.leaseToken,input.result); return { ok: true }; }
      case 'automation_message_renew': { const input = collaborationSchemas[command].parse(raw); return { expiresAt: this.store.renew(actor,input.messageId,input.leaseToken,input.leaseMs) }; }
      case 'automation_contract_publish': { const { operationId, ...input } = collaborationSchemas[command].parse(raw); return this.operations.run(actor,command,operationId,input,() => this.contracts.publish(actor,input)); }
      case 'automation_contract_ack': { const input = collaborationSchemas[command].parse(raw); this.contracts.ack(actor,input.contractId,input.revision); return { ok: true }; }
      case 'automation_validation_create': { const input = collaborationSchemas[command].parse(raw); return this.operations.run(actor,command,input.operationId,input,() => this.validations.create(actor,input.contractRef,input.baselineRef)); }
      case 'automation_validation_record': {
        const input = collaborationSchemas[command].parse(raw);
        const run = this.validations.record(actor, input.validationId, input.outcome, input.evidence);
        if (run.state === 'rejected') {
          const streak = this.validations.consecutiveRejections(actor.groupId, run.contractRef);
          if (streak.length >= this.suggestAfterRejections) this.store.send(actor, { type: 'arbitration_suggested', recipientRole: 'lead', payload: { kind: 'arbitration_suggested', reason: 'consecutive_rejections', contractRef: run.contractRef, validationIds: streak } }, `arbitration:${run.validationId}`);
        }
        return run;
      }
      case 'automation_events': { const input = collaborationSchemas[command].parse(raw); return this.store.events(actor.groupId,input.afterSequence,input.limit); }
      case 'automation_operation_get': { const operation = this.operations.get(actor,collaborationSchemas[command].parse(raw).operationId); return operation ? { command: operation.command, state: operation.state, result: operation.result_json ? JSON.parse(operation.result_json) : null } : { state: 'not_found' }; }
    }
  }
}
