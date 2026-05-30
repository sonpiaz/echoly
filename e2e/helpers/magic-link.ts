import { execSync } from "node:child_process";
import path from "node:path";
import { extensionRoot } from "./paths.ts";

const serverDir = path.resolve(extensionRoot, "../server");
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

/** POST /auth/sign-in/magic-link (same as web form → API). */
export async function requestMagicLink(email: string): Promise<void> {
  const res = await fetch(`${API}/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.toLowerCase().trim() }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`magic-link request failed ${res.status}: ${body}`);
  }
}

/** Latest unused token from Postgres (dev / CI with DB). */
export function latestMagicLinkToken(email: string): string {
  const out = execSync(
    `EMAIL=${JSON.stringify(email.toLowerCase().trim())} node --env-file=.env --import tsx scripts/e2e-latest-magic-link.ts`,
    { cwd: serverDir, encoding: "utf8", env: process.env },
  ).trim();
  if (!out) throw new Error(`No magic-link token for ${email}`);
  return out;
}

/** Callback URL on web origin (dev proxy → API). */
export function magicLinkCallbackUrl(email: string): string {
  const token = latestMagicLinkToken(email);
  const base = WEB_ORIGIN.replace(/\/$/, "");
  return `${base}/auth/callback?token=${encodeURIComponent(token)}`;
}
