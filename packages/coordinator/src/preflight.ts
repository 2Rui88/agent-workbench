import { CoordinatorError } from './errors.js';

export interface HealthCheck { service: string; check: () => Promise<boolean>; }

export async function requireHealthyServices(checks: HealthCheck[]): Promise<void> {
  const failures: string[] = [];
  for (const check of checks) {
    if (!await check.check()) failures.push(check.service);
  }
  if (failures.length) throw new CoordinatorError('SERVICE_UNHEALTHY', `Required services are unhealthy: ${failures.join(', ')}`, 'Restore every dependency and verify health before running tests.');
}
