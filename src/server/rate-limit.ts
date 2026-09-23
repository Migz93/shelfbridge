// shared: content — keep identical across Migz93 self-hosted apps (shelfbridge, hubarr, pacearr)

import type { Request, RequestHandler } from "express";
import { rateLimit, type AugmentedRequest } from "express-rate-limit";

/**
 * Rate limiting for a self-hosted homelab app. There are two limiters:
 *
 * - A global limiter applied app-wide. It is sized to catch a runaway client
 *   (a polling loop, a misbehaving script), not to stop a determined attacker.
 * - A sign-in limiter on the login route. It is the only strict one, because
 *   failed sign-ins are the requests worth slowing down.
 *
 * Don't add per-route limiters on top of these. The global limiter already
 * covers every route, and extra limits are just more things for normal use to
 * trip over.
 */

interface RateLimitLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export const GLOBAL_RATE_LIMIT = { windowMs: 60_000, limit: 600 } as const;
export const SIGN_IN_RATE_LIMIT = { windowMs: 15 * 60_000, limit: 10 } as const;

/**
 * Built frontend assets, cached images and the favicon don't count toward the
 * global limit. They're cheap static files that the browser fetches in bulk:
 * a single library page can request dozens of covers. Cached images still
 * require a session; this only exempts them from the request count.
 */
export function isRateLimitExempt(path: string): boolean {
  return path.startsWith("/assets/") || path.startsWith("/images/") || path === "/favicon.ico";
}

/**
 * Only the first rejection for a client in each window is logged. A runaway
 * client would otherwise write one warning per blocked request.
 */
function isFirstRejectionInWindow(req: Request): boolean {
  const { used, limit } = (req as AugmentedRequest).rateLimit;
  return used === limit + 1;
}

export function createGlobalRateLimiter(logger: RateLimitLogger): RequestHandler {
  return rateLimit({
    ...GLOBAL_RATE_LIMIT,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: (req) => isRateLimitExempt(req.path),
    handler: (req, res, _next, options) => {
      if (isFirstRejectionInWindow(req)) {
        logger.warn("Rate limit exceeded", {
          method: req.method,
          path: req.baseUrl + req.path,
          limit: GLOBAL_RATE_LIMIT.limit,
          windowMs: GLOBAL_RATE_LIMIT.windowMs
        });
      }
      res.status(options.statusCode).json({ error: "Too many requests. Please try again later." });
    }
  });
}

export function createSignInRateLimiter(logger: RateLimitLogger): RequestHandler {
  return rateLimit({
    ...SIGN_IN_RATE_LIMIT,
    // Only failed sign-ins (4xx/5xx responses) count, so signing in normally,
    // or completing first-run setup, never uses up the allowance.
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res, _next, options) => {
      if (isFirstRejectionInWindow(req)) {
        logger.warn("Sign-in rate limit exceeded", {
          path: req.baseUrl + req.path,
          limit: SIGN_IN_RATE_LIMIT.limit,
          windowMs: SIGN_IN_RATE_LIMIT.windowMs
        });
      }
      res.status(options.statusCode).json({ error: "Too many sign-in attempts. Please try again later." });
    }
  });
}
