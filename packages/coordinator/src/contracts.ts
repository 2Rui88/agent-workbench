import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CoordinatorError } from './errors.js';
import type { Actor, RoleId } from './protocol.js';

export interface ContractInput { artifactRef: string; revision: string; digest: string; baselineRef: string; compatibility: 'compatible' | 'breaking'; affectedRoles: RoleId[]; }
export interface Contract extends ContractInput { contractId: string; groupId: string; version: number; createdBy: RoleId; createdAt: string; }

export class ContractRegistry {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS contracts(contract_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(group_id,version));
      CREATE TABLE IF NOT EXISTS contract_acks(contract_id TEXT NOT NULL REFERENCES contracts(contract_id), role_id TEXT NOT NULL, acknowledged_at TEXT NOT NULL, PRIMARY KEY(contract_id,role_id));`);
  }

  close(): void { this.db.close(); }

  publish(actor: Actor, input: ContractInput): Contract {
    if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only the lead can publish a contract.', 'Submit a contract proposal to the lead.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT max(version) AS version FROM contracts WHERE group_id=?`).get(actor.groupId) as { version: number | null };
      const contract: Contract = { ...input, contractId: randomUUID(), groupId: actor.groupId, version: (row.version ?? 0) + 1, createdBy: actor.roleId, createdAt: new Date().toISOString(), affectedRoles: [...input.affectedRoles] };
      this.db.prepare(`INSERT INTO contracts(contract_id,group_id,version,payload_json,created_at) VALUES (?,?,?,?,?)`).run(contract.contractId, contract.groupId, contract.version, JSON.stringify(contract), contract.createdAt);
      this.db.exec('COMMIT');
      return contract;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  ack(actor: Actor, contractId: string, revision: string): void {
    const contract = this.get(contractId);
    if (!contract || contract.groupId !== actor.groupId || revision !== contract.revision) throw new CoordinatorError('CONTRACT_MISMATCH', 'Contract acknowledgement references a different group or revision.', 'Refresh the contract and acknowledge its exact revision.');
    this.db.prepare(`INSERT INTO contract_acks(contract_id,role_id,acknowledged_at) VALUES (?,?,?) ON CONFLICT(contract_id,role_id) DO UPDATE SET acknowledged_at=excluded.acknowledged_at`)
      .run(contractId, actor.roleId, new Date().toISOString());
  }

  assertUsable(groupId: string, roleId: RoleId, contractId: string, revision: string): true {
    const contract = this.get(contractId);
    if (!contract || contract.groupId !== groupId) throw new CoordinatorError('CONTRACT_MISMATCH', 'Contract is unavailable in this group.', 'Request the current contract from the lead.');
    if (revision !== contract.revision && (contract.compatibility === 'breaking' && contract.affectedRoles.includes(roleId) || contract.compatibility === 'compatible')) {
      throw new CoordinatorError('CONTRACT_MISMATCH', 'The supplied contract revision does not match the published revision.', 'Refresh and acknowledge the published revision before continuing.');
    }
    const newer = this.db.prepare('SELECT payload_json FROM contracts WHERE group_id=? AND version>? ORDER BY version DESC').all(groupId, contract.version) as Array<{payload_json:string}>;
    if (newer.some((row) => {
      const next = JSON.parse(row.payload_json) as Contract;
      return next.artifactRef === contract.artifactRef && next.compatibility === 'breaking' && next.affectedRoles.includes(roleId);
    })) throw new CoordinatorError('CONTRACT_MISMATCH', 'A newer breaking contract supersedes this consumer package.', 'Refresh the package and acknowledge the new revision.');
    const ack = this.db.prepare(`SELECT 1 AS acknowledged FROM contract_acks WHERE contract_id=? AND role_id=?`).get(contractId, roleId);
    if (contract.compatibility === 'breaking' && contract.affectedRoles.includes(roleId) && !ack) {
      throw new CoordinatorError('CONTRACT_MISMATCH', 'Affected consumer has not acknowledged the published contract.', 'Acknowledge the current contract revision.');
    }
    return true;
  }

  private get(contractId: string): Contract | undefined {
    const row = this.db.prepare(`SELECT payload_json FROM contracts WHERE contract_id=?`).get(contractId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as Contract : undefined;
  }
}
