import { resolve } from 'node:path';
import { ExternalLead } from './external-lead.js';
import { RuntimeJournal } from './terminal/runtime-journal.js';
import { assertRealExecution, receiptDeadlineMs, type RealExecutionGrant } from './real-execution.js';
import { observeThread } from './runtime/thread-state.js';
import { bindingSchema } from './bindings.js';
import { BrowserService,browserSchemas,type BrowserSettings,type BrowserCommand } from './browser/service.js';
import { ExecutionBudget, type MockBudget } from './budget.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CollaborationService, collaborationSchemas, type CollaborationCommand } from './collaboration.js';
import { CoordinatorStore } from './store.js';
import { DurableScheduler } from './durable-scheduler.js';
import type { DispatchLease } from './durable-scheduler.js';
import { ContractRegistry } from './contracts.js';
import { WorkDispatcher } from './dispatch.js';
import { ApprovalBridge } from './approval-bridge.js';
import { CoordinatorError } from './errors.js';
import { assertSupportedModelChoice } from './config.js';
import { resolveAuthorizedPath } from './auth.js';
import type { Actor, RoleId } from './protocol.js';
import { agentEnum, roleEnum, type AgentKind } from './roles.js';
import { TurnUsageLedger } from './runtime/turn-usage.js';
import { AdviceRegistry, adviceSchemas, buildAdvicePackage } from './advice.js';
import type { ExecutionPackage } from './scheduler.js';
import type { TaskAuthority, TaskBinding } from './integrations/adapters.js';
import type { ManagedRuntime, Runtime, RuntimeEvent } from './runtime/types.js';

const roleSchema = roleEnum;
export { bindingSchema } from './bindings.js';
export const workSchema = z.object({ id: z.string().min(1), roleId: roleSchema, goal: z.string().min(1), taskRef: z.string().min(1), repository: z.string().min(1), worktree: z.string().min(1), allowedPaths: z.array(z.string()).min(1), baseline: z.string().min(1), contractRef: z.string().min(1), contractRevision: z.string().min(1), acceptanceCriteria: z.array(z.string()).min(1), verificationCommands: z.array(z.string()).min(1), replacesDispatchId: z.string().min(1).optional(), dependencies: z.array(z.string()), risk: z.number().min(0).max(10), evidenceFailures: z.number().int().min(0), paused: z.boolean().default(false) }).strict();
export const automationSchemas = {
  ...collaborationSchemas,
  ...browserSchemas,
  ...adviceSchemas,
  automation_submit_for_acceptance: z.object({binding:bindingSchema,dispatchIds:z.array(z.string().min(1)).min(1),validationId:z.string().min(1),contractRef:z.string().min(1),baselineRef:z.string().min(1),operationId:z.string().min(1)}).strict(),
  automation_task_recover:z.object({binding:bindingSchema,operationId:z.string().min(1)}).strict(),
  automation_task_checkpoint:z.object({binding:bindingSchema,operationId:z.string().min(1),checkpoint:z.record(z.string(),z.unknown())}).strict(),
  automation_task_operation_result:z.object({binding:bindingSchema,operationId:z.string().min(1)}).strict(),
  automation_lead_configure:z.object({binding:bindingSchema,work:workSchema.extend({roleId:z.literal('lead')}),operationId:z.string().min(1)}).strict(),
  automation_status: z.object({}).strict(),
  automation_lead_heartbeat: z.object({ sessionRef: z.string().min(1).max(128), cwd: z.string().min(1), agent: agentEnum.optional() }).strict(),
  automation_lead_release: z.object({ sessionRef: z.string().min(1).max(128) }).strict(),
  automation_role_initialize: z.object({ cwd: z.string().min(1) }).strict(),
  automation_dispatch: z.object({ binding: bindingSchema, work: workSchema, operationId: z.string().min(1) }).strict(),
  automation_work_complete: z.object({ dispatchId: z.string().min(1), summary: z.string().min(1), evidence: z.array(z.string().min(1)).min(1) }).strict(),
  automation_pause: z.object({ paused: z.boolean() }).strict(),
  automation_model_refresh:z.object({binding:bindingSchema,dispatchId:z.string().min(1)}).strict(),
  automation_archive_failure: z.object({binding:bindingSchema,dispatchId:z.string().min(1),reason:z.enum(['interrupted','runtime_failed']),evidence:z.string().min(8),operationId:z.string().min(1)}).strict(),
  automation_cancel_queued: z.object({ dispatchId: z.string().min(1), evidence: z.string().min(8), operationId: z.string().min(1) }).strict(),
  automation_reconcile: z.object({ dispatchId: z.string(), outcome: z.enum(['not_started', 'started', 'completed', 'unknown']), evidence: z.string().min(8), turnId: z.string().optional(), receipt:z.object({summary:z.string().min(1),evidence:z.array(z.string().min(1)).min(1)}).strict().optional() }).strict()
};
export type AutomationCommand = keyof typeof automationSchemas;
interface InitializedRole { actor: Actor; cwd: string; threadId: string; instanceId: string; handle: ManagedRuntime; }
interface ActiveRun { actor: Actor; lease: DispatchLease; messageToken: string; }
interface ObservableRuntime extends Runtime { onEvent?(listener: (event: RuntimeEvent) => void): () => void; onServerRequest?(listener: (event: RuntimeEvent) => void): () => void; respondToServerRequest?(id: string | number, result: unknown): Promise<void>; }
export interface EngineOptions {
  databasePath: string; groupId: string; allowedRoots: string[]; humanCapability: string;
  runtimeSource: 'mock' | 'app_server'; runtimeFactory: (role: RoleId, cwd: string) => ManagedRuntime;
  taskAuthority: TaskAuthority; receiptTimeoutMs?:number; mockBudget?: MockBudget; browser?: BrowserSettings;
  verifyWorker?: (work:ExecutionPackage)=>Promise<void>;
  leadMode?: 'managed' | 'external';
  realExecution?: RealExecutionGrant;
  agentFor?: (role: RoleId) => AgentKind;
  advisor?: { suggestAfterRejections: number };
}

export class CoordinatorEngine {
  readonly store: CoordinatorStore;
  readonly scheduler: DurableScheduler;
  readonly approvals: ApprovalBridge;
  readonly budget: ExecutionBudget;
  readonly advisorBudget: ExecutionBudget;
  readonly browser: BrowserService;
  private readonly externalLead: ExternalLead;
  private readonly terminalJournal: RuntimeJournal;
  private readonly usage: TurnUsageLedger;
  private readonly contracts: ContractRegistry;
  readonly collaboration: CollaborationService;
  readonly advice: AdviceRegistry;
  private readonly roles = new Map<RoleId, InitializedRole>();
  private readonly initializing = new Map<RoleId,Promise<unknown>>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly turnChecks = new Map<string, number>();
  private readonly deadlines = new Map<string, NodeJS.Timeout>();
  private readonly blocks = new Map<RoleId, string>();
  private pumping = false;
  private closing = false;
  private onIdle?: () => void;
  get databasePath(): string { return this.options.databasePath; }
  get groupId(): string { return this.options.groupId; }
  constructor(private readonly options: EngineOptions) {
    this.store = new CoordinatorStore(options.databasePath);
    this.externalLead = new ExternalLead(options.databasePath, options.groupId);
    this.terminalJournal = new RuntimeJournal(options.databasePath);
    this.usage = new TurnUsageLedger(options.databasePath);
    this.browser = new BrowserService(options.databasePath,options.groupId,options.taskAuthority,options.browser);
    this.budget = new ExecutionBudget(options.databasePath, options.groupId, options.runtimeSource === 'app_server' ? { maxCalls: options.realExecution?.maxCalls ?? 0, maxConcurrent: options.realExecution?.maxConcurrent ?? 1 } : options.mockBudget ?? { maxCalls: 100, maxConcurrent: 4 }, options.runtimeSource, options.realExecution?.authorizationRef);
    this.advisorBudget = new ExecutionBudget(options.databasePath, options.groupId, options.runtimeSource === 'app_server' ? { maxCalls: options.realExecution?.advisor?.maxCalls ?? 0, maxConcurrent: 1 } : options.mockBudget ?? { maxCalls: 100, maxConcurrent: 4 }, options.runtimeSource === 'app_server' ? 'advisor' : 'mock_advisor', options.realExecution?.authorizationRef);
    this.scheduler = new DurableScheduler(options.databasePath);
    this.contracts = new ContractRegistry(options.databasePath);
    this.approvals = new ApprovalBridge(options.databasePath, options.humanCapability);
    this.collaboration = new CollaborationService(options.databasePath,this.store,this.contracts,options.advisor?.suggestAfterRejections ?? 2);
    this.advice = new AdviceRegistry(options.databasePath);
    this.observeRuntime();
  }
  recoverAfterRestart(): void {
    if (this.active.size || this.roles.size) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Recovery must precede runtime initialization.', 'Recover through the owned daemon startup.');
    this.scheduler.recoverAfterRestart(this.options.groupId);
    this.store.fenceExecutionGroup(this.options.groupId); this.budget.recover(); this.advisorBudget.recover(); this.browser.recover();
  }

  authenticate(roleId: RoleId, capability: string, generation: number): Actor {
    const actor: Actor = { groupId: this.options.groupId, roleId, bindingGeneration: generation, capabilityId: capability };
    this.store.assertAuthorized(actor, capability); return actor;
  }
  async execute(actor: Actor, command: AutomationCommand, input: unknown): Promise<unknown> {
    if(this.closing)throw new CoordinatorError('SERVICE_UNHEALTHY','Coordinator is stopping.','Reconnect after shutdown.');
    if (actor.groupId !== this.options.groupId) throw new CoordinatorError('FORBIDDEN', 'Group does not match this coordinator.', 'Use the configured role connection.');
    this.store.assertAuthorized(actor, actor.capabilityId);
    const schema = automationSchemas[command];
    if (!schema) throw new CoordinatorError('COMMAND_NOT_FOUND', 'Unknown automation command.', 'Inspect the command schema.');
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new CoordinatorError('INVALID_INPUT', 'Command input does not match its schema.', 'Use the published strict command schema.');
    if (command in browserSchemas) return this.browser.execute(actor,command as BrowserCommand,parsed.data);
    if (command in collaborationSchemas) return this.collaboration.execute(actor,command as CollaborationCommand,parsed.data);
    switch (command) {
      case 'automation_lead_heartbeat': {
        if (this.options.leadMode !== 'external' || actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'External presence requires the external lead connection.', 'Use the configured lead mode.');
        const input = automationSchemas.automation_lead_heartbeat.parse(parsed.data);
        const cwd = await resolveAuthorizedPath(input.cwd, this.options.allowedRoots);
        this.externalLead.heartbeat(actor, input.sessionRef, cwd, input.agent ?? null);
        this.scheduler.heartbeat(actor);
        this.observeRuntime();
        return { mode: 'external', sessionRef: input.sessionRef, expiresAt: new Date(this.externalLead.snapshot()!.expires_at).toISOString(), turnStarted: false };
      }
      case 'automation_lead_release': {
        if (this.options.leadMode !== 'external' || actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'External presence requires the external lead connection.', 'Use the configured lead mode.');
        const input = automationSchemas.automation_lead_release.parse(parsed.data);
        return { released: this.externalLead.release(actor, input.sessionRef) };
      }
      case 'automation_status': return { source: this.options.runtimeSource, blocks: Object.fromEntries(this.blocks), budget: this.budget.status(), advisorBudget: this.advisorBudget.status(), group: this.store.groupSnapshot(actor.groupId), dispatches: this.scheduler.list(actor.groupId), approvals: this.approvals.list(actor.groupId).map(({ params: _params, runtimeRequestId: _requestId, ...item }) => item) };
      case 'automation_role_initialize': return this.initialize(actor, (parsed.data as { cwd: string }).cwd);
      case 'automation_task_recover':
      case 'automation_task_checkpoint':
      case 'automation_task_operation_result': {
        if(actor.roleId!=='lead')throw new CoordinatorError('FORBIDDEN','Only lead can coordinate repository Task operations.','Send repository progress to lead.');
        const request=parsed.data as {binding:TaskBinding;operationId:string;checkpoint?:unknown};
        const cwd=await resolveAuthorizedPath(request.binding.worktreePath,this.options.allowedRoots);
        const binding={...request.binding,worktreePath:cwd};
        const authority=this.options.taskAuthority;
        if(command==='automation_task_operation_result'){
          if(!authority.operationResult)throw new CoordinatorError('TASK_GATE_CLOSED','Authoritative operation lookup is unavailable.','Configure the repository Task client.');
          return authority.operationResult(binding,request.operationId);
        }
        if((command==='automation_task_recover'&&!authority.recover)||(command==='automation_task_checkpoint'&&!authority.checkpointTask))throw new CoordinatorError('TASK_GATE_CLOSED','Requested repository Task adapter is unavailable.','Configure repository-bound recovery and checkpoint adapters.');
        return this.collaboration.operations.run(actor,command,request.operationId,request,()=>command==='automation_task_recover'?authority.recover!(binding,request.operationId):authority.checkpointTask!(binding,request.operationId,request.checkpoint));
      }
      case 'automation_lead_configure': {
        if (this.options.leadMode === 'external') throw new CoordinatorError('FORBIDDEN', 'External lead does not run automatic model wakes.', 'Route coordination messages to the host lead session.');
        if(actor.roleId!=='lead')throw new CoordinatorError('FORBIDDEN','Only lead can configure automatic wake.','Use the lead connection.');
        const request=automationSchemas.automation_lead_configure.parse(parsed.data);
        const replay=this.collaboration.operations.replay(actor,command,request.operationId,request);
        if(replay.found)return replay.result;
        const role=this.roles.get('lead');
        const cwd=await resolveAuthorizedPath(request.work.worktree,this.options.allowedRoots);
        const bindingCwd=await resolveAuthorizedPath(request.binding.worktreePath,this.options.allowedRoots);
        if(!role||cwd!==role.cwd||bindingCwd!==cwd||request.work.taskRef!==request.binding.taskRef||request.work.repository!==request.binding.repositoryId)throw new CoordinatorError('TASK_GATE_CLOSED','Lead wake must match the initialized repository and task.','Initialize lead and provide its exact task binding.');
        const allowedPaths=await Promise.all(request.work.allowedPaths.map((path)=>resolveAuthorizedPath(resolve(cwd,path),[cwd])));
        await this.options.taskAuthority.checkGate(request.binding);
        this.contracts.assertUsable(actor.groupId,'lead',request.work.contractRef,request.work.contractRevision);
        return this.collaboration.operations.run(actor,command,request.operationId,request,()=>{
          this.store.configureLeadWake(actor,{...request,binding:{...request.binding,worktreePath:cwd},work:{...request.work,worktree:cwd,allowedPaths}});
          return{configured:true,source:this.options.runtimeSource,realTurnsEnabled:false};
        });
      }
      case 'automation_dispatch': {
        if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only lead can dispatch work.', 'Send the requirement to lead.');
        const request = parsed.data as { binding: TaskBinding; work: ExecutionPackage; operationId: string };
        const role = this.roles.get(request.work.roleId);
        if (!role) throw new CoordinatorError('TASK_GATE_CLOSED', 'Target role is not initialized.', 'Initialize its runtime and project identity.');
        const cwd = await resolveAuthorizedPath(request.work.worktree, this.options.allowedRoots);
        const bindingCwd = await resolveAuthorizedPath(request.binding.worktreePath, this.options.allowedRoots);
        if (cwd !== role.cwd || bindingCwd !== cwd) throw new CoordinatorError('TASK_GATE_CLOSED', 'Execution worktree does not match the target runtime.', 'Initialize the target role for this worktree.');
        const allowedPaths=await Promise.all(request.work.allowedPaths.map((path)=>resolveAuthorizedPath(resolve(cwd,path),[cwd])));
        this.contracts.assertUsable(actor.groupId, request.work.roleId, request.work.contractRef, request.work.contractRevision!);
        await this.options.verifyWorker?.({...request.work,worktree:cwd,taskBinding:{...request.binding,worktreePath:cwd}});
        const choice = this.options.runtimeSource === 'app_server' && request.work.roleId !== 'lead' ? this.options.realExecution?.choices[request.work.roleId] : undefined;
        const dispatcher = new WorkDispatcher(this.store, this.options.taskAuthority, this.scheduler, choice);
        return dispatcher.dispatch(actor, { ...request.binding, worktreePath: cwd }, { ...request.work, worktree: cwd,allowedPaths, agent: this.options.agentFor?.(request.work.roleId) ?? 'codex' }, await role.handle.runtime.listModels(), request.operationId);
      }
      case 'automation_advice_request': {
        if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only lead can request advice.', 'Send the question to lead.');
        const request = adviceSchemas.automation_advice_request.parse(parsed.data);
        const replay = this.collaboration.operations.replay(actor, command, request.operationId, request);
        if (replay.found) return replay.result;
        const role = this.roles.get('advisor');
        if (!role) throw new CoordinatorError('TASK_GATE_CLOSED', 'Advisor role is not initialized.', 'Initialize the advisor runtime and identity.');
        const cwd = await resolveAuthorizedPath(request.binding.worktreePath, this.options.allowedRoots);
        if (cwd !== role.cwd) throw new CoordinatorError('TASK_GATE_CLOSED', 'Advisor worktree does not match the request binding.', 'Initialize the advisor in the lead worktree.');
        if (request.kind === 'arbitration' && request.refs.validationIds.length === 0) throw new CoordinatorError('INVALID_INPUT', 'Arbitration must reference the disputed validation.', 'Attach the rejected validationId.');
        for (const validationId of request.refs.validationIds) { const run = this.collaboration.validations.get(validationId); if (!run || run.groupId !== actor.groupId) throw new CoordinatorError('INVALID_INPUT', 'Referenced validation is unknown.', 'Use validation IDs from this group.'); }
        const workers = request.refs.dispatchIds.map((dispatchId) => { const work = this.scheduler.get(dispatchId); if (!work || work.groupId !== actor.groupId) throw new CoordinatorError('INVALID_INPUT', 'Referenced dispatch is unknown.', 'Use dispatch IDs from this group.'); return (work as { agent?: AgentKind }).agent ?? 'codex'; });
        const agentOf = (roleId: RoleId): AgentKind => this.options.agentFor?.(roleId) ?? 'codex';
        const agents = { advisor: agentOf('advisor'), worker: [...new Set(workers)], audit: request.refs.validationIds.length ? [agentOf('audit')] : [] };
        const sameSource = agents.worker.length + agents.audit.length > 0 && new Set([agents.advisor, ...agents.worker, ...agents.audit]).size === 1;
        return this.collaboration.operations.run(actor, command, request.operationId, request, async () => {
          const adviceId = randomUUID();
          const binding = { ...request.binding, worktreePath: cwd };
          const work = { ...buildAdvicePackage({ adviceId, kind: request.kind, question: request.question, refs: request.refs, binding }), agent: agents.advisor };
          this.contracts.assertUsable(actor.groupId, 'advisor', work.contractRef, work.contractRevision!);
          const dispatcher = new WorkDispatcher(this.store, this.options.taskAuthority, this.scheduler, this.options.runtimeSource === 'app_server' ? this.options.realExecution?.choices.advisor : undefined);
          const result = await dispatcher.dispatch(actor, binding, work, await role.handle.runtime.listModels(), `${request.operationId}:dispatch`);
          this.advice.create({ adviceId, groupId: actor.groupId, dispatchId: result.message.messageId, kind: request.kind, question: request.question, refs: request.refs, state: 'requested', agents, sameSource, createdAt: new Date().toISOString() });
          return { adviceId, dispatchId: result.message.messageId, state: 'requested', sameSource };
        });
      }
      case 'automation_advice_complete': {
        if (actor.roleId !== 'advisor') throw new CoordinatorError('FORBIDDEN', 'Only the advisor can complete advice.', 'Use the advisor connection.');
        const { adviceId, ...result } = adviceSchemas.automation_advice_complete.parse(parsed.data);
        const record = this.advice.get(adviceId);
        if (!record || record.groupId !== actor.groupId) throw new CoordinatorError('INVALID_INPUT', 'Advice request is unknown.', 'Use the adviceId from the execution package.');
        this.advice.complete(adviceId, { ...result, completedAt: new Date().toISOString() });
        const outcome = await this.completeReceipt(actor, { dispatchId: record.dispatchId, summary: result.recommendation, evidence: result.evidenceRefs });
        if (outcome.status === 'completed') this.store.send(actor, { type: 'test_debug', recipientRole: 'lead', payload: { kind: 'advice_ready', adviceId, adviceKind: record.kind, sameSource: record.sameSource } }, `advice-ready:${adviceId}`);
        return outcome;
      }
      case 'automation_advice_get': {
        if (actor.roleId !== 'lead' && actor.roleId !== 'advisor') throw new CoordinatorError('FORBIDDEN', 'Advice is visible to lead and advisor only.', 'Ask lead for the advice outcome.');
        const record = this.advice.get(adviceSchemas.automation_advice_get.parse(parsed.data).adviceId);
        if (!record || record.groupId !== actor.groupId) throw new CoordinatorError('INVALID_INPUT', 'Advice request is unknown.', 'Use an adviceId from this group.');
        return record;
      }
      case 'automation_advice_resolve': {
        if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only lead records advice decisions.', 'Use the lead connection.');
        const request = adviceSchemas.automation_advice_resolve.parse(parsed.data);
        return this.collaboration.operations.run(actor, command, request.operationId, request, () => this.advice.resolve(request.adviceId, { decision: request.decision, note: request.note, resolvedAt: new Date().toISOString() }));
      }
      case 'automation_work_complete': return this.completeReceipt(actor, parsed.data as { dispatchId: string; summary: string; evidence: string[] });
      case 'automation_submit_for_acceptance': {
        if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN','Only lead can submit verified task work.','Send the verification package to lead.');
        const request=automationSchemas.automation_submit_for_acceptance.parse(parsed.data);
        const replay=this.collaboration.operations.replay(actor,command,request.operationId,request);
        if(replay.found)return replay.result;
        const run=this.collaboration.validations.get(request.validationId);
        const latest=this.collaboration.validations.latest(actor.groupId,request.contractRef);
        const work=this.scheduler.list(actor.groupId).filter((item)=>item.taskRef===request.binding.taskRef && item.state !== 'cancelled');
        const included=work.filter((item)=>request.dispatchIds.includes(item.dispatchId));
        if (!run || run.groupId!==actor.groupId || latest?.validationId!==run.validationId || run.state!=='passed' || run.contractRef!==request.contractRef || run.baselineRef!==request.baselineRef || new Set(request.dispatchIds).size!==request.dispatchIds.length || included.length!==request.dispatchIds.length || work.some((item)=>item.state!=='completed' && !(item.state==='failed' && this.failureRetired(item.dispatchId,work,request.dispatchIds,request.contractRef,request.baselineRef))) || included.some((item)=>item.state!=='completed'||item.contractRef!==request.contractRef||item.baseline!==request.baselineRef) || !included.some((item)=>item.roleId==='audit')) throw new CoordinatorError('TASK_GATE_CLOSED','Submission needs completed dispatches and the latest passed audit for this baseline.','Finish or reconcile every task dispatch and audit the exact current contract and baseline.');
        this.contracts.assertUsable(actor.groupId,'audit',request.contractRef,included[0]!.contractRevision!);
        await this.options.taskAuthority.checkGate(request.binding);
        if (!this.options.taskAuthority.submit) throw new CoordinatorError('TASK_GATE_CLOSED','Task submission adapter is unavailable.','Configure the repository-bound Task adapter.');
        return this.collaboration.operations.run(actor,command,request.operationId,request,async()=>{
          const submitted=await this.options.taskAuthority.submit!(request.binding,{expectedVersion:request.binding.expectedVersion,operationId:request.operationId,verification:run.evidence});
          if (!submitted.ok||submitted.status!=='pending_acceptance') throw new CoordinatorError('RECONCILIATION_REQUIRED','Submission did not yield pending acceptance.','Read the authoritative Task operation result.');
          return {...submitted,source:this.options.runtimeSource,finalAcceptance:'human_only'};
        });
      }
      case 'automation_pause': this.scheduler.pause(actor, (parsed.data as { paused: boolean }).paused); return { ok: true };
      case 'automation_cancel_queued': {
        if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only lead may cancel queued work.', 'Send cancellation evidence to the host lead.');
        const request = automationSchemas.automation_cancel_queued.parse(parsed.data);
        return this.collaboration.operations.run(actor,command,request.operationId,request,() => {
          this.scheduler.cancelQueued(actor,request.dispatchId,request.evidence);
          this.observeRuntime();
          return {status:'cancelled',dispatchId:request.dispatchId,finalAcceptance:'human_only'};
        });
      }
      case 'automation_model_refresh': {
        if(actor.roleId!=='lead')throw new CoordinatorError('FORBIDDEN','Only host lead can refresh historical model evidence.','Request original runtime verification from lead.');
        const request=automationSchemas.automation_model_refresh.parse(parsed.data);
        const work=this.scheduler.get(request.dispatchId);const role=work&&this.roles.get(work.roleId);
        if(!work||!role||work.groupId!==actor.groupId||work.taskRef!==request.binding.taskRef||work.repository!==request.binding.repositoryId||work.worktree!==request.binding.worktreePath)throw new CoordinatorError('TASK_GATE_CLOSED','Model refresh does not match the original task runtime.','Refresh the Task binding and initialize its role.');
        await this.options.taskAuthority.checkGate(request.binding);
        if(!work.turnId)return{status:'not_started',model:null};
        await role.handle.runtime.readThread(role.threadId);
        const evidence=await role.handle.runtime.readTurnModel?.(role.threadId,work.turnId);
        if(evidence)this.scheduler.recordModel(role.actor,work.dispatchId,role.threadId,work.turnId,evidence);
        return{status:evidence?'runtime_confirmed':'unconfirmed',model:evidence?.model??null,effort:evidence?.effort??null,source:evidence?.source??null};
      }
      case 'automation_archive_failure': {
        if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only lead can archive failed executions.', 'Send original terminal evidence to lead.');
        const request = automationSchemas.automation_archive_failure.parse(parsed.data);
        const dispatch = this.scheduler.get(request.dispatchId);
        const owner = dispatch && this.roles.get(dispatch.roleId);
        if (!dispatch || dispatch.groupId !== actor.groupId || !owner || !dispatch.turnId || dispatch.taskRef !== request.binding.taskRef || dispatch.repository !== request.binding.repositoryId || dispatch.worktree !== request.binding.worktreePath || owner.cwd !== dispatch.worktree || (dispatch.taskBinding && dispatch.taskBinding.owner !== request.binding.owner)) throw new CoordinatorError('TASK_GATE_CLOSED', 'Failure archive must match the original task worktree and runtime.', 'Initialize the owning role and refresh the task binding.');
        await this.options.taskAuthority.checkGate(request.binding);
        const replay = this.collaboration.operations.replay(actor,command,request.operationId,request);
        if (replay.found) return replay.result;
        const originalThread = this.scheduler.executionThread(request.dispatchId);
        if (!originalThread || originalThread !== owner.threadId) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Original execution thread identity cannot be proved.', 'Inspect original execution evidence without substituting another runtime.');
        const raw = await owner.handle.runtime.readThread(owner.threadId);
        const observed = observeThread(raw,owner.threadId);
        const terminal = observed.turns.find(turn=>turn.id===dispatch.turnId);
        const expected = request.reason === 'interrupted' ? 'interrupted' : 'failed';
        const header = ((raw as {thread?:unknown}).thread ?? raw) as {status?:unknown};
        const status = typeof header.status === 'string' ? header.status : (header.status as {type?:string}|undefined)?.type;
        if (terminal?.status !== expected || observed.turns.some(turn=>['inProgress','in_progress','running','started'].includes(turn.status)) || ['active','inProgress','in_progress','running'].includes(status??'')) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Runtime has not confirmed a terminal failed execution with no live turn.', 'Keep uncertain work fenced.');
        return this.collaboration.operations.run(actor,command,request.operationId,request,()=>{
          this.scheduler.archiveFailure(actor,request.dispatchId,request.reason,request.evidence,dispatch.turnId!);
          this.active.delete(request.dispatchId); this.clearDeadline(request.dispatchId); this.blocks.delete(dispatch.roleId);
          this.observeRuntime();
          return {status:'failed',dispatchId:request.dispatchId,reason:request.reason,finalAcceptance:'human_only'};
        });
      }
      case 'automation_reconcile': {
        const request=automationSchemas.automation_reconcile.parse(parsed.data);
        if(actor.roleId!=='lead')throw new CoordinatorError('FORBIDDEN','Only lead can reconcile execution outcomes.','Send observed evidence to lead.');
        const dispatch = this.scheduler.get(request.dispatchId);
        if (!dispatch || dispatch.groupId!==actor.groupId || !this.roles.has(dispatch.roleId)) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Owning runtime must be available for reconciliation.', 'Initialize and inspect the original thread before reconciling.');
        const owner=this.roles.get(dispatch.roleId)!;
        const observed=observeThread(await owner.handle.runtime.readThread(owner.threadId),owner.threadId);
        const turnId=dispatch.turnId??request.turnId;
        const knownTurn=observed.turns.find((turn)=>turn.id===turnId);
        const beforeStart=this.scheduler.observedTurns(request.dispatchId);
        if(request.outcome==='not_started'&&(dispatch.turnId||observed.turns.some((turn)=>!beforeStart?.includes(turn.id)||['inProgress','in_progress','running','started'].includes(turn.status))))throw new CoordinatorError('RECONCILIATION_REQUIRED','A confirmed or running turn cannot be requeued as not started.','Reconcile its actual turn and business receipt.');
        if(request.outcome==='started'&&(!request.turnId||!observed.turns.some((turn)=>turn.id===request.turnId)))throw new CoordinatorError('RECONCILIATION_REQUIRED','Requested turn is absent from verified runtime history.','Use the actual runtime turn reference.');
        if(request.outcome==='completed'){
          if(!request.receipt)throw new CoordinatorError('INVALID_INPUT','Completed reconciliation needs a business receipt.','Attach the summary and verified business evidence.');
          if(!knownTurn||knownTurn.status!=='completed')throw new CoordinatorError('RECONCILIATION_REQUIRED','Runtime has not confirmed this turn completed.','Inspect the original turn before reconciling completion.');
        }
        this.scheduler.reconcile(actor, request.dispatchId, request.outcome, request.evidence, turnId);
        this.store.flagUncertain(actor, request.dispatchId);
        if (this.store.getMessage(request.dispatchId)?.status === 'needs_reconciliation') this.store.reconcile(actor, request.dispatchId, request.outcome === 'started' ? 'unknown' : request.outcome, request.evidence, request.receipt??{ evidence: request.evidence, turnId });
        this.budgetFor(dispatch.roleId).reconcile(request.dispatchId,request.outcome,request.evidence);
        this.active.delete(request.dispatchId);
        this.clearDeadline(request.dispatchId);
        return { ok: true, dispatch: this.scheduler.get(request.dispatchId) };
      }
    }
  }
  private async completeReceipt(actor: Actor, receipt: { dispatchId: string; summary: string; evidence: string[] }): Promise<{ status: string; finalAcceptance: 'human_only' }> {
    const recorded=this.scheduler.receipt(actor,receipt.dispatchId);
    if(recorded&&JSON.stringify(recorded)!==JSON.stringify(receipt))throw new CoordinatorError('IDEMPOTENCY_CONFLICT','Business receipt differs from its recorded contents.','Retry the original receipt.');
    if(recorded&&this.scheduler.get(receipt.dispatchId)?.state==='completed')return {status:'completed',finalAcceptance:'human_only'};
    const run = this.active.get(receipt.dispatchId);
    if (!run || run.actor.roleId !== actor.roleId || run.actor.bindingGeneration !== actor.bindingGeneration) throw new CoordinatorError('STALE_LEASE', 'No active dispatch belongs to this role binding.', 'Reconcile runtime and message receipts.');
    this.scheduler.recordReceipt(actor,receipt.dispatchId,run.lease.leaseToken,receipt);
    const completed=await this.finishReceipt(run);
    return {status:completed?'completed':'receipt_recorded',finalAcceptance:'human_only'};
  }
  private failureRetired(dispatchId: string, work: ReturnType<DurableScheduler['list']>, included: string[], contract: string, baseline: string): boolean {
    const visited = new Set<string>([dispatchId]);
    let successor = work.find(item=>item.replacesDispatchId===dispatchId);
    while (successor && !visited.has(successor.dispatchId)) {
      visited.add(successor.dispatchId);
      if (successor.state === 'completed') return included.includes(successor.dispatchId) && successor.contractRef === contract && successor.baseline === baseline;
      if (successor.state !== 'failed') return false;
      successor = work.find(item=>item.replacesDispatchId===successor!.dispatchId);
    }
    return false;
  }
  async pump(): Promise<void> {
    if (this.closing || this.pumping || (this.options.leadMode !== 'external' && !this.roles.has('lead'))) return;
    this.pumping = true;
    try {
      const failedRoles=new Set<RoleId>();
      for (const role of this.roles.values()) {
        try { this.scheduler.heartbeat(role.actor); }
        catch(error){failedRoles.add(role.actor.roleId);this.blocks.set(role.actor.roleId,error instanceof CoordinatorError?error.code:'RECONCILIATION_REQUIRED');}
      }
      for (const message of this.store.executionOutbox(this.options.groupId)) {
        if (this.scheduler.get(message.messageId)) continue;
        const payload = message.payload;
        const model = payload.model as { model: string; effort: string };
        const work = workSchema.strip().parse(payload);
        this.scheduler.enqueue({ ...work, ...(payload.agent === 'codex' || payload.agent === 'claude' ? { agent: payload.agent } : {}), taskBinding: payload.taskBinding as unknown as TaskBinding, model: { ...model, tier: payload.modelTier as string, reason: payload.modelReason as string } }, message.groupId, message.messageId);
      }
      for (const run of this.active.values()) {
        try {
          const persisted=this.scheduler.get(run.lease.dispatchId);
          if(persisted?.startedAt&&Date.now()-persisted.startedAt>receiptDeadlineMs(this.options.realExecution,this.options.receiptTimeoutMs))throw new CoordinatorError('RECONCILIATION_REQUIRED','Business receipt deadline expired.','Inspect the runtime and business evidence before reconciling.');
          this.scheduler.renew(run.actor, run.lease.dispatchId, run.lease.leaseToken);
          this.store.renew(run.actor, run.lease.dispatchId, run.messageToken, 60_000);
          await this.finishReceipt(run);
        } catch (error) {
          failedRoles.add(run.actor.roleId);this.blocks.set(run.actor.roleId,error instanceof CoordinatorError?error.code:'RECONCILIATION_REQUIRED');
          const reason=error instanceof CoordinatorError?error.message:'Execution lease renewal failed';
          this.budgetFor(run.actor.roleId).mark(run.lease.leaseToken,'unknown',reason);
          try{this.store.flagUncertain(run.actor,run.lease.dispatchId);}catch{/* A stale generation cannot mutate a new binding. */}
          try{this.scheduler.uncertain(run.actor,run.lease.dispatchId,run.lease.leaseToken,reason);}catch{/* Expired leases remain fenced. */}
        }
      }
      const externalPresence = this.externalLead.snapshot();
      if (this.options.leadMode === 'external' && (!externalPresence || externalPresence.expires_at <= Date.now() || externalPresence.generation !== this.store.groupSnapshot(this.options.groupId)?.roles.find((role) => role.roleId === 'lead')?.bindingGeneration)) {
        failedRoles.add('lead'); this.blocks.set('lead', 'LEAD_OFFLINE');
      } else if (this.options.leadMode === 'external') this.blocks.delete('lead');
      const lead=this.roles.get('lead');
      const template=this.store.leadWakeTemplate(this.options.groupId) as {binding:TaskBinding;work:ExecutionPackage}|undefined;
      if(template&&lead&&this.options.leadMode!=='external'&&!failedRoles.has('lead')){
        try{
          for(const message of this.store.leadInbox(this.options.groupId)){
            const id=`lead-wake:${message.messageId}`;
            if(this.scheduler.list(this.options.groupId).some((work)=>work.id===id))continue;
            const work={...template.work,id,goal:`${template.work.goal}\nHandle coordination message ${message.messageId}. Claim and inspect its current payload through automation_message_claim; record decisions and complete the message with evidence.`};
            await new WorkDispatcher(this.store,this.options.taskAuthority,this.scheduler).dispatch(lead.actor,template.binding,work,await lead.handle.runtime.listModels(),id);
          }
        }catch(error){failedRoles.add('lead');this.blocks.set('lead',error instanceof CoordinatorError?error.code:'RECONCILIATION_REQUIRED');}
      }
      await Promise.all([...this.roles.values()].filter((role) => !failedRoles.has(role.actor.roleId) && !failedRoles.has('lead')).map(async (role) => {
        try { await this.pumpRole(role); this.blocks.delete(role.actor.roleId); }
        catch (error) { this.blocks.set(role.actor.roleId, error instanceof CoordinatorError ? error.code : 'RECONCILIATION_REQUIRED'); }
      }));
    } finally { this.observeRuntime(); this.pumping = false; this.onIdle?.(); }
  }
  async humanRotateLead(capability: string): Promise<{ generation: number }> {
    this.approvals.authenticate(capability);
    if (this.options.leadMode !== 'external') throw new CoordinatorError('FORBIDDEN', 'Lead rotation applies to external lead mode.', 'Use the configured lead mode.');
    if (!this.scheduler.isPaused(this.options.groupId)) throw new CoordinatorError('TASK_GATE_CLOSED', 'Pause the group before rotating the lead.', 'Run automation_pause and reconcile in-flight work.');
    const presence = this.externalLead.snapshot();
    if (presence && presence.expires_at > Date.now()) throw new CoordinatorError('TASK_GATE_CLOSED', 'The previous lead presence has not expired.', 'Stop the previous lead session and wait for its heartbeat to expire.');
    if (this.scheduler.list(this.options.groupId).some((work) => work.roleId === 'lead' && ['starting', 'leased', 'active', 'needs_reconciliation'].includes(work.state))) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Lead work is still in flight.', 'Reconcile lead work before rotation.');
    return { generation: this.store.rotateBinding(this.options.groupId, 'lead') };
  }
  leadSuccessions(): ReturnType<ExternalLead['successions']> { return this.externalLead.successions(); }
  expireLeadPresenceForTest(): void { this.externalLead.expireForTest(); }
  async humanRespond(capability: string, approvalId: string, decision: 'accept' | 'decline' | 'cancel'): Promise<void> {
    this.approvals.authenticate(capability);
    const approval = this.approvals.list(this.options.groupId).find((item) => item.id === approvalId);
    const role = approval ? this.roles.get(approval.roleId as RoleId) : undefined;
    const runtime = role?.handle.runtime as ObservableRuntime | undefined;
    if (!approval || !role || !runtime?.respondToServerRequest) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Approval runtime is unavailable.', 'Inspect the current runtime instance.');
    const assertLive = () => {
      const params = approval.params as {threadId?:string;turnId?:string};
      if (approval.method !== 'mcpServer/elicitation/request' && !params?.turnId) return;
      const active = [...this.active.values()].some((run) => {
        const current = this.scheduler.get(run.lease.dispatchId);
        return run.actor.roleId === role.actor.roleId && current?.state === 'active' && current.turnId === params?.turnId;
      });
      if (params?.threadId !== role.threadId || !params.turnId || !active) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Approval turn is expired, terminal, or no longer active.', 'Keep the interrupted dispatch fenced; do not replay its approval.');
    };
    assertLive();
    await this.approvals.respond(approvalId, capability, decision, role.instanceId, async (id, result) => { assertLive(); await runtime.respondToServerRequest!(id, result); });
  }
  async humanControl(capability: string, roleId: RoleId, manual: boolean, evidence: string): Promise<unknown> {
    this.approvals.authenticate(capability);
    if (!evidence.trim()) throw new CoordinatorError('INVALID_INPUT', 'Control handover requires evidence.', 'Inspect current thread state and record the handover.');
    const role = this.roles.get(roleId);
    if (!role) throw new CoordinatorError('TASK_GATE_CLOSED', 'Target runtime is not initialized.', 'Initialize the role before control handover.');
    if (!manual && this.scheduler.list(this.options.groupId).some((item) => (roleId==='lead'||item.roleId===roleId) && item.state === 'needs_reconciliation')) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Role has uncertain dispatches.', 'Reconcile the current runtime before releasing human control.');
    const thread = await role.handle.runtime.readThread(role.threadId);
    const observed=observeThread(thread,role.threadId);
    if(!manual&&observed.turns.some((turn)=>['inProgress','in_progress','running','started'].includes(turn.status)))throw new CoordinatorError('RECONCILIATION_REQUIRED','Runtime still has an active turn during control release.','Reconcile the in-flight turn before returning automatic control.');
    this.scheduler.controlRole(this.options.groupId, roleId, manual, evidence);
    return { roleId, mode: manual ? 'human' : 'automatic', thread };
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.pumping) await new Promise<void>((resolve) => { this.onIdle = resolve; });
    await Promise.allSettled([...this.initializing.values()]);
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
    const results=await Promise.allSettled([...this.roles.values()].map((role) => role.handle.close()));
    this.terminalJournal.close(); this.usage.close(); this.advice.close(); this.externalLead.close(); this.browser.close(); this.budget.close(); this.advisorBudget.close(); this.collaboration.close(); this.approvals.close(); this.contracts.close(); this.scheduler.close(); this.store.close();
    const failed=results.find((result)=>result.status==='rejected');
    if(failed?.status==='rejected')throw failed.reason;
  }
  private async initialize(actor: Actor, cwd: string): Promise<unknown> {
    const pending=this.initializing.get(actor.roleId);
    if(pending){await pending;this.store.assertAuthorized(actor,actor.capabilityId);return this.initializeRole(actor,cwd);}
    const promise=this.initializeRole(actor,cwd).finally(()=>this.initializing.delete(actor.roleId));
    this.initializing.set(actor.roleId,promise);return promise;
  }
  private async initializeRole(actor: Actor, cwd: string): Promise<unknown> {
    if (this.options.leadMode === 'external' && actor.roleId === 'lead') throw new CoordinatorError('FORBIDDEN', 'The external lead uses its existing host conversation.', 'Register presence through automation_lead_heartbeat.');
    const authorized = await resolveAuthorizedPath(cwd, this.options.allowedRoots);
    const existing = this.roles.get(actor.roleId);
    if (existing) {
      if (existing.cwd !== authorized) throw new CoordinatorError('TASK_GATE_CLOSED', 'Role already owns a different worktree.', 'Pause and reconcile before switching the role worktree.');
      return { threadId: existing.threadId, source: this.options.runtimeSource, turnStarted: false };
    }
    const savedBinding=this.store.groupSnapshot(actor.groupId)?.roles.find((item)=>item.roleId===actor.roleId);
    if(savedBinding?.worktreePath&&savedBinding.worktreePath!==authorized)throw new CoordinatorError('TASK_GATE_CLOSED','Persisted role thread belongs to another worktree.','Reconcile and explicitly rebind before switching worktrees.');
    this.observeRuntime();
    const handle = this.options.runtimeFactory(actor.roleId, authorized);
    try {
      await handle.runtime.initialize();
      const binding = this.store.groupSnapshot(actor.groupId)?.roles.find((item) => item.roleId === actor.roleId);
      const threadId = binding?.threadId ? await this.resumeOrReplace(handle.runtime, actor, binding.threadId, authorized) : await handle.runtime.startThread(authorized);
      this.store.setRoleThread(actor, threadId, authorized);
      const instanceId = randomUUID();
      (handle.runtime as ObservableRuntime).onEvent?.((event) => this.terminalJournal.record(actor.groupId,actor.roleId,event));
      (handle.runtime as ObservableRuntime).onServerRequest?.((event) => { if (event.requestId !== undefined) this.approvals.enqueue(actor, instanceId, event.requestId, event.method, event.params); });
      const models=await handle.runtime.listModels();
      this.roles.set(actor.roleId, { actor, cwd: authorized, threadId, instanceId, handle });
      this.scheduler.heartbeat(actor);
      return { threadId, source: this.options.runtimeSource, models, turnStarted: false };
    } catch (error) { await handle.close(); throw error; }
  }
  // A runtime may not persist a thread until its first turn (Codex writes no rollout before that).
  // Replace it only when this database proves no work ever reached the thread; otherwise reconcile.
  private async resumeOrReplace(runtime: Runtime, actor: Actor, threadId: string, cwd: string): Promise<string> {
    try { return await runtime.resumeThread(threadId, cwd); }
    catch (error) {
      if (this.scheduler.threadStartedWork(actor.groupId, actor.roleId, threadId)) throw error;
      return runtime.startThread(cwd);
    }
  }
  // A turn that ended without a business receipt will never get one; flag it for reconciliation instead of
  // waiting for the receipt deadline. Checked only after a grace period and at most every 15 seconds.
  private async assertTurnRunning(run:ActiveRun):Promise<void>{
    const current=this.scheduler.get(run.lease.dispatchId);const role=this.roles.get(run.actor.roleId);const now=Date.now();
    if(!current?.turnId||!current.startedAt||!role||now-current.startedAt<30_000||now-(this.turnChecks.get(current.dispatchId)??0)<15_000)return;
    this.turnChecks.set(current.dispatchId,now);
    const turn=observeThread(await role.handle.runtime.readThread(role.threadId),role.threadId).turns.find((item)=>item.id===current.turnId);
    if(turn&&['completed','failed','interrupted'].includes(turn.status))throw new CoordinatorError('RECONCILIATION_REQUIRED',`Runtime turn ended (${turn.status}) without a business receipt.`,'Inspect the original turn, then archive or reconcile it.');
  }
  private async finishReceipt(run:ActiveRun):Promise<boolean>{
    const receipt=this.scheduler.receipt(run.actor,run.lease.dispatchId);
    const current=this.scheduler.get(run.lease.dispatchId);
    const runtime=this.roles.get(run.actor.roleId);
    if(current?.turnId&&runtime) {
      const evidence=await runtime.handle.runtime.readTurnModel?.(runtime.threadId,current.turnId);
      if(evidence)this.scheduler.recordModel(run.actor,current.dispatchId,runtime.threadId,current.turnId,evidence);
    }
    if(!receipt){await this.assertTurnRunning(run);return false;}
    const role=this.roles.get(run.actor.roleId)!;
    const observed=observeThread(await role.handle.runtime.readThread(role.threadId),role.threadId);
    const turnId=this.scheduler.get(run.lease.dispatchId)?.turnId;
    const turn=observed.turns.find((item)=>item.id===turnId);
    if(!turn||turn.status!=='completed')return false;
    // Usage keeps growing while a turn runs (Codex streams it), so it is recorded only once the turn is terminal.
    const usage=await role.handle.runtime.readTurnUsage?.(role.threadId,turn.id);
    if(usage)this.usage.record({groupId:run.actor.groupId,roleId:run.actor.roleId,agent:this.options.agentFor?.(run.actor.roleId)??'codex',dispatchId:receipt.dispatchId,threadId:role.threadId,turnId:turn.id,usage});
    // Another concurrent receipt may already have finalized this same dispatch.
    if(!this.active.has(run.lease.dispatchId))return this.scheduler.get(run.lease.dispatchId)?.state==='completed';
    this.store.complete(run.actor,receipt.dispatchId,run.messageToken,receipt);
    this.scheduler.complete(run.actor,receipt.dispatchId,run.lease.leaseToken,receipt);
    this.budgetFor(run.actor.roleId).mark(run.lease.leaseToken,'completed','Business receipt and terminal turn confirmed');
    this.active.delete(receipt.dispatchId);
    this.clearDeadline(receipt.dispatchId);
    this.store.send(run.actor,{type:'test_debug',recipientRole:'lead',payload:{kind:'business_receipt',...receipt}},`receipt:${receipt.dispatchId}`);
    return true;
  }

  private async pumpRole(role: InitializedRole): Promise<void> {
    const queued = this.scheduler.nextReady(this.options.groupId,role.actor.roleId);
    if (!queued) return;
    if (this.options.runtimeSource !== 'mock') assertRealExecution(this.options.realExecution, queued);
    if (!queued.taskBinding || !queued.model) throw new CoordinatorError('TASK_GATE_CLOSED', 'Execution package has no authoritative task/model binding.', 'Rebuild the package through lead dispatch.');
    await this.options.verifyWorker?.(queued);
    await this.options.taskAuthority.checkGate(queued.taskBinding);
    this.contracts.assertUsable(role.actor.groupId, role.actor.roleId, queued.contractRef, queued.contractRevision!);
    assertSupportedModelChoice(queued.model, await role.handle.runtime.listModels());
    const lease = this.scheduler.claim(role.actor,60000,role.actor.roleId==='lead',queued.dispatchId); if (!lease) return;
    try { this.budgetFor(role.actor.roleId).reserve(lease.dispatchId,lease.leaseToken); } catch(error) { this.scheduler.releaseBeforeStart(role.actor,lease.dispatchId,lease.leaseToken); throw error; }
    const token = randomUUID();
    let claimed = false;
    let startRequested = false;
    let deadlineElapsed = false;
    let knownTurnId: string | undefined;
    try {
      this.store.claimSpecific(role.actor, lease.dispatchId, token, 60_000);
      claimed = true;
      const {leaseToken:_token,expiresAt:_expiry,bindingGeneration:_generation,...executionPackage}=lease;
      const history=observeThread(await role.handle.runtime.readThread(role.threadId),role.threadId);
      if(history.turns.some((turn)=>['inProgress','in_progress','running','started'].includes(turn.status)))throw new CoordinatorError('RECONCILIATION_REQUIRED','Runtime already has an active turn.','Reconcile before automatic execution.');
      this.scheduler.recordObservedTurns(role.actor,lease.dispatchId,lease.leaseToken,history.turns.map((turn)=>turn.id));
      await this.options.taskAuthority.checkGate(queued.taskBinding);
      if (this.options.runtimeSource !== 'mock') assertRealExecution(this.options.realExecution, queued);
      if (this.options.leadMode === 'external') {
        const presence = this.externalLead.snapshot();
        if (!presence || presence.expires_at <= Date.now() || presence.generation !== this.store.groupSnapshot(role.actor.groupId)?.roles.find((item) => item.roleId === 'lead')?.bindingGeneration) throw new CoordinatorError('LEAD_OFFLINE', 'External lead expired before invocation.', 'Restore the host heartbeat before starting queued work.');
      }
      this.contracts.assertUsable(role.actor.groupId, role.actor.roleId, queued.contractRef, queued.contractRevision!);
      this.scheduler.renew(role.actor, lease.dispatchId, lease.leaseToken);
      startRequested = true;
      if (this.options.runtimeSource === 'app_server') {
        const timer = setTimeout(() => {
          deadlineElapsed = true;
          this.deadlines.delete(lease.dispatchId);
          this.blocks.set(role.actor.roleId, 'RECONCILIATION_REQUIRED');
          this.budgetFor(role.actor.roleId).mark(lease.leaseToken, 'unknown', 'Invocation deadline elapsed; interruption requested when turn ID is available');
          try { this.store.flagUncertain(role.actor, lease.dispatchId); } catch { /* Stale claims stay fenced. */ }
          try { this.scheduler.uncertain(role.actor, lease.dispatchId, lease.leaseToken, 'Invocation deadline elapsed; verify actual turn before retry.'); } catch { /* Expired execution stays fenced. */ }
          this.active.delete(lease.dispatchId);
          this.observeRuntime();
          if (knownTurnId) void role.handle.runtime.interruptTurn(role.threadId, knownTurnId).catch(() => {});
        }, this.options.realExecution!.maxTurnMs);
        timer.unref(); this.deadlines.set(lease.dispatchId, timer);
      }
      const receipt = await role.handle.runtime.startTurn({ threadId: role.threadId, input: JSON.stringify(executionPackage), model: lease.model!.model, effort: lease.model!.effort, cwd: lease.worktree });
      knownTurnId = receipt.turnId;
      if (deadlineElapsed) {
        void role.handle.runtime.interruptTurn(role.threadId, receipt.turnId).catch(() => {});
        throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Turn start arrived after the invocation deadline.', 'Inspect the actual turn before retrying.');
      }
      this.scheduler.started(role.actor, lease.dispatchId, lease.leaseToken, receipt.turnId);
      this.budgetFor(role.actor.roleId).mark(lease.leaseToken,'started');
      this.active.set(lease.dispatchId, { actor: role.actor, lease, messageToken: token });
    } catch (error) {
      this.clearDeadline(lease.dispatchId);
      if (!startRequested) {
        try {
          if (claimed) this.store.releaseExecutionBeforeStart(role.actor, lease.dispatchId, token);
          this.scheduler.releaseBeforeStart(role.actor, lease.dispatchId, lease.leaseToken);
          this.budgetFor(role.actor.roleId).cancelBeforeStart(lease.leaseToken);
          throw error;
        } catch (releaseError) { if (releaseError === error) throw error; }
      }
      this.budgetFor(role.actor.roleId).mark(lease.leaseToken,'unknown');
      this.store.flagUncertain(role.actor, lease.dispatchId);
      try { this.scheduler.uncertain(role.actor, lease.dispatchId, lease.leaseToken, 'Turn start or receipt state is unknown; inspect runtime before retry.'); } catch { /* Expired or stale starts remain fenced by scheduler reconciliation. */ }
      throw error;
    }
  }
  private budgetFor(role: RoleId): ExecutionBudget { return role === 'advisor' ? this.advisorBudget : this.budget; }
  private clearDeadline(dispatchId: string): void {
    const timer = this.deadlines.get(dispatchId);
    if (timer) clearTimeout(timer);
    this.deadlines.delete(dispatchId);
  }
  private observeRuntime(): void {
    this.externalLead.observe({ observedAt: new Date().toISOString(), source: this.options.runtimeSource,
      leadMode: this.options.leadMode ?? 'managed', blocks: Object.fromEntries(this.blocks),
      limits: this.budget.status().limits, grantExpiresAt: this.options.realExecution?.expiresAt ?? null });
  }
}
