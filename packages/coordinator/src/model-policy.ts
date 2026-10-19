import { assertSupportedModelChoice } from './config.js';
import type { ModelCapability, ModelChoice } from './config.js';
import type { RoleId } from './protocol.js';
import type { ExecutionPackage } from './scheduler.js';

export type ModelTierId = 'execution' | 'analysis' | 'deep_analysis';
export interface ModelTier { tier: ModelTierId; choice: ModelChoice; reason: string; }

const defaults: Record<RoleId, ModelTierId> = { lead: 'analysis', frontend: 'execution', backend: 'execution', audit: 'analysis', advisor: 'analysis' };
const candidates: Record<ModelTierId, ModelChoice> = {
  execution: { model: 'gpt-6-luna', effort: 'high' },
  analysis: { model: 'gpt-6.1-sol', effort: 'high' },
  deep_analysis: { model: 'gpt-6.1-sol', effort: 'xhigh' }
};

export function chooseModelTier(work: ExecutionPackage, catalog: ModelCapability[]): ModelTier {
  const complexity = work.risk + (work.allowedPaths.length > 3 ? 1 : 0) + (work.dependencies.length > 0 ? 1 : 0) + Math.min(work.evidenceFailures, 2) * 2;
  const tier: ModelTierId = complexity >= 6 ? 'deep_analysis' : complexity >= 3 || defaults[work.roleId] === 'analysis' ? 'analysis' : 'execution';
  const choice = candidates[tier];
  assertSupportedModelChoice(choice, catalog);
  return { tier, choice, reason: `Selected ${tier} from declared risk, scope dependencies, and observed failure evidence.` };
}

export class ModelPolicy {
  defaultFor(role: RoleId, catalog: ModelCapability[]): ModelChoice {
    const choice = candidates[defaults[role]];
    assertSupportedModelChoice(choice, catalog);
    return { ...choice };
  }
}
