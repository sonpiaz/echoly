// Active-tab site resolution for popup UI (auto-start label, per-site overrides).

import { normalizeDomain } from "@/shared/advanced";

export interface TabLike {
  active?: boolean;
  url?: string;
  index?: number;
}

const NON_WEB_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "about:",
  "edge://",
  "devtools://",
] as const;

/** Normalized hostname from a tab URL, or null for non-web / internal pages. */
export function domainFromTabUrl(url: string | undefined): string | null {
  if (!url) return null;
  if (NON_WEB_PREFIXES.some((p) => url.startsWith(p))) return null;
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}

export function isYouTubeWatchUrl(url: string | undefined): boolean {
  return (
    typeof url === "string" &&
    /^https?:\/\/[^/]*youtube\.com\/watch\b/.test(url)
  );
}

/**
 * Hostname for “this site” in the popup.
 *
 * 1. Active tab when it is a normal web page (real toolbar popup over YouTube).
 * 2. Otherwise the best web tab in the window (Playwright opens popup.html as a
 *    tab — active tab is chrome-extension://; fall back to YouTube, then last web tab).
 */
export function resolveSiteDomainFromTabs(tabs: TabLike[]): string | null {
  if (!tabs.length) return null;

  const active = tabs.find((t) => t.active);
  const fromActive = domainFromTabUrl(active?.url);
  if (fromActive) return fromActive;

  const web = tabs
    .map((t) => ({ tab: t, domain: domainFromTabUrl(t.url) }))
    .filter((x): x is { tab: TabLike; domain: string } => x.domain != null);

  const yt = web.find((x) => isYouTubeWatchUrl(x.tab.url));
  if (yt) return yt.domain;

  return web.length > 0 ? web[web.length - 1]!.domain : null;
}

/** User-facing label for #autoStartDomain. */
export function siteDisplayLabel(domain: string | null): string {
  if (!domain) return "no active site";
  return domain;
}

/**
 * YouTube watch tab to start translation on.
 *
 * When the popup is a normal tab (E2E / dev), the active tab is
 * chrome-extension://… — use the watch tab in the same window instead.
 */
export function findYouTubeWatchTab<T extends TabLike>(tabs: T[]): T | null {
  if (!tabs.length) return null;
  const active = tabs.find((t) => t.active);
  if (active && isYouTubeWatchUrl(active.url)) return active;
  const watches = tabs.filter((t) => isYouTubeWatchUrl(t.url));
  if (!watches.length) return null;
  return watches.reduce((best, t) =>
    (t.index ?? 0) > (best.index ?? 0) ? t : best,
  );
}

/**
 * Tab to inject content + START on: active web page, else YouTube watch, else
 * the most recently focused web tab (Coursera, Udemy, etc.).
 */
export function findSessionStartTab<T extends TabLike>(tabs: T[]): T | null {
  if (!tabs.length) return null;
  const active = tabs.find((t) => t.active);
  if (active && domainFromTabUrl(active.url)) return active;
  const yt = findYouTubeWatchTab(tabs);
  if (yt) return yt;
  const web = tabs
    .map((t) => ({ tab: t, domain: domainFromTabUrl(t.url) }))
    .filter((x): x is { tab: T; domain: string } => x.domain != null);
  if (!web.length) return null;
  return web.reduce((best, x) =>
    (x.tab.index ?? 0) > (best.tab.index ?? 0) ? x : best,
  ).tab;
}
