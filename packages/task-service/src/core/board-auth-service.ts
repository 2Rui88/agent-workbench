import {
  createHash,
  randomBytes,
  randomUUID
} from "node:crypto";
import type {
  BoardPairingChallengeRecord,
  BoardSessionRecord,
  PlatformStore
} from "../storage/board-auth-store.js";
import { PlatformDomainError } from "./task-service.js";

const defaultPairingTtlMs = 5 * 60 * 1_000;
const defaultSessionCookieTtlMs = 400 * 24 * 60 * 60 * 1_000;

export interface BoardPrincipal {
  board_session_id: string;
  owner: string;
  source_session_id: string;
  expires_at: string;
}

export interface BoardPairingStart {
  challenge_id: string;
  pairing_code: string;
  browser_secret: string;
  expires_at: string;
}

export interface BoardPairingCompletion {
  status: "paired";
  owner: string;
  session_token: string;
  expires_at: string;
}

export interface BoardPairingPending {
  status: "pending";
  expires_at: string;
}

export interface BoardAuthServiceOptions {
  now?: () => string;
  pairingTtlMs?: number;
  sessionCookieTtlMs?: number;
}

export class BoardAuthService {
  readonly #store: PlatformStore;
  readonly #now: () => string;
  readonly #pairingTtlMs: number;
  readonly #sessionCookieTtlMs: number;

  constructor(store: PlatformStore, options: BoardAuthServiceOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#pairingTtlMs = options.pairingTtlMs ?? defaultPairingTtlMs;
    this.#sessionCookieTtlMs = options.sessionCookieTtlMs
      ?? defaultSessionCookieTtlMs;
  }

  createPairing(): BoardPairingStart {
    const now = this.#now();
    const challengeId = randomUUID();
    const browserSecret = randomBytes(32).toString("base64url");
    const pairingCode = formatPairingCode(randomBytes(8).toString("hex"));
    const expiresAt = addMilliseconds(now, this.#pairingTtlMs);
    this.#store.createBoardPairing({
      challenge_id: challengeId,
      code_hash: hashPairingCode(pairingCode),
      browser_secret_hash: hashSecret(browserSecret),
      created_at: now,
      expires_at: expiresAt
    });
    return {
      challenge_id: challengeId,
      pairing_code: pairingCode,
      browser_secret: browserSecret,
      expires_at: expiresAt
    };
  }

  approvePairing(pairingCode: string, sessionId: string): {
    owner: string;
    expires_at: string;
  } {
    const session = this.#store.transaction((tx) => tx.getSession(sessionId));
    if (
      session === undefined
      || session.owner === undefined
      || session.ended_at !== undefined
      || session.stale_at !== undefined
    ) {
      throw new PlatformDomainError(
        "BOARD_PAIRING_SESSION_INVALID",
        "Board pairing requires an active MCP session with a bound owner",
        {
          recovery_actions: [
            "Call session_context with the current repository and Git owner, then retry board_pair."
          ]
        }
      );
    }
    const approvedAt = this.#now();
    const pairing = this.#store.approveBoardPairing(
      hashPairingCode(pairingCode),
      sessionId,
      session.owner,
      approvedAt
    );
    if (pairing === undefined) {
      throw new PlatformDomainError(
        "BOARD_PAIRING_NOT_FOUND",
        "The pairing code is invalid, expired, or already used",
        {
          recovery_actions: ["Generate a new pairing code on the Board and retry board_pair."]
        }
      );
    }
    return { owner: session.owner, expires_at: pairing.expires_at };
  }

  completePairing(
    challengeId: string,
    browserSecret: string
  ): BoardPairingPending | BoardPairingCompletion {
    const now = this.#now();
    const secretHash = hashSecret(browserSecret);
    const pairing = this.#store.getBoardPairing(challengeId, secretHash);
    if (pairing === undefined || pairing.consumed_at !== undefined) {
      throw new PlatformDomainError(
        "BOARD_PAIRING_NOT_FOUND",
        "The Board pairing request is invalid or already used",
        { recovery_actions: ["Generate a new pairing code on the Board."] }
      );
    }
    if (pairing.expires_at <= now) {
      throw new PlatformDomainError(
        "BOARD_PAIRING_EXPIRED",
        "The Board pairing code has expired",
        { recovery_actions: ["Generate a new pairing code on the Board."] }
      );
    }
    if (
      pairing.approved_at === undefined
      || pairing.approved_owner === undefined
      || pairing.approved_session_id === undefined
    ) {
      return { status: "pending", expires_at: pairing.expires_at };
    }

    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = addMilliseconds(now, this.#sessionCookieTtlMs);
    const session: BoardSessionRecord = {
      board_session_id: randomUUID(),
      token_hash: hashSecret(sessionToken),
      owner: pairing.approved_owner,
      source_session_id: pairing.approved_session_id,
      created_at: now,
      expires_at: expiresAt,
      last_seen_at: now
    };
    const consumed = this.#store.consumeBoardPairing(
      challengeId,
      secretHash,
      session,
      now
    );
    if (!consumed) {
      throw new PlatformDomainError(
        "BOARD_PAIRING_NOT_FOUND",
        "The Board pairing request was already consumed",
        { recovery_actions: ["Reload the Board or generate a new pairing code."] }
      );
    }
    return {
      status: "paired",
      owner: session.owner,
      session_token: sessionToken,
      expires_at: expiresAt
    };
  }

  authenticate(sessionToken: string | undefined): BoardPrincipal | undefined {
    if (sessionToken === undefined || sessionToken.length === 0) {
      return undefined;
    }
    const now = this.#now();
    const cookieExpiresAt = addMilliseconds(now, this.#sessionCookieTtlMs);
    const session = this.#store.resolveBoardSession(
      hashSecret(sessionToken),
      now,
      cookieExpiresAt
    );
    if (session === undefined) {
      return undefined;
    }
    return {
      board_session_id: session.board_session_id,
      owner: session.owner,
      source_session_id: session.source_session_id,
      expires_at: session.expires_at
    };
  }

  logout(sessionToken: string | undefined): void {
    if (sessionToken !== undefined && sessionToken.length > 0) {
      this.#store.revokeBoardSession(hashSecret(sessionToken), this.#now());
    }
  }

  secondsUntil(expiresAt: string): number {
    return Math.max(
      0,
      Math.ceil((Date.parse(expiresAt) - Date.parse(this.#now())) / 1_000)
    );
  }
}

function addMilliseconds(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function formatPairingCode(hex: string): string {
  return hex.toUpperCase().match(/.{1,4}/g)?.join("-") ?? hex.toUpperCase();
}

function normalizePairingCode(code: string): string {
  return code.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
}

function hashPairingCode(code: string): string {
  return hashSecret(normalizePairingCode(code));
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}
