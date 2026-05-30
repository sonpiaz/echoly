import { execSync } from "node:child_process";
import path from "node:path";
import { extensionRoot } from "./paths.ts";

const serverDir = path.resolve(extensionRoot, "../server");
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:8787";

/** Mint a dev session token via server/scripts/dev-user.ts (Postgres required). */
export function devUserToken(
  email: string,
  tier: "free" | "pro" | "max" = "pro",
): string {
  const out = execSync(
    `EMAIL=${email} TIER=${tier} node --env-file=.env --import tsx scripts/dev-user.ts`,
    { cwd: serverDir, encoding: "utf8", env: process.env },
  );
  const token = out.match(/token\s+:\s+(\S+)/)?.[1];
  if (!token) throw new Error(`dev-user failed for ${email}`);
  return token;
}

export async function assertApiHealthy(): Promise<void> {
  const res = await fetch(`${API}/health`);
  if (!res.ok) throw new Error(`API health check failed: ${res.status}`);
}
