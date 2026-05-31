// Platform adapter registry.
//
// Single source of truth for: "which adapter owns this hostname / URL?"
//
// The content script calls detectAdapter(location.hostname) ONCE at session
// start. The background SW uses detectAdapterForUrl / isSupportedWatchUrl
// (it has tab.url, not a bare hostname).
//
// Import note: the youtube/coursera/udemy adapter files are created by agents
// A, B, and C in the same wave. The imports below resolve once those files
// land; until then tsc will report missing-module errors on these three lines
// only — that is expected and will be fixed by the integration agent after all
// agents complete.

import type { PlatformAdapter } from "@/shared/platform-ports";
import { genericAdapter } from "@/platforms/generic/adapter";
// These imports resolve when agents A, B, C complete:
import { youtubeAdapter } from "@/platforms/youtube/adapter";
import { courseraAdapter } from "@/platforms/coursera/adapter";
import { udemyAdapter } from "@/platforms/udemy/adapter";

/**
 * Ordered list of platform-specific adapters. The registry iterates this list
 * and returns the first one whose `matchesHost(hostname)` returns `true`.
 *
 * The generic adapter is NOT in this list — it is returned explicitly as the
 * catch-all fallback when nothing matches.
 */
const ADAPTERS: PlatformAdapter[] = [youtubeAdapter, courseraAdapter, udemyAdapter];

/**
 * Resolve the adapter responsible for `hostname` (e.g. `"www.youtube.com"`).
 *
 * Returns `genericAdapter` when no specific adapter matches.
 */
export function detectAdapter(hostname: string): PlatformAdapter {
  return ADAPTERS.find((a) => a.matchesHost(hostname)) ?? genericAdapter;
}

/**
 * URL-form helper for the background SW, which has `tab.url` not a bare
 * hostname. Parses the URL and delegates to `detectAdapter`.
 *
 * Returns `genericAdapter` if the URL cannot be parsed.
 */
export function detectAdapterForUrl(url: string): PlatformAdapter {
  try {
    return detectAdapter(new URL(url).hostname);
  } catch {
    return genericAdapter;
  }
}

/**
 * Returns `true` when `url` is a playable watch / lecture page on any
 * supported platform. Used by `auto-start.ts` to decide whether to fire
 * the auto-start heuristic.
 *
 * Equivalent to `detectAdapterForUrl(url).isWatchUrl(url)`.
 */
export function isSupportedWatchUrl(url: string): boolean {
  return detectAdapterForUrl(url).isWatchUrl(url);
}

/**
 * Register background-SW services for all adapters that need them (e.g. the
 * YouTube timedtext `webRequest` cache). Call once at SW boot.
 *
 * Adapters that do not need a SW-side hook simply omit
 * `installBackgroundServices` — this iterates safely.
 */
export function installAllBackgroundServices(): void {
  for (const a of ADAPTERS) {
    a.installBackgroundServices?.();
  }
}
