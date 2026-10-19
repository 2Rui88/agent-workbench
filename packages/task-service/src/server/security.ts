import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Local security boundary for the task board. The service only ever listens
 * on loopback; these gates keep browsers from being used as a proxy against
 * it (DNS rebinding via the Host header, cross-site requests via Origin).
 */

function normalizeHost(host: string | undefined): string {
  return (host ?? "").trim().toLowerCase();
}

export function createHostGate(allowedHosts: readonly string[]): RequestHandler {
  const allowed = new Set(allowedHosts.map(normalizeHost));
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!allowed.has(normalizeHost(request.headers.host))) {
      response.status(403).json({
        code: "HOST_NOT_ALLOWED",
        message: "Requests must target the local loopback host",
        retryable: false,
        evidence: [String(request.headers.host ?? "")],
        recovery_actions: [`Allowed hosts: ${[...allowed].join(", ")}`]
      });
      return;
    }
    next();
  };
}

const mutatingMethods = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Mutating web requests that carry an Origin header must be same-origin.
 * Requests without Origin (curl, local tools, MCP clients) pass; the Host
 * gate above is the primary rebinding protection for those.
 */
export function createOriginGate(allowedHosts: readonly string[]): RequestHandler {
  const allowed = new Set(allowedHosts.map(normalizeHost));
  return (request: Request, response: Response, next: NextFunction): void => {
    if (
      request.path.toLowerCase().startsWith("/api")
      && mutatingMethods.has(request.method)
      && request.headers.origin !== undefined
      && !allowed.has(originHost(request.headers.origin))
    ) {
      response.status(403).json({
        code: "ORIGIN_NOT_ALLOWED",
        message: "Web mutations must originate from the board itself",
        retryable: false,
        evidence: [String(request.headers.origin)],
        recovery_actions: ["Open the board at its loopback origin and retry."]
      });
      return;
    }
    next();
  };
}

function originHost(origin: string): string {
  try {
    return normalizeHost(new URL(origin).host);
  } catch {
    return normalizeHost(origin);
  }
}
