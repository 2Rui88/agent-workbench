import type { ProgressStore } from "./progress-store.js";

export interface BoardPairingChallengeRecord {
  challenge_id: string;
  code_hash: string;
  browser_secret_hash: string;
  created_at: string;
  expires_at: string;
  approved_session_id?: string | undefined;
  approved_owner?: string | undefined;
  approved_at?: string | undefined;
  consumed_at?: string | undefined;
}

export interface BoardSessionRecord {
  board_session_id: string;
  token_hash: string;
  owner: string;
  source_session_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at?: string | undefined;
}

export interface BoardAuthStore {
  createBoardPairing(record: BoardPairingChallengeRecord): void;
  approveBoardPairing(
    codeHash: string,
    sessionId: string,
    owner: string,
    approvedAt: string
  ): BoardPairingChallengeRecord | undefined;
  getBoardPairing(
    challengeId: string,
    browserSecretHash: string
  ): BoardPairingChallengeRecord | undefined;
  consumeBoardPairing(
    challengeId: string,
    browserSecretHash: string,
    session: BoardSessionRecord,
    consumedAt: string
  ): boolean;
  resolveBoardSession(
    tokenHash: string,
    seenAt: string,
    cookieExpiresAt: string
  ): BoardSessionRecord | undefined;
  revokeBoardSession(tokenHash: string, revokedAt: string): boolean;
}

export type PlatformStore = ProgressStore & BoardAuthStore;
