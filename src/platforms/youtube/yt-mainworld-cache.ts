// ISOLATED-world bridge for the MAIN-world capture (yt-mainworld.content.ts).
//
// The MAIN-world script observes YouTube's own caption network traffic (which
// carries a valid `pot` token) and dispatches `echoly:yt-capture` DOM
// CustomEvents. This module listens for them and caches, per videoId:
//   - ccUrls:  the player's own /api/timedtext request URLs (pot+signature baked in)
//   - ccBodies: the raw response bodies of those requests (zero-refetch, pot-proof)
//   - captionTracks + poToken: from the /youtubei/v1/player response
//
// captions-fetch.ts reads this via getYtMainWorldData() as its primary layer.
// Detail is passed as a JSON string so it survives the MAIN↔ISOLATED boundary
// cleanly (no cross-world object wrapping).

const EVENT = "echoly:yt-capture";
const MAX_PER_VIDEO = 8;

export interface YtCapturedTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

export interface YtCaptured {
  ccUrls: string[];
  ccBodies: Array<{ url: string; body: string }>;
  captionTracks?: YtCapturedTrack[];
  poToken?: string;
}

function emptyEntry(): YtCaptured {
  return { ccUrls: [], ccBodies: [] };
}

const byVideo = new Map<string, YtCaptured>();
// Fallback bucket for captures whose videoId we couldn't key (used only when the
// per-video entry has nothing).
const latest: YtCaptured = emptyEntry();

function videoIdFromUrl(url: string): string | null {
  try {
    return new URL(url, location.origin).searchParams.get("v");
  } catch {
    return null;
  }
}

function entryFor(videoId: string | null): YtCaptured {
  if (!videoId) return latest;
  let e = byVideo.get(videoId);
  if (!e) {
    e = emptyEntry();
    byVideo.set(videoId, e);
  }
  return e;
}

function pushCapped<T>(arr: T[], item: T, eq: (a: T) => boolean): void {
  if (arr.some(eq)) return;
  arr.push(item);
  while (arr.length > MAX_PER_VIDEO) arr.shift();
}

let installed = false;

/** Install the document listener (idempotent). Call once from initContent(). */
export function installYtMainWorldBridge(): void {
  if (installed) return;
  installed = true;
  document.addEventListener(EVENT, (ev) => {
    try {
      const detail = (ev as CustomEvent).detail;
      if (typeof detail !== "string") return;
      const d = JSON.parse(detail) as {
        kind?: string;
        url?: string;
        body?: string;
        videoId?: string;
        poToken?: string;
        captionTracks?: YtCapturedTrack[];
      };
      // A capture goes ONLY to its per-video entry when we can key it by videoId,
      // and ONLY to `latest` when we can't. `latest` must never hold a *known*
      // video's data — otherwise a fresh video (whose own request hasn't been
      // captured yet) would be served the PREVIOUS video's captions. Caption
      // bodies/URLs AND captionTracks/poToken are all video-scoped (YouTube's pot
      // token is bound to the videoId), so the same scoping rule applies to all.
      if (d.kind === "cc-url" && typeof d.url === "string") {
        const url = d.url;
        const vid = videoIdFromUrl(url);
        pushCapped(entryFor(vid).ccUrls, url, (u) => u === url);
      } else if (d.kind === "cc-body" && typeof d.url === "string" && typeof d.body === "string") {
        const rec = { url: d.url, body: d.body };
        const vid = videoIdFromUrl(d.url);
        pushCapped(entryFor(vid).ccBodies, rec, (r) => r.url === rec.url);
      } else if (d.kind === "player") {
        // entryFor(null) === latest, so an un-keyed player response still lands
        // in the fallback bucket; a keyed one stays scoped to its video.
        const tgt = entryFor(d.videoId ?? null);
        if (Array.isArray(d.captionTracks) && d.captionTracks.length) {
          tgt.captionTracks = d.captionTracks;
        }
        if (d.poToken) {
          tgt.poToken = d.poToken;
        }
      }
    } catch {
      /* ignore malformed events */
    }
  });
}

/**
 * Captured caption data for a videoId, merged with the latest fallback bucket
 * when the per-video entry is empty. Always returns a usable object.
 */
export function getYtMainWorldData(videoId: string): YtCaptured {
  const e = byVideo.get(videoId);
  return {
    ccUrls: e?.ccUrls.length ? e.ccUrls : latest.ccUrls,
    ccBodies: e?.ccBodies.length ? e.ccBodies : latest.ccBodies,
    captionTracks: e?.captionTracks ?? latest.captionTracks,
    poToken: e?.poToken ?? latest.poToken,
  };
}

/** Test-only: reset the in-memory caches. */
export function __resetYtMainWorldCache(): void {
  byVideo.clear();
  latest.ccUrls = [];
  latest.ccBodies = [];
  latest.captionTracks = undefined;
  latest.poToken = undefined;
}
