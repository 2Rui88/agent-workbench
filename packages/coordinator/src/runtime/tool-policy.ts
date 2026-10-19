import type { RoleId } from '../protocol.js';

// The coordinator_role MCP tools a daemon-managed role may call; everything else stays hidden from the worker.
export function workerToolPolicy(role: RoleId): string[] {
  if (role === 'advisor') return ['automation_status','automation_events','automation_operation_get','automation_advice_get','automation_advice_complete'];
  const coordinator = ['automation_status','automation_events','automation_operation_get','automation_contract_ack','automation_work_complete','automation_message_send','automation_message_claim','automation_message_renew','automation_message_complete'];
  if (role === 'audit') coordinator.push('automation_validation_create','automation_validation_record');
  return coordinator;
}

export function toolAnnotations(name: string): {readOnlyHint:boolean;destructiveHint:boolean;idempotentHint:boolean;openWorldHint:boolean} {
  const readOnly = ['automation_status','automation_events','automation_operation_get','automation_advice_get'].includes(name);
  const idempotent = readOnly || ['automation_contract_ack','automation_work_complete','automation_message_send','automation_message_complete','automation_validation_create','automation_advice_complete'].includes(name);
  return {readOnlyHint:readOnly,destructiveHint:!readOnly,idempotentHint:idempotent,openWorldHint:false};
}

export function toolPolicyOverrides(serverId: string, tools: string[]): string[] {
  return [`mcp_servers.${serverId}.default_tools_approval_mode="prompt"`, `mcp_servers.${serverId}.enabled_tools=${JSON.stringify(tools)}`, ...tools.map(name=>`mcp_servers.${serverId}.tools.${name}.approval_mode="approve"`)];
}
