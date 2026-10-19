export type CoordinatorErrorCode =
  | 'BUDGET_EXHAUSTED'
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'PATH_OUTSIDE_ALLOWED_ROOT'
  | 'MODEL_EFFORT_UNSUPPORTED'
  | 'COMMAND_NOT_FOUND'
  | 'COMMAND_EXISTS'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STALE_LEASE'
  | 'RUNTIME_DISCONNECTED'
  | 'RUNTIME_TIMEOUT'
  | 'LEAD_OFFLINE'
  | 'CONTRACT_MISMATCH'
  | 'VALIDATION_CYCLE_CLOSED'
  | 'SERVICE_UNHEALTHY'
  | 'TASK_GATE_CLOSED'
  | 'HUMAN_ACCEPTANCE_ONLY'
  | 'RECONCILIATION_REQUIRED'
  | 'CONFLICT'
  | 'LEAD_CONFLICT'
  | 'PROVIDER_UNAVAILABLE';

export class CoordinatorError extends Error {
  readonly code: CoordinatorErrorCode;
  readonly retryable: boolean;
  readonly nextAction: string;

  constructor(code: CoordinatorErrorCode, message: string, nextAction: string) {
    super(message);
    this.name = 'CoordinatorError';
    this.code = code;
    this.retryable = false;
    this.nextAction = nextAction;
  }
}
