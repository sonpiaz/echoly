# MV3 Network + Real-Time Audio Architecture: Web Research Findings

**Research scope:** Best-practice architecture for network calls and real-time audio in a Chrome MV3
extension. All claims annotated with source URL and whether numbers are MEASURED or VENDOR-CLAIMED.

---

## 1. Service Worker Lifecycle: Termination Rules and Cold-Start Cost

### Official termination rules (Chrome team docs)

Source: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle

The extension service worker terminates under three conditions (exact Chrome docs text):

> "After 30 seconds of inactivity. Receiving an event or calling an extension API resets this timer."
> "When a single request, such as an event or API call, takes longer than 5 minutes to process."
> "When a fetch() response takes more than 30 seconds to arrive."

**Chrome 110 change** (effective Feb 2023, Chrome 110+):
Source: https://developer.chrome.com/blog/longer-esw-lifetimes

> "Starting in Chrome 110, extension service workers stay alive as long as they're receiving events."

The hard 5-minute absolute cap was removed. The idle timer is now reset by any extension event, not
just explicit API calls. This fixes the previous race where Chrome could terminate a worker even if a
new event was already queued. The 30-second idle timeout and the per-request 5-minute cap remain.
Source: https://developer.chrome.com/blog/extension-news-july-2023

### Cold-start cost: measured numbers

**The only measured hardware-specific numbers found** come from a March 2026 Chromium Extensions
mailing-list report (title: "MV3 service worker killed by StartTimeoutTimer on 6W TDP devices"):
Source: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/xpKX3yHwGCw

- **15W TDP** (i7-1065G7, i7-8565U): SW initialization ~**110 ms** (MEASURED by developer)
- **6W TDP** (Intel N6000): SW initialization ~**5,400 ms** (MEASURED by developer)
- Same devices: setTimeout(100) fires after 340–780 ms (15W) vs 4,000–23,700 ms (6W) — severe
  scheduler inflation on low-power hardware.

These are developer-reported measurements, not Chrome team benchmarks. No official cold-start number
exists in Chrome documentation. **STATUS: MEASURED, but single-reporter source on mailing list.**

**Web service worker cold-start for comparison**: Lighthouse/Google data indicates web SW boot-up
is 200–500 ms range on typical hardware (Source: https://github.com/GoogleChrome/lighthouse/issues/3861
— measured via Lighthouse audit). Extension SWs are a different code path but the order of magnitude
is comparable on normal hardware.

### State loss on SW restart

From Microsoft Engineering's Accessibility Insights MV3 migration post:
Source: https://devblogs.microsoft.com/engineering-at-microsoft/learnings-from-migrating-accessibility-insights-for-web-to-chromes-manifest-v3/

> "it introduced a small performance overhead that was not present when we were simply maintaining data in process"

They shifted from in-memory state (persistent background page) to IndexedDB-backed state, accepting
this overhead. No measurement provided — noted as "acceptable." **STATUS: CLAIMED, no number.**

eyeo (AdBlock Plus, 110 M+ users) migration findings:
Source: https://developer.chrome.com/blog/eyeos-journey-to-testing-mv3-service%20worker-suspension

> "we had to increase the timeouts of the tests because suspending and restarting service workers
> takes additional time."

No specific ms value given. Architecture conclusion: suspend-and-restart must be designed around;
they use fuzz testing (force-suspend before each test interaction). **STATUS: QUALITATIVE only.**

---

## 2. Offscreen Documents: The Official Home for WebRTC and Audio in MV3

### Why service workers cannot host WebRTC / Web Audio

Source: https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3

> "Manifest V3 extensions are service worker-based, but service workers don't provide support for
> the same APIs and mechanisms that full document-based pages do."

The fundamental constraint: service workers have no DOM, no window object, no AudioContext, no
RTCPeerConnection constructor. The Chrome offscreen API was built specifically to close this gap.

Source: https://developer.chrome.com/docs/extensions/reference/api/offscreen

Official reason codes (the declared `reasons` array when calling `chrome.offscreen.createDocument()`):

| Reason | What it grants |
|---|---|
| `AUDIO_PLAYBACK` | Audio playback (closes after 30 s without audio) |
| `USER_MEDIA` | `getUserMedia()` / microphone streams |
| `DISPLAY_MEDIA` | `getDisplayMedia()` / tab/screen capture |
| `WEB_RTC` | Full WebRTC APIs (`RTCPeerConnection` etc.) |
| `DOM_PARSER` | DOMParser |
| `WORKERS` | Spawn Web Workers inside the offscreen doc |

**The `WEB_RTC` reason is the official, documented path for WebRTC in MV3.** There is no alternative
— you cannot use RTCPeerConnection in a service worker or in a content script without the page's
explicit permission (and the page would own that context, not the extension).

### Lifecycle: does an offscreen document survive tab navigation?

Source: https://developer.chrome.com/docs/extensions/reference/api/offscreen (and W3C proposal #170
at https://github.com/w3c/webextensions/issues/170)

Key facts:
- **One offscreen document per extension** (hard limit).
- "The lifetime of an offscreen document is **independent of the service worker that created it**."
- The offscreen document has **no tab association** — it is extension-global, not tab-scoped.
- Therefore: navigating away from a page, or to another YouTube video, does NOT destroy the
  offscreen document. The WebRTC peer inside it persists until the extension explicitly calls
  `chrome.offscreen.closeDocument()` or the extension is unloaded.

**`AUDIO_PLAYBACK` exception**: this specific reason adds a 30-second automatic close timer if no
audio is playing. `WEB_RTC` has no automatic lifetime limit beyond the extension unload.

Source (W3C proposal, exact text):
> "Offscreen document lifetimes are not tied to the context that spawned them, meaning that an
> offscreen may outlive the service worker that created it."

### API restriction in offscreen documents

Source: https://developer.chrome.com/docs/extensions/reference/api/offscreen

> "The runtime API is the only extensions API supported by offscreen documents."

All control-plane communication with the service worker or content scripts must go through
`chrome.runtime.sendMessage` / `chrome.runtime.connect` (port-based long-lived connections).
The offscreen doc is a full web page for DOM purposes but restricted for extension APIs.

### Audio recording across navigation: official guidance

Source: https://developer.chrome.com/blog/chrome-116-beta-whats-new-for-extensions

> "record audio and video in the background using tabCapture and offscreen documents. Use the
> chrome.tabCapture API in a service worker to obtain a stream ID following a user gesture, which
> can then be passed to an offscreen document to start recording."

This is the Chrome team's own documented flow for background audio capture. The `DISPLAY_MEDIA` or
`USER_MEDIA` reason is used for capture; `AUDIO_PLAYBACK` for playback.

---

## 3. Content Script vs Background/SW for Network Calls: CORS and Fetch Context

### The CORS boundary change (hard security rule since Chrome 85-87)

Source: https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/

> "In Q2 2020, Chrome removed the ability to bypass CORS in cross-origin requests from content
> scripts beginning with Chrome 85."

> "Content scripts initiate requests on behalf of the web origin that the content script has been
> injected into and therefore content scripts are also subject to the same origin policy."

This means a content script on `youtube.com` that calls `fetch('https://api.echolyhq.com/...')` gets
an `Origin: https://www.youtube.com` request header, and the server must CORS-allow `youtube.com`
(or use a wildcard, which is a security anti-pattern). The extension's `host_permissions` do NOT
help the content script bypass this — they only help the background/SW context.

Source: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests

> "A script executing in an extension service worker or foreground tab can talk to remote servers
> outside of its origin, as long as the extension requests host permissions."

> "Cross-origin requests are always treated as such in content scripts, even if the extension has
> host permissions."

Official recommendation (Chrome security team):
> "perform them [cross-origin fetches] from the extension background page rather than in the content
> script. Relay the response to the content scripts as needed (e.g., using extension messaging APIs)."

Source: https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/

### Latency difference: content script fetch vs SW fetch

**No measured numbers found in any official or reputable source.** The architectural difference is:

- Content script fetch: runs on main thread of the tab's renderer process; adds message-passing
  overhead IF the result must be relayed back to content; subject to page CSP.
- SW fetch: runs in a separate worker process; no page CSP; extension origin (`chrome-extension://`);
  requires a `chrome.runtime.sendMessage` round-trip if content initiated it.

The round-trip cost of `chrome.runtime.sendMessage` (content → SW → content) involves IPC across
process boundaries. Chrome's own docs describe JSON serialization as the mechanism
(Source: https://developer.chrome.com/docs/extensions/develop/concepts/messaging).
No ms benchmark was found in official docs or reputable engineering blogs for this specific round-trip.

**Indirect evidence from DebugBear content script benchmarks:**
Source: https://www.debugbear.com/blog/measuring-the-performance-impact-of-chrome-extensions

Content scripts (Grammarly, Honey) added 224–636 ms of CPU overhead per page load — but this
measures *content script total execution*, not the fetch or IPC cost alone. **STATUS: MEASURED
but not the right metric for per-fetch overhead.**

### Recommendation from the Chrome team

Route all cross-origin fetches through the SW (or offscreen doc for long-lived connections). Never
rely on content script CORS bypass — it was removed in Chrome 85 and the content script's origin
context is the *page's* origin, not the extension's.

---

## 4. declarativeNetRequest vs Fetch Proxying (Brief)

Source: https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest

`declarativeNetRequest` (DNR) is for **blocking/redirecting/modifying existing network requests from
pages** (ad blocking, header injection). It is evaluated in a separate C++ engine before requests hit
the network. It is NOT a mechanism for making new requests on behalf of the extension.

For extension-initiated API calls (e.g., posting audio to a translation endpoint), DNR is not
applicable. The SW or offscreen doc makes those fetches directly.

No measured latency comparison between DNR and fetch proxy was found in available sources.

---

## 5. MV3 Latency Pitfalls: Message Passing and SW Respawn

### SW respawn on each event

From the Chrome lifecycle docs and Microsoft Engineering post:
- Every termination + respawn requires re-running the SW's `install`/`activate` cycle and re-loading
  all module code from disk.
- Global JS state (in-memory maps, WebSocket connections, RTCPeerConnections) is destroyed.
- For latency-critical paths: if the SW was idle and a tab sends a message, the response round-trip
  includes SW boot time. On normal hardware this is ~110 ms (measured, single source); on low-power
  hardware it has been measured at 5,400 ms.

### Message-passing overhead

Source: https://developer.chrome.com/docs/extensions/develop/concepts/messaging

Chrome uses **JSON serialization** (not structured clone) for runtime messages. Max message size
is 64 MiB. No official latency benchmark in docs.

Indirect reference: for extension-based WebRTC proxy work (academic paper "Hector: Using Untrusted
Browsers to Provision Web Applications", https://arxiv.org/pdf/2010.09512):
> "For smaller payloads up to 4 KB, plain WebRTC adds 1-2 ms and Hector additionally adds 3-4 ms"

This is the closest measured number found for extension message-passing overhead on the data plane,
but it is for a specific WebRTC relay research extension with a different architecture.
**STATUS: MEASURED, academic context, not directly applicable to chrome.runtime.sendMessage.**

### SW keep-alive patterns

SW wake-up can be prevented by:
1. Native messaging connections (strong keepalive, cancels both timers per Chrome docs).
2. WebSocket activity (resets idle timer since Chrome 116, per extension-news-july-2023).
3. Alarm API pings (resets timer but costs an IPC each ping).
4. Keeping the offscreen document active (does NOT keep the SW alive, but the offscreen doc itself
   stays alive — the SW can be respawned cheaply because state lives in the offscreen doc).

---

## Best-Practice Decision Table

| Decision | Recommended | Why | Source | Measured number |
|---|---|---|---|---|
| Where does WebRTC peer connection live? | **Offscreen document** (WEB_RTC reason) | SWs have no DOM/RTCPeerConnection; content scripts are tab-scoped and destroyed on navigation | https://developer.chrome.com/docs/extensions/reference/api/offscreen | None in docs |
| Where does audio playback live? | **Offscreen document** (AUDIO_PLAYBACK reason) | SWs cannot play audio; content script audio is destroyed on navigation | https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3 | None in docs |
| Where do cross-origin API fetches originate? | **SW or offscreen document** (NOT content script) | Content scripts lost CORS bypass in Chrome 85 (2020); origin = page, not extension | https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/ | Hard rule, Chrome 85+ |
| What is the SW cold-start cost? | N/A (avoid latency-critical reliance on a dormant SW) | 110 ms on 15W hardware; up to 5,400 ms on 6W hardware | https://groups.google.com/a/chromium.org/g/chromium-extensions/c/xpKX3yHwGCw | MEASURED (single reporter) |
| Does offscreen doc survive tab navigation? | Yes — extension-global, not tab-scoped | Lifetime independent of SW and tab; no tab association | https://github.com/w3c/webextensions/issues/170 | Structural guarantee |
| AUDIO_PLAYBACK vs WEB_RTC reason for a WebRTC audio session | **Both** (combine reasons since Chrome 115) | AUDIO_PLAYBACK has 30 s auto-close without audio; WEB_RTC has no timer; both needed for full WebRTC+audio | https://developer.chrome.com/blog/extension-news-july-2023 | None |
| Message-passing overhead (content ↔ SW) | Minimize round-trips; prefer long-lived ports (runtime.connect) over sendMessage per audio packet | JSON serialization per message; IPC cross-process; no official latency number but SW respawn adds 110–5,400 ms | https://developer.chrome.com/docs/extensions/develop/concepts/messaging | CLAIMED "small overhead" (MSFT); no ms number |
| SW idle keepalive for control plane | Native messaging connection OR WebSocket (Chrome 116+) as strong keepalive | Cancels idle timer; prevents cold-start on next message | https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle | None |

---

## Verdict

For a latency-critical real-time audio extension (WebRTC voice-to-voice dubbing):

**The WebRTC peer connection and all audio processing MUST live in an offscreen document** declared
with `reasons: ["WEB_RTC", "AUDIO_PLAYBACK"]` (combinable since Chrome 115). This is not a style
preference — the APIs do not exist in the service worker context, and a content-script peer
connection is destroyed on every tab navigation (SPA navigation on YouTube, ad plays, video change).

**All cross-origin data-plane fetches** (to `api.echolyhq.com`) should originate from the SW or the
offscreen document, never from the content script. The CORS restriction since Chrome 85 makes content
script cross-origin fetches unreliable unless the server CORS-allows the *page* origin (youtube.com,
udemy.com, etc.) — which is operationally unacceptable and a security anti-pattern.

**The service worker** is the right home for: event handling (extension events, message routing,
alarm management, session state coordination). It is NOT the right home for: long-lived WebRTC
connections, audio playback, or any fetch where SW dormancy would add cold-start latency to the
critical path. State the SW needs across respawns should be in `chrome.storage` or IndexedDB.

**Where evidence is thin:**
- No official Chrome team document provides a cold-start latency number in ms. The 110 ms / 5,400 ms
  figures come from a single developer report on the Chromium mailing list (March 2026).
- No official or third-party benchmark for `chrome.runtime.sendMessage` IPC round-trip latency in ms
  was found. The 3–4 ms figure is from an academic paper for a different extension architecture.
- No measured comparison of direct content-script fetch latency vs SW-proxied fetch was found.
  The correctness argument (CORS) is documented; the latency argument is architectural inference only.

---

## Sources (all URLs)

- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/blog/longer-esw-lifetimes
- https://developer.chrome.com/blog/extension-news-july-2023
- https://developer.chrome.com/docs/extensions/reference/api/offscreen
- https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3
- https://developer.chrome.com/blog/chrome-116-beta-whats-new-for-extensions
- https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/
- https://developer.chrome.com/blog/eyeos-journey-to-testing-mv3-service%20worker-suspension
- https://devblogs.microsoft.com/engineering-at-microsoft/learnings-from-migrating-accessibility-insights-for-web-to-chromes-manifest-v3/
- https://groups.google.com/a/chromium.org/g/chromium-extensions/c/xpKX3yHwGCw
- https://github.com/w3c/webextensions/issues/170
- https://www.debugbear.com/blog/measuring-the-performance-impact-of-chrome-extensions
- https://arxiv.org/pdf/2010.09512
- https://github.com/GoogleChrome/lighthouse/issues/3861
