import { Router, type Request, type RequestHandler, type Response } from "express";
import {
  BoardAuthService,
  type BoardPrincipal
} from "../core/board-auth-service.js";
import { PlatformDomainError } from "../core/task-service.js";

const boardSessionCookie = "board_session";
const boardPairingCookie = "board_pairing";

interface PairingCookie {
  challengeId: string;
  browserSecret: string;
}

export function createBoardAuthRouter(service: BoardAuthService): Router {
  const router = Router();

  router.get("/session", (request, response) => {
    response.setHeader("cache-control", "no-store");
    const principal = authenticateAndRefresh(service, request, response);
    if (principal === undefined) {
      response.json({ authenticated: false });
      return;
    }
    response.json({
      authenticated: true,
      owner: principal.owner,
      expires_at: principal.expires_at
    });
  });

  router.post("/pairings", (_request, response) => {
    const pairing = service.createPairing();
    appendCookie(response, boardPairingCookie, encodePairingCookie({
      challengeId: pairing.challenge_id,
      browserSecret: pairing.browser_secret
    }), {
      maxAgeSeconds: service.secondsUntil(pairing.expires_at),
      path: "/api/board-auth"
    });
    response.status(201).json({
      challenge_id: pairing.challenge_id,
      pairing_code: pairing.pairing_code,
      expires_at: pairing.expires_at
    });
  });


  router.get("/pairings/:challengeId", (request, response) => {
    response.setHeader("cache-control", "no-store");
    const pairingCookie = decodePairingCookie(readCookie(request, boardPairingCookie));
    if (pairingCookie?.challengeId !== request.params.challengeId) {
      throw new PlatformDomainError(
        "BOARD_PAIRING_NOT_FOUND",
        "The Board pairing request is invalid or missing",
        { recovery_actions: ["Generate a new pairing code on the Board."] }
      );
    }
    const result = service.completePairing(
      pairingCookie.challengeId,
      pairingCookie.browserSecret
    );
    if (result.status === "pending") {
      response.json(result);
      return;
    }
    appendCookie(response, boardSessionCookie, result.session_token, {
      maxAgeSeconds: service.secondsUntil(result.expires_at),
      path: "/"
    });
    clearCookie(response, boardPairingCookie, "/api/board-auth");
    response.json({
      status: result.status,
      owner: result.owner,
      expires_at: result.expires_at
    });
  });

  router.post("/logout", (request, response) => {
    service.logout(readCookie(request, boardSessionCookie));
    clearCookie(response, boardSessionCookie, "/");
    response.status(204).end();
  });

  return router;
}

export function createBoardAuthenticationGate(
  service: BoardAuthService
): RequestHandler {
  return (request, response, next) => {
    const principal = authenticateAndRefresh(service, request, response);
    if (principal === undefined) {
      response.setHeader("cache-control", "no-store");
      response.status(401).json({
        code: "BOARD_AUTH_REQUIRED",
        message: "This Board has not been paired with an initialized Agent session",
        retryable: false,
        evidence: [],
        recovery_actions: [
          "Install and initialize the CLI Session Task MCP in an Agent.",
          "Generate a pairing code on the Board and approve it with board_pair."
        ]
      });
      return;
    }
    response.locals.boardPrincipal = principal;
    next();
  };
}

export function boardPrincipal(response: Response): BoardPrincipal {
  const principal = response.locals.boardPrincipal as BoardPrincipal | undefined;
  if (principal === undefined) {
    throw new PlatformDomainError(
      "BOARD_AUTH_REQUIRED",
      "An authenticated Board session is required"
    );
  }
  return principal;
}

function authenticateAndRefresh(
  service: BoardAuthService,
  request: Request,
  response: Response
): BoardPrincipal | undefined {
  const sessionToken = readCookie(request, boardSessionCookie);
  const principal = service.authenticate(sessionToken);
  if (principal !== undefined && sessionToken !== undefined) {
    appendCookie(response, boardSessionCookie, sessionToken, {
      maxAgeSeconds: service.secondsUntil(principal.expires_at),
      path: "/"
    });
  }
  return principal;
}

function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.header("cookie");
  if (cookieHeader === undefined) {
    return undefined;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function encodePairingCookie(pairing: PairingCookie): string {
  return `${pairing.challengeId}.${pairing.browserSecret}`;
}

function decodePairingCookie(value: string | undefined): PairingCookie | undefined {
  if (value === undefined) {
    return undefined;
  }
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) {
    return undefined;
  }
  return {
    challengeId: value.slice(0, separator),
    browserSecret: value.slice(separator + 1)
  };
}

function appendCookie(
  response: Response,
  name: string,
  value: string,
  options: { maxAgeSeconds: number; path: string }
): void {
  response.append("set-cookie", serializeCookie(name, value, options));
}

function clearCookie(response: Response, name: string, path: string): void {
  response.append("set-cookie", serializeCookie(name, "", {
    maxAgeSeconds: 0,
    path
  }));
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; path: string }
): string {
  return `${name}=${encodeURIComponent(value)}`
    + `; Path=${options.path}`
    + `; Max-Age=${Math.max(0, options.maxAgeSeconds)}`
    + "; HttpOnly; SameSite=Strict";
}
