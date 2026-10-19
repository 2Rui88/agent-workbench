/** Shared identifiers used by the Gateway, observer and process supervisor. */
export type AgentRole = 'lead' | 'frontend' | 'backend' | 'audit' | 'advisor';

export interface AgentRef {
  groupId: string;
  agentId: string;
  role: AgentRole;
  taskId?: string;
}

export interface RuntimeEvent {
  sequence: number;
  timestamp: string;
  source: 'coordinator' | 'task-service' | 'terminal';
  agent?: AgentRef;
  type: string;
  summary: string;
}
