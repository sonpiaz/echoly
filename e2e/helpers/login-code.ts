// E2E helpers for the login-code (OTP) sign-in flow.
//
// ─── Code retrieval limitation ───────────────────────────────────────────────
//
// The login code is hashed (SHA-256 + per-code salt) before storage; the
// plaintext 6-digit code is NEVER written to the database. This means it is
// impossible to retrieve the code by querying login_codes — only code_hash and
// code_salt are stored.
//
// For e2e tests that need the real code, two options exist:
//
//   Option A (recommended): A NON_PROD-only server endpoint (e.g.
//     POST /dev/latest-login-code-plaintext, guarded by NODE_ENV !== 'production'
//     and a DEV_BACKDOOR_TOKEN) echoes the last emitted code via an in-process
//     hook. This endpoint does NOT exist yet — see server/scripts/dev-latest-login-code.ts
//     for the rationale and follow-up task for Agent C / the orchestrator.
//
//   Option B (manual / console): In dev, the email transport logs the code to
//     the server's stdout. Read the 6-digit code from the server console output.
//
// Until Option A is implemented, tests that require the actual code must be
// skipped in CI (see signin-login-code.spec.ts).
//
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import { extensionRoot } from "./paths.ts";

const _serverDir = path.resolve(extensionRoot, "../server");
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:8787";
const WEB_ORIGIN = process.env.PLAYWRIGHT_WEB_ORIGIN ?? "http://localhost:4321";

export async function assertWebHealthy(): Promise<void> {
  const base = WEB_ORIGIN.replace(/\/$/, "");
  const res = await fetch(base, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(
      `Web dev server not reachable at ${base} (${res.status}). Run: make dev-web`,
    );
  }
}

/**
 * POST /auth/sign-in/request-code (same as web form → API).
 * Sends a login code to the given email address.
 */
export async function requestLoginCode(email: string): Promise<void> {
  const res = await fetch(`${API}/auth/sign-in/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.toLowerCase().trim() }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`request-code failed ${res.status}: ${body}`);
  }
}

/**
 * POST /api/auth/verify-code on the web origin (Astro proxy → server).
 * Submits {email, code} and returns the raw Response so the caller can
 * inspect headers (Set-Cookie) as well as the JSON body.
 *
 * NOTE: The plaintext code is NOT retrievable from the DB by design.
 * In e2e you must supply the code from a dev source — see the module
 * header for options.
 */
export async function submitLoginCode(email: string, code: string): Promise<Response> {
  const base = WEB_ORIGIN.replace(/\/$/, "");
  const res = await fetch(`${base}/api/auth/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.toLowerCase().trim(), code }),
  });
  return res;
}
