import { z } from 'zod';

export const ROLE_IDS = ['lead', 'frontend', 'backend', 'audit', 'advisor'] as const;
export type RoleId = typeof ROLE_IDS[number];
export const CORE_ROLE_IDS = ['lead', 'frontend', 'backend', 'audit'] as const;
export type CoreRoleId = typeof CORE_ROLE_IDS[number];
export const OBSERVED_ROLES = ['frontend', 'backend', 'audit', 'advisor'] as const;
export type ObservedRole = typeof OBSERVED_ROLES[number];
export const roleEnum = z.enum(ROLE_IDS);
export const AGENT_KINDS = ['codex', 'claude'] as const;
export type AgentKind = typeof AGENT_KINDS[number];
export const agentEnum = z.enum(AGENT_KINDS);
// Only the writing workers hold their own Task/worktree lease; lead, audit and advisor run under the lead Task.
export const requiresWorkerEnrollment = (role: RoleId): role is 'frontend' | 'backend' => role === 'frontend' || role === 'backend';
