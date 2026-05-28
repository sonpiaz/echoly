// Echoly content script — owns WebRTC PeerConnection lifecycle, the in-page
// overlay panel, and YT video element capture. Background tells us when to
// start/stop/update; we tell background what's happening via CONTENT_STATE.
//
// Layered: F9 version guard, F6 token-guarded async, F5 captureStream retry,
// F1 overlay panel, F2 history, F3 source captions, F4 handover.

(() => {
  // ───── F9 — Idempotent version guard ──────────────────────────────────────
  const ECHOLY_VERSION = "0.6.1";
  const GLOBAL_KEY = "__echolyContentVersion";
  if (window[GLOBAL_KEY] === ECHOLY_VERSION) return;
  // Older copy may have left UI behind; clean up before re-installing listeners.
  document.querySelectorAll(".ec-root").forEach((el) => el.remove());
  window[GLOBAL_KEY] = ECHOLY_VERSION;

  // ───── Constants ──────────────────────────────────────────────────────────
  // KYMA_BASE is the BYOK fallback. v0.6.1: background.js may pass an alt
  // apiBase (Echoly's server proxy) in settings.apiBase when the user is
  // signed in without their own Kyma key. Sites that fetch Kyma read the
  // session-scoped `apiBase` instead of this constant when set.
  const KYMA_BASE = "https://api.kymaapi.com/v1";
  let apiBase = KYMA_BASE;   // overwritten on each session start
  const OPENAI_CALLS_URL = "https://api.openai.com/v1/realtime/translations/calls";
  const SESSION_LIMIT_MS = 60 * 60 * 1000;
  const SESSION_WARNING_MS = 55 * 60 * 1000;
  const HEARTBEAT_MS = 30_000;
  const CAPTION_POLL_MS = 350;
  const HISTORY_MAX = 16;
  const VOICE_GAIN_MAX = 2.0;          // unity at slider 50, 2× boost at 100
  const LAYOUT_KEY = "echolyOverlayLayout";
  const RTL_LANGS = new Set(["ar", "fa", "he", "ur"]);

  const LANGUAGES = [
    ["en", "English"], ["vi", "Vietnamese"], ["ja", "Japanese"],
    ["ko", "Korean"], ["zh", "Chinese"], ["fr", "French"],
    ["es", "Spanish"], ["de", "German"], ["pt", "Portuguese"],
    ["hi", "Hindi"], ["id", "Indonesian"], ["it", "Italian"],
    ["ru", "Russian"],
  ];
  const LANG_NAME = Object.fromEntries(LANGUAGES);
  const REALTIME_VOICES = [
    "marin", "alloy", "ash", "ballad", "coral",
    "echo", "sage", "shimmer", "verse",
  ];
  // Standard tier voices — Minimax `speech-02-turbo` IDs. Cross-language: each
  // voice handles all 13 target languages. Curated 2026-05-08.
  const STANDARD_VOICES = [
    ["English_magnetic_voiced_man",   "Magnetic Man"],
    ["English_captivating_female1",   "Captivating Female"],
    ["English_ManWithDeepVoice",      "Deep Voice Man"],
    ["English_ConfidentWoman",        "Confident Woman"],
    ["Chinese (Mandarin)_News_Anchor","News Anchor"],
  ];
  const STANDARD_DEFAULT_VOICE = STANDARD_VOICES[0][0];

  // Standard pipeline tunables. CHUNK_MS too short = wasteful per-call
  // overhead; too long = unbearable lag. 5s is the sweet spot for podcast/
  // keynote speech where sentences average 3-6s.
  const STANDARD_CHUNK_MS = 5000;
  const STANDARD_MIN_CHUNK_BYTES = 2000;  // sub-2KB blobs are silence
  const STANDARD_RECORDER_MIMES = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];

  // ───── F6 — Token-guarded session state ───────────────────────────────────
  // Every async callback that could mutate session state captures `pageToken`
  // in closure and checks `if (token !== pageToken) return` before mutating.
  // Each new session bumps pageToken so stale callbacks are silently dropped.
  let pageToken = 0;
  let session = null;     // active session
  let prevSession = null; // held during handover until new is fully ready
  let settings = null;
  let history = [];
  let currentTargetText = "";
  let currentSourceText = "";
  let captionPollTimer = null;
  let heartbeatTimer = null;
  let warningTimer = null;
  let limitTimer = null;
  let warningShown = false;
  let videoEl = null;
  let onYTPause = null;
  let onYTPlay = null;
  let lastSpaUrl = location.href;
  let layout = loadLayout();
  // SF3 — Original-volume drift guard: YouTube's player re-applies its
  // own internally-cached volume on certain events (ad insertion, video
  // element refresh, etc.), stomping our `video.volume = X` write. We
  // hook `volumechange` and snap the volume back to our desired value
  // when drift is detected. `desiredOriginalVol` < 0 means "not engaged"
  // (no session active); >=0 is the value we're enforcing. The write
  // timestamp avoids a feedback loop with our own writes triggering the
  // same listener.
  let desiredOriginalVol = -1;
  let lastOriginalWriteAt = 0;
  let onVolumeDrift = null;
  // SF8 Phase 1 — Playback-rate awareness. Real fix (rate-aware scheduling
  // + Realtime model research) is later phases. For now we just warn the
  // user that translation may drift at non-1× speeds, so they have the
  // right expectation. Toast is debounced so a series of rate changes
  // (e.g. dragging YT's speed slider) doesn't spam.
  let onRateChange = null;
  let lastRateToastAt = 0;

  // ───── Background channel ─────────────────────────────────────────────────
  // Extension reload (dev mode update or Chrome auto-update) invalidates the
  // content script's runtime handle. After that, sendMessage throws SYNC
  // ("Extension context invalidated") — .catch() can't catch a sync throw,
  // so wrap the whole call. Once invalidated we also stop emitting and tear
  // down the overlay so the orphaned script doesn't keep firing.
  let runtimeAlive = true;
  function notifyBackground(msg) {
    if (!runtimeAlive) return;
    try {
      const res = chrome.runtime?.id ? chrome.runtime.sendMessage(msg) : null;
      if (res && typeof res.catch === "function") res.catch(() => {});
    } catch (err) {
      if (String(err?.message || err).includes("Extension context invalidated")) {
        runtimeAlive = false;
        try { handleUnload?.(); } catch {}
      }
    }
  }
  function emitState(partial) {
    notifyBackground({ type: "CONTENT_STATE", ...partial });
  }
  function emitEnded(reason) {
    notifyBackground({ type: "CONTENT_ENDED", reason });
  }

  // ───── F1 — Overlay panel ─────────────────────────────────────────────────
  let root = null;
  let elements = {};

  function loadLayout() {
    try {
      return {
        left: null, top: null, width: null, height: null, sideCollapsed: false,
        ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}"),
      };
    } catch {
      return { left: null, top: null, width: null, height: null, sideCollapsed: false };
    }
  }
  function saveLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {}
  }
  function clampLayout() {
    const maxW = Math.max(300, window.innerWidth - 24);
    const maxH = Math.max(130, window.innerHeight - 24);
    const w = Math.min(Math.max(layout.width || 560, 300), maxW);
    const h = Math.min(Math.max(layout.height || 200, 130), maxH);
    const left = Math.min(
      Math.max(layout.left ?? window.innerWidth - w - 24, 12),
      Math.max(12, window.innerWidth - w - 12),
    );
    const top = Math.min(
      Math.max(layout.top ?? window.innerHeight - h - 96, 12),
      Math.max(12, window.innerHeight - h - 12),
    );
    layout = { ...layout, left, top, width: w, height: h };
  }
  function applyLayout() {
    if (!root) return;
    clampLayout();
    root.style.left = layout.left + "px";
    root.style.top = layout.top + "px";
    root.style.width = layout.width + "px";
    root.style.height = layout.height + "px";
    root.style.right = "auto";
    root.style.bottom = "auto";
    root.classList.toggle("is-side-collapsed", !!layout.sideCollapsed);
    root.classList.toggle("is-compact", layout.width < 560 || layout.height < 210);
    root.classList.toggle("is-roomy", layout.width > 760 && layout.height > 235);
    root.style.setProperty(
      "--ec-target-lines",
      String(Math.max(2, Math.min(8, Math.floor((layout.height - 74) / 38)))),
    );
    if (elements.hideBtn) {
      elements.hideBtn.textContent = layout.sideCollapsed ? "Show" : "Hide";
    }
  }

  function buildOverlay() {
    if (root) return;
    root = document.createElement("aside");
    root.className = "ec-root";
    root.dataset.state = "ready";
    root.innerHTML = `
      <div class="ec-toolbar" data-ec-drag>
        <span class="ec-brand">
          <span class="ec-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <path d="M7 9v6M11 6v12M15 8v8M19 11v2"/>
            </svg>
          </span>
          <span class="ec-wordmark">Echoly</span>
          <span class="ec-state" data-ec-status>Ready</span>
        </span>
        <span class="ec-spacer"></span>
        <select class="ec-select" data-ec-language aria-label="Target language"></select>
        <select class="ec-select" data-ec-voice aria-label="Voice"></select>
        <button class="ec-btn" type="button" data-ec-hide>Hide</button>
        <button class="ec-btn ec-btn-primary" type="button" data-ec-stop>Stop</button>
      </div>
      <div class="ec-body">
        <div class="ec-main">
          <div class="ec-target" data-ec-target></div>
        </div>
        <div class="ec-side" data-ec-side>
          <div class="ec-source" data-ec-source hidden></div>
          <div class="ec-history" data-ec-history hidden></div>
        </div>
      </div>
      <span class="ec-resize-edge ec-resize-edge-n" data-ec-resize="n"></span>
      <span class="ec-resize-edge ec-resize-edge-e" data-ec-resize="e"></span>
      <span class="ec-resize-edge ec-resize-edge-s" data-ec-resize="s"></span>
      <span class="ec-resize-edge ec-resize-edge-w" data-ec-resize="w"></span>
      <span class="ec-resize-corner ec-resize-corner-nw" data-ec-resize="nw"></span>
      <span class="ec-resize-corner ec-resize-corner-ne" data-ec-resize="ne"></span>
      <span class="ec-resize-corner ec-resize-corner-sw" data-ec-resize="sw"></span>
      <span class="ec-resize-corner ec-resize-corner-se" data-ec-resize="se"></span>
    `;
    document.documentElement.appendChild(root);

    elements = {
      status: root.querySelector("[data-ec-status]"),
      langSelect: root.querySelector("[data-ec-language]"),
      voiceSelect: root.querySelector("[data-ec-voice]"),
      target: root.querySelector("[data-ec-target]"),
      source: root.querySelector("[data-ec-source]"),
      history: root.querySelector("[data-ec-history]"),
      hideBtn: root.querySelector("[data-ec-hide]"),
      stopBtn: root.querySelector("[data-ec-stop]"),
      drag: root.querySelector("[data-ec-drag]"),
    };

    // Populate language picker
    for (const [code, name] of LANGUAGES) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = name;
      elements.langSelect.appendChild(opt);
    }

    populateVoicePicker(settings?.tier || "realtime");
    elements.langSelect.value = settings?.targetLanguage || "vi";

    elements.langSelect.addEventListener("change", () => {
      const newLang = elements.langSelect.value;
      if (settings?.tier === "standard") {
        // Standard pipeline picks up the new prompt on the next chunk; no
        // tear-down needed. Push to background so popup stays in sync.
        settings.targetLanguage = newLang;
        notifyBackground({ type: "UPDATE_SETTINGS", settings: { targetLanguage: newLang } });
        setStatusText("Switching to " + (LANG_NAME[newLang] || newLang));
        setOverlayState("live");
      } else {
        requestHandover({ targetLanguage: newLang });
      }
    });
    elements.voiceSelect.addEventListener("change", () => {
      const newVoice = elements.voiceSelect.value;
      if (settings?.tier === "standard") {
        settings.standardVoice = newVoice;
        notifyBackground({ type: "UPDATE_SETTINGS", settings: { standardVoice: newVoice } });
      } else {
        requestHandover({ realtimeVoice: newVoice });
      }
    });
    elements.hideBtn.addEventListener("click", () => {
      layout.sideCollapsed = !layout.sideCollapsed;
      saveLayout();
      applyLayout();
    });
    elements.stopBtn.addEventListener("click", () => {
      stopSession("user-stop");
      notifyBackground({ type: "CONTENT_STATE", running: false, status: "Stopped" });
      emitEnded("Stopped");
    });

    bindDragResize();
    applyLayout();

    window.addEventListener("resize", applyLayout);
  }

  // Tier-aware voice list rebuild. Realtime exposes 9 OpenAI voices + Auto;
  // Standard exposes 5 curated Minimax voices. Called from buildOverlay and
  // on tier change so the dropdown matches the active pipeline.
  function populateVoicePicker(tier) {
    if (!elements.voiceSelect) return;
    elements.voiceSelect.replaceChildren();
    if (tier === "standard") {
      for (const [id, name] of STANDARD_VOICES) {
        const opt = document.createElement("option");
        opt.value = id; opt.textContent = name;
        elements.voiceSelect.appendChild(opt);
      }
      elements.voiceSelect.value = settings?.standardVoice || STANDARD_DEFAULT_VOICE;
    } else {
      const autoOpt = document.createElement("option");
      autoOpt.value = ""; autoOpt.textContent = "Auto";
      elements.voiceSelect.appendChild(autoOpt);
      for (const v of REALTIME_VOICES) {
        const opt = document.createElement("option");
        opt.value = v; opt.textContent = v.charAt(0).toUpperCase() + v.slice(1);
        elements.voiceSelect.appendChild(opt);
      }
      elements.voiceSelect.value = settings?.realtimeVoice ?? "marin";
    }
  }

  function setOverlayState(state) {
    if (root) root.dataset.state = state;
  }
  function setStatusText(text) {
    if (elements.status) elements.status.textContent = text;
  }
  function setTargetText(text) {
    if (!elements.target) return;
    elements.target.textContent = text;
    const lang = settings?.targetLanguage;
    elements.target.dir = RTL_LANGS.has(lang) ? "rtl" : "ltr";
  }
  // Toast accepts plain text + optional CTA. Built via DOM APIs (not innerHTML)
  // because the text often comes from upstream API errors — a crafted error
  // body would otherwise be an XSS vector inside youtube.com's origin.
  function showToast(text, opts, durationMs) {
    if (!root) return;
    if (typeof opts === "number") { durationMs = opts; opts = null; }
    if (!durationMs) durationMs = 8000;
    let toast = root.querySelector(".ec-toast");
    if (toast) toast.remove();
    toast = document.createElement("div");
    toast.className = "ec-toast";
    toast.textContent = String(text || "");
    if (opts && opts.cta) {
      toast.append(" ");
      const a = document.createElement("a");
      a.href = String(opts.cta);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = String(opts.ctaLabel || "Open");
      toast.appendChild(a);
    }
    root.appendChild(toast);
    setTimeout(() => toast.remove(), durationMs);
  }
  function removeOverlay() {
    if (!root) return;
    window.removeEventListener("resize", applyLayout);
    root.remove();
    root = null;
    elements = {};
  }

  // ───── Drag + resize ──────────────────────────────────────────────────────
  function bindDragResize() {
    let dragMode = null;
    let pointer = null;

    elements.drag.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button, select, input")) return;
      dragMode = "move";
      pointer = capturePointer(e);
      root.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    for (const handle of root.querySelectorAll("[data-ec-resize]")) {
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        dragMode = "resize-" + handle.dataset.ecResize;
        pointer = capturePointer(e);
        handle.setPointerCapture?.(e.pointerId);
        e.preventDefault();
      });
    }

    root.addEventListener("pointermove", (e) => {
      if (!dragMode || !pointer) return;
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      if (dragMode === "move") {
        layout.left = pointer.left + dx;
        layout.top = pointer.top + dy;
      } else {
        const m = dragMode.slice(7);  // remove "resize-"
        if (m.includes("e")) layout.width = pointer.width + dx;
        if (m.includes("s")) layout.height = pointer.height + dy;
        if (m.includes("w")) {
          layout.width = pointer.width - dx;
          layout.left = pointer.left + dx;
        }
        if (m.includes("n")) {
          layout.height = pointer.height - dy;
          layout.top = pointer.top + dy;
        }
      }
      applyLayout();
    });

    root.addEventListener("pointerup", () => {
      if (dragMode) saveLayout();
      dragMode = null;
      pointer = null;
    });
    root.addEventListener("pointercancel", () => {
      dragMode = null;
      pointer = null;
    });
  }
  function capturePointer(e) {
    const rect = root.getBoundingClientRect();
    return {
      x: e.clientX, y: e.clientY,
      left: layout.left ?? rect.left,
      top: layout.top ?? rect.top,
      width: layout.width ?? rect.width,
      height: layout.height ?? rect.height,
    };
  }

  // ───── F2 — History rendering ─────────────────────────────────────────────
  function pushHistoryTurn(opts = {}) {
    if (!currentTargetText && !opts.marker) return;
    const entry = {
      time: new Date().toTimeString().slice(0, 5),
      target: currentTargetText.slice(0, 280),
      source: currentSourceText.slice(0, 220),
      lang: settings?.targetLanguage,
      voice: settings?.realtimeVoice,
      marker: opts.marker || null,
    };
    history.unshift(entry);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    currentTargetText = "";
    renderHistory();
  }
  function renderHistory() {
    if (!elements.history) return;
    elements.history.replaceChildren();
    if (!history.length) {
      elements.history.hidden = true;
      return;
    }
    elements.history.hidden = false;
    for (const turn of history) {
      if (turn.marker) {
        const wrap = document.createElement("div");
        wrap.className = "ec-h-marker";
        const chip = document.createElement("span");
        chip.className = "ec-h-marker-chip";
        chip.textContent = turn.marker;
        wrap.appendChild(chip);
        elements.history.appendChild(wrap);
      }
      const item = document.createElement("div");
      item.className = "ec-h-item";
      const meta = document.createElement("span");
      meta.className = "ec-h-meta";
      meta.textContent = turn.time;
      const text = document.createElement("span");
      text.className = "ec-h-text";
      text.textContent = turn.target;
      item.append(meta, text);
      elements.history.appendChild(item);
    }
  }

  // ───── F3 — Source caption polling ────────────────────────────────────────
  let lastSeenCaption = "";
  function readYTCaptions() {
    const segs = document.querySelectorAll(".ytp-caption-segment");
    return Array.from(segs).map((s) => s.textContent).join(" ").trim().replace(/\s+/g, " ");
  }
  function startCaptionPoll() {
    stopCaptionPoll();
    lastSeenCaption = "";
    captionPollTimer = setInterval(() => {
      if (!settings?.showSource) return;
      const text = readYTCaptions();
      if (!text || text === lastSeenCaption) return;
      lastSeenCaption = text;
      currentSourceText = text;
      if (elements.source) {
        elements.source.textContent = text.slice(-220);
      }
    }, CAPTION_POLL_MS);
  }
  function stopCaptionPoll() {
    if (captionPollTimer) {
      clearInterval(captionPollTimer);
      captionPollTimer = null;
    }
  }
  function applySourceVisibility() {
    if (!elements.source) return;
    elements.source.hidden = !settings?.showSource;
  }

  // ───── F5 — captureStream re-acquisition with playback nudge ──────────────
  function findVideo() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }
  // Live streams report duration === Infinity (or NaN before metadata).
  // Non-live VOD has a finite duration. Used to skip the pause-then-play
  // sync orchestration on live, where pausing would push the user out of
  // the live edge into DVR mode permanently.
  function isLive(video) {
    return !video || !isFinite(video.duration);
  }
  function nudgePlay(video) {
    if (!video.paused) return Promise.resolve();
    const p = video.play();
    if (!p?.then) return Promise.resolve();
    return Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 250))]);
  }
  async function captureWithRetry(video, timeoutMs = 9000) {
    if (typeof video.captureStream !== "function" && typeof video.mozCaptureStream !== "function") {
      throw new Error("This Chrome build cannot capture YouTube audio.");
    }
    const start = Date.now();
    let lastStream;
    while (Date.now() - start < timeoutMs) {
      if (video.paused) await nudgePlay(video);
      lastStream = (video.captureStream || video.mozCaptureStream).call(video);
      if (lastStream.getAudioTracks().length) {
        return new MediaStream(lastStream.getAudioTracks());
      }
      lastStream.getTracks().forEach((t) => t.stop());
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("YouTube audio not ready. Press play, then Start again.");
  }

  // ───── Kyma error parser ──────────────────────────────────────────────────
  function parseKymaError(status, errText) {
    try {
      const parsed = JSON.parse(errText);
      const err = parsed.error || {};
      if (err.code === "insufficient_balance") {
        const cta = err.cta_url || "https://kymaapi.com/billing";
        return { user: "Out of Kyma balance.", cta, ctaLabel: "Top up" };
      }
      if (err.code === "too_many_sessions") {
        return { user: "Three sessions already running. Stop one or wait." };
      }
      if (err.code === "upstream_error") {
        return { user: "Provider unreachable. Try again shortly." };
      }
      if (err.code === "rate_limited") {
        return { user: "Provider rate limit hit. Wait 30s." };
      }
      if (err.message) return { user: "Kyma " + status + ": " + err.message };
    } catch {}
    return { user: "Kyma " + status + ": " + (errText || "").slice(0, 160) };
  }

  // ───── Heartbeat + session timer (60-min cap, one-shot 55-min warning) ────
  function startHeartbeat(kymaSessionId, kymaKey) {
    stopHeartbeat();
    if (!kymaSessionId || !kymaKey) return;
    heartbeatTimer = setInterval(() => {
      if (!session) return;
      fetch(`${apiBase}/realtime/translations/sessions/${kymaSessionId}/heartbeat`, {
        method: "POST",
        headers: { Authorization: "Bearer " + kymaKey },
      }).catch(() => {});
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function startSessionTimer() {
    clearSessionTimer();
    warningShown = false;
    warningTimer = setTimeout(() => {
      if (warningShown) return;
      warningShown = true;
      showToast("Session ends in 5 min", 6000);
    }, SESSION_WARNING_MS);
    limitTimer = setTimeout(() => {
      stopSession("auto-stop-60min");
      emitEnded("Auto-stopped at 60 min — start again to continue.");
    }, SESSION_LIMIT_MS);
  }
  function clearSessionTimer() {
    if (warningTimer) { clearTimeout(warningTimer); warningTimer = null; }
    if (limitTimer) { clearTimeout(limitTimer); limitTimer = null; }
  }

  // ───── End Kyma session (release collateral immediately, no 90s wait) ─────
  async function endKymaSession(kymaSessionId, kymaKey) {
    if (!kymaSessionId || !kymaKey) return;
    try {
      await fetch(`${apiBase}/realtime/translations/sessions/${kymaSessionId}/end`, {
        method: "POST",
        headers: { Authorization: "Bearer " + kymaKey },
        keepalive: true,
      });
    } catch {}
  }

  // Waits for the PeerConnection to reach "connected" state, or resolves
  // false on timeout / failure. Used to gate `video.play()` on the
  // non-live Realtime sync flow so audio capture starts only once the
  // WebRTC channel can actually accept it (SF6).
  function waitForPCConnected(pc, timeoutMs = 3000) {
    if (pc.connectionState === "connected") return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        pc.removeEventListener("connectionstatechange", handler);
        clearTimeout(timer);
        resolve(ok);
      };
      const handler = () => {
        if (pc.connectionState === "connected") finish(true);
        else if (pc.connectionState === "failed" || pc.connectionState === "closed") finish(false);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      pc.addEventListener("connectionstatechange", handler);
    });
  }

  // ───── Session core (build PeerConnection through Kyma → OpenAI) ─────────
  async function buildRealtimeSession(token, audioStream, opts) {
    const kymaKey = opts.kymaKey;
    const lang = opts.targetLanguage || "vi";
    const voice = opts.realtimeVoice || "";

    setStatusText("Connecting");
    setOverlayState("connecting");

    let mintResp;
    try {
      mintResp = await fetch(`${apiBase}/realtime/translations/client_secrets`, {
        method: "POST",
        headers: { Authorization: "Bearer " + kymaKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          session: {
            model: "gpt-realtime-translate",
            audio: { output: { language: lang, ...(voice ? { voice } : {}) } },
          },
        }),
      });
    } catch (e) {
      throw new Error("Network error reaching Kyma.");
    }
    if (token !== pageToken) throw new Error("Stale session.");
    if (!mintResp.ok) {
      const text = await mintResp.text().catch(() => "");
      const parsed = parseKymaError(mintResp.status, text);
      const err = new Error(parsed.user);
      err.cta = parsed.cta;
      err.ctaLabel = parsed.ctaLabel;
      throw err;
    }
    const mint = await mintResp.json();
    if (token !== pageToken) throw new Error("Stale session.");
    const clientSecret = mint.value;
    const kymaSessionId = mint.kyma_session_id;
    if (!clientSecret) throw new Error("Kyma response missing client_secret.");

    const pc = new RTCPeerConnection();
    for (const track of audioStream.getAudioTracks()) pc.addTrack(track, audioStream);

    const dc = pc.createDataChannel("oai-events");
    dc.addEventListener("message", (e) => {
      if (token !== pageToken && session?.token !== token) return;
      handleRealtimeEvent(e.data, token);
    });

    // Pre-create AudioContext + outputGain BEFORE registering ontrack, so
    // the Voice volume slider has a valid target the moment the session
    // is returned to startSession — even before the first remote audio
    // track arrives (which can be 2-5s into a Realtime cold-start). The
    // ontrack handler then just wires the remote stream into the existing
    // graph. (SF3 fix.)
    let preCtx = null;
    let preGain = null;
    try {
      preCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (preCtx.state === "suspended") preCtx.resume().catch(() => {});
      preGain = preCtx.createGain();
      preGain.gain.value = computeGain(settings?.voiceVolume ?? 100);
      preGain.connect(preCtx.destination);
    } catch {
      try { preCtx?.close(); } catch {}
      preCtx = null;
      preGain = null;
    }

    const newSession = {
      token, pc, dc,
      stream: audioStream,
      remoteAudio: null,
      audioCtx: preCtx,
      outputGain: preGain,
      kymaSessionId,
      kymaKey,
      targetLanguage: lang,
      realtimeVoice: voice,
    };

    pc.addEventListener("track", (event) => {
      if (newSession.remoteAudio) return;
      const audio = document.createElement("audio");
      audio.autoplay = true;
      // Default to muted; flipped to false if we have to fall back to
      // HTMLAudio playback (no Web Audio path or it's stuck suspended).
      audio.muted = true;
      audio.srcObject = event.streams[0];
      document.body.appendChild(audio);
      newSession.remoteAudio = audio;

      const ctxRunning =
        newSession.audioCtx &&
        newSession.audioCtx.state !== "closed";
      if (newSession.outputGain && ctxRunning) {
        try {
          const src = newSession.audioCtx.createMediaStreamSource(event.streams[0]);
          src.connect(newSession.outputGain);
          // Best-effort second resume in case ctx is still suspended at
          // track time (some Chrome versions block initial resume until
          // first node connect).
          if (newSession.audioCtx.state === "suspended") {
            newSession.audioCtx.resume().catch(() => {});
          }
        } catch {
          // Web Audio wiring failed mid-flight. Tear down Web Audio path
          // and play through the HTMLAudio element instead (capped at 1.0).
          try { newSession.audioCtx.close(); } catch {}
          newSession.audioCtx = null;
          newSession.outputGain = null;
          audio.muted = false;
          audio.volume = Math.min((settings?.voiceVolume ?? 100) / 100, 1.0);
        }
      } else {
        // No usable Web Audio context — HTMLAudio fallback.
        if (newSession.audioCtx) { try { newSession.audioCtx.close(); } catch {} }
        newSession.audioCtx = null;
        newSession.outputGain = null;
        audio.muted = false;
        audio.volume = Math.min((settings?.voiceVolume ?? 100) / 100, 1.0);
      }
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      if (token !== pageToken && session?.token !== token) return;
      if (["closed", "failed", "disconnected"].includes(pc.iceConnectionState)) {
        // Network drop or remote close
        if (newSession === session) {
          stopSession("connection-lost");
          emitEnded("Connection lost.");
        }
      }
    });

    const offer = await pc.createOffer();
    if (token !== pageToken) throw new Error("Stale session.");
    await pc.setLocalDescription(offer);

    const sdpResp = await fetch(OPENAI_CALLS_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + clientSecret, "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (token !== pageToken) {
      try { pc.close(); } catch {}
      throw new Error("Stale session.");
    }
    if (!sdpResp.ok) {
      const t = await sdpResp.text().catch(() => "");
      try { pc.close(); } catch {}
      void endKymaSession(kymaSessionId, kymaKey);
      throw new Error(`SDP exchange ${sdpResp.status}: ${t.slice(0, 160)}`);
    }
    const answerSdp = await sdpResp.text();
    if (token !== pageToken) {
      try { pc.close(); } catch {}
      throw new Error("Stale session.");
    }
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    return newSession;
  }

  function handleRealtimeEvent(raw, token) {
    if (token !== pageToken && session?.token !== token) return;
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }
    if (evt.type === "error") {
      setStatusText("Translation error");
      return;
    }
    const isDelta =
      evt.type === "session.output_transcript.delta" ||
      evt.type === "response.audio_transcript.delta" ||
      evt.type === "response.output_audio_transcript.delta" ||
      (evt.type === "response.text.delta" && typeof evt.delta === "string");
    if (isDelta && evt.delta) {
      currentTargetText += evt.delta;
      setTargetText(currentTargetText);
      setOverlayState("live");
      return;
    }
    const isDone =
      evt.type === "session.output_transcript.done" ||
      evt.type === "response.audio_transcript.done" ||
      evt.type === "response.output_audio_transcript.done" ||
      evt.type === "response.text.done";
    if (isDone) {
      if (evt.transcript) currentTargetText = evt.transcript;
      setTargetText(currentTargetText);
      pushHistoryTurn();
      return;
    }
  }

  function computeGain(voiceVolume) {
    return voiceVolume === 0 ? 0 : (voiceVolume / 100) * VOICE_GAIN_MAX;
  }

  function applyVolumes(originalVolume, voiceVolume) {
    // Original audio (the YT video element itself). Locate it on-demand so
    // the slider has effect even before the user clicks Start — without this
    // the popup felt frozen pre-session. videoEl global is set during an
    // active session; otherwise findVideo() pulls the live YT element.
    const video = videoEl || (typeof findVideo === "function" ? findVideo() : null);
    if (video) {
      const vol = Math.max(0, Math.min(1, (originalVolume ?? 18) / 100));
      desiredOriginalVol = vol;
      lastOriginalWriteAt = Date.now();
      video.volume = vol;
      video.muted = vol === 0;
    }
    // Voice (the translated dub). Web Audio GainNode with a brief ramp so
    // rapid slider drags don't crackle. setValueAtTime + linearRampToValueAtTime
    // is the documented way to schedule gain changes without pop artifacts.
    // Only meaningful when a session is active and emitting dub audio.
    if (session?.outputGain && session?.audioCtx) {
      const target = computeGain(voiceVolume ?? 100);
      const ctx = session.audioCtx;
      const gain = session.outputGain.gain;
      const now = ctx.currentTime;
      try {
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(gain.value, now);
        gain.linearRampToValueAtTime(target, now + 0.04);
      } catch {
        // Older AudioContext implementations may reject scheduling — fall
        // back to direct assignment which always works (just less smooth).
        gain.value = target;
      }
    } else if (session?.remoteAudio) {
      session.remoteAudio.volume = Math.min((voiceVolume ?? 100) / 100, 1.0);
      session.remoteAudio.muted = voiceVolume === 0;
    }
  }

  // SF3 — Hook video element's volumechange and snap back to our desired
  // value when YouTube's player re-applies its own (ad insertion, video
  // refresh, etc.). Bound when a session starts, unbound on stop. We
  // ignore events fired within ~200ms of our own write to avoid a
  // self-triggered feedback loop.
  function bindVolumeDriftGuard(video) {
    if (!video) return;
    unbindVolumeDriftGuard();
    onVolumeDrift = () => {
      if (desiredOriginalVol < 0 || !video) return;
      if (Date.now() - lastOriginalWriteAt < 200) return;
      if (Math.abs(video.volume - desiredOriginalVol) > 0.01) {
        lastOriginalWriteAt = Date.now();
        video.volume = desiredOriginalVol;
        video.muted = desiredOriginalVol === 0;
      }
    };
    video.addEventListener("volumechange", onVolumeDrift);
  }
  function unbindVolumeDriftGuard() {
    if (videoEl && onVolumeDrift) {
      try { videoEl.removeEventListener("volumechange", onVolumeDrift); } catch {}
    }
    onVolumeDrift = null;
    desiredOriginalVol = -1;
  }

  // SF8 Phase 1 — Listen to `ratechange` on the video element and toast a
  // warning when playback is not 1×. Caller must invoke AFTER buildOverlay
  // so showToast has a panel to render into.
  function bindRateChangeWarn(video) {
    if (!video) return;
    unbindRateChangeWarn();
    const warn = (rate) => {
      if (Date.now() - lastRateToastAt < 4000) return;
      lastRateToastAt = Date.now();
      const r = Math.round(rate * 100) / 100;
      showToast(
        `Echoly works best at 1× speed (current: ${r}×). Translation may drift behind the speaker.`,
        5000,
      );
    };
    if (Math.abs(video.playbackRate - 1.0) > 0.01) warn(video.playbackRate);
    onRateChange = () => {
      if (!video) return;
      if (Math.abs(video.playbackRate - 1.0) < 0.01) return;
      warn(video.playbackRate);
    };
    video.addEventListener("ratechange", onRateChange);
  }
  function unbindRateChangeWarn() {
    if (videoEl && onRateChange) {
      try { videoEl.removeEventListener("ratechange", onRateChange); } catch {}
    }
    onRateChange = null;
  }

  // ───── F4 — Voice / language handover (zero-gap) ──────────────────────────
  async function requestHandover(partial) {
    if (!session) return;
    const newSettings = { ...settings, ...partial };
    const same =
      newSettings.targetLanguage === session.targetLanguage &&
      (newSettings.realtimeVoice || "") === (session.realtimeVoice || "");
    if (same) return;

    // Mark current turn into history with marker chip showing the change
    const fromLang = LANG_NAME[session.targetLanguage] || session.targetLanguage;
    const toLang = LANG_NAME[newSettings.targetLanguage] || newSettings.targetLanguage;
    if (newSettings.targetLanguage !== session.targetLanguage) {
      pushHistoryTurn({ marker: `${fromLang} → ${toLang}` });
      setStatusText("Switching to " + toLang);
    } else {
      pushHistoryTurn({ marker: "Switching voice" });
      setStatusText("Switching voice");
    }
    setOverlayState("connecting");

    const newToken = ++pageToken;
    settings = newSettings;
    notifyBackground({ type: "UPDATE_SETTINGS", settings: newSettings });
    if (elements.langSelect) elements.langSelect.value = newSettings.targetLanguage;
    if (elements.voiceSelect) elements.voiceSelect.value = newSettings.realtimeVoice || "";

    let newSession;
    try {
      newSession = await buildRealtimeSession(newToken, session.stream, {
        kymaKey: settings.kymaKey,
        targetLanguage: newSettings.targetLanguage,
        realtimeVoice: newSettings.realtimeVoice,
      });
      if (newToken !== pageToken) {
        // Yet another change came in; abandon this build
        try { newSession.pc.close(); } catch {}
        return;
      }
    } catch (err) {
      if (newToken !== pageToken) return;
      setStatusText("Switch failed — keeping current session");
      setOverlayState("live");
      showToast(err.message, { cta: err.cta, ctaLabel: err.ctaLabel }, 9000);
      // Old session stays running — no swap performed
      return;
    }

    // Swap: mute old, install new, close old
    prevSession = session;
    session = newSession;
    setStatusText("Translating");
    setOverlayState("live");

    // Wait briefly for new audio track to arrive before muting old
    setTimeout(() => {
      if (prevSession) {
        try {
          if (prevSession.remoteAudio) {
            prevSession.remoteAudio.pause();
            prevSession.remoteAudio.srcObject = null;
            prevSession.remoteAudio.remove();
          }
          if (prevSession.outputGain) prevSession.outputGain.disconnect();
          if (prevSession.audioCtx) prevSession.audioCtx.close();
          prevSession.pc?.close();
        } catch {}
        void endKymaSession(prevSession.kymaSessionId, prevSession.kymaKey);
        prevSession = null;
      }
    }, 400);

    // Heartbeat for new session, drop old heartbeat
    startHeartbeat(newSession.kymaSessionId, newSession.kymaKey);
    applyVolumes(settings.originalVolume, settings.voiceVolume);
  }

  // ───── Standard tier (chunked: whisper → gpt-4o-mini → minimax) ───────────
  // Pipeline lives entirely client-side. Each chunk independently calls three
  // Kyma endpoints; chunks process in parallel so chunk N+1 starts recording
  // while chunk N is still in TTS. Playback queue uses Web Audio scheduling
  // so dub plays back-to-back even when pipeline latency varies per chunk.
  async function startStandardSession() {
    const video = findVideo();
    if (!video) return { ok: false, error: "No YouTube video on this page." };
    videoEl = video;
    bindVolumeDriftGuard(video);

    let stream;
    try {
      buildOverlay();
      bindRateChangeWarn(video);
      setStatusText("Acquiring audio");
      stream = await captureWithRetry(video);
    } catch (err) {
      removeOverlay();
      return { ok: false, error: err.message };
    }

    const recorderMime = pickRecorderMime();
    if (!recorderMime) {
      stream.getTracks().forEach((t) => t.stop());
      removeOverlay();
      return { ok: false, error: "Browser cannot record audio for chunked pipeline." };
    }

    let audioCtx;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      removeOverlay();
      return { ok: false, error: "AudioContext unavailable: " + err.message };
    }
    const outputGain = audioCtx.createGain();
    outputGain.gain.value = computeGain(settings.voiceVolume ?? 100);
    outputGain.connect(audioCtx.destination);

    const token = ++pageToken;
    const newSession = {
      token,
      type: "standard",
      stream,
      audioCtx,
      outputGain,
      remoteAudio: null,
      pc: null,
      dc: null,
      kymaSessionId: null,
      kymaKey: settings.kymaKey,
      recorderMime,
      activeRecorder: null,
      nextPlayAt: 0,
      stopFlag: false,
      // One AbortController for the whole session — every fetch in
      // processStandardChunk hangs off this signal so a Stop click cancels
      // in-flight whisper/translate/TTS calls instead of silently burning
      // ~5-10s of Kyma credits per orphaned pipeline.
      abortController: new AbortController(),
    };
    session = newSession;

    setStatusText("Translating");
    setOverlayState("live");
    startSessionTimer();
    applyVolumes(settings.originalVolume, settings.voiceVolume);
    applySourceVisibility();
    if (settings.showSource) startCaptionPoll();

    onYTPause = () => {
      setStatusText("Paused");
      setOverlayState("paused");
      emitState({ paused: true, status: "Paused" });
    };
    onYTPlay = () => {
      setStatusText("Translating");
      setOverlayState("live");
      emitState({ paused: false, status: "Translating" });
    };
    const onYTEnded = () => {
      stopSession("video-ended");
      emitEnded("Video ended.");
    };
    video.addEventListener("pause", onYTPause);
    video.addEventListener("play", onYTPlay);
    video.addEventListener("ended", onYTEnded);
    newSession._onEnded = onYTEnded;

    runChunkLoop(newSession);
    emitState({ running: true, paused: false, status: "Translating" });
    return { ok: true };
  }

  function pickRecorderMime() {
    if (typeof MediaRecorder === "undefined") return "";
    for (const m of STANDARD_RECORDER_MIMES) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
    }
    return "";
  }

  // Kyma's transcription gateway whitelists mp3/wav/m4a only — Chrome
  // MediaRecorder can only emit webm/opus or mp4. So we decode the recorder
  // blob locally and re-encode as 16-bit PCM WAV before uploading. The
  // overhead is ~30ms per 5s chunk on M-series Macs and bandwidth roughly
  // doubles (opus 24kbps → wav 16-bit mono 16kHz ≈ 256kbps), which is fine
  // for a 5s window.
  async function webmBlobToWav(blob, sharedCtx) {
    const arrayBuf = await blob.arrayBuffer();
    let ownCtx;
    let ctx = sharedCtx;
    if (!ctx) {
      ownCtx = new (window.AudioContext || window.webkitAudioContext)();
      ctx = ownCtx;
    }
    let audioBuf;
    try {
      audioBuf = await ctx.decodeAudioData(arrayBuf);
    } finally {
      if (ownCtx) ownCtx.close().catch(() => {});
    }
    return audioBufferToWavBlob(audioBuf);
  }

  function audioBufferToWavBlob(audioBuf) {
    // Whisper handles mono fine; downmix to mono and resample to 16 kHz to
    // match Whisper's internal rate — saves bandwidth without quality loss.
    const targetRate = 16000;
    const monoSamples = downmixAndResample(audioBuf, targetRate);
    const dataSize = monoSamples.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    let p = 0;
    function wstr(s) { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); }
    function w32(n) { view.setUint32(p, n, true); p += 4; }
    function w16(n) { view.setUint16(p, n, true); p += 2; }
    wstr("RIFF"); w32(36 + dataSize); wstr("WAVE");
    wstr("fmt "); w32(16); w16(1); w16(1); w32(targetRate);
    w32(targetRate * 2); w16(2); w16(16);
    wstr("data"); w32(dataSize);
    for (let i = 0; i < monoSamples.length; i++) {
      const s = Math.max(-1, Math.min(1, monoSamples[i]));
      view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      p += 2;
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  function downmixAndResample(audioBuf, targetRate) {
    const srcRate = audioBuf.sampleRate;
    const channels = audioBuf.numberOfChannels;
    const srcLen = audioBuf.length;
    // Mono mix first (avg across channels).
    const mono = new Float32Array(srcLen);
    for (let ch = 0; ch < channels; ch++) {
      const data = audioBuf.getChannelData(ch);
      for (let i = 0; i < srcLen; i++) mono[i] += data[i];
    }
    if (channels > 1) for (let i = 0; i < srcLen; i++) mono[i] /= channels;
    if (srcRate === targetRate) return mono;
    // Linear resample — adequate for speech intelligibility at 16 kHz target.
    const ratio = srcRate / targetRate;
    const outLen = Math.floor(srcLen / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = i * ratio;
      const i0 = Math.floor(src);
      const i1 = Math.min(i0 + 1, srcLen - 1);
      const f = src - i0;
      out[i] = mono[i0] * (1 - f) + mono[i1] * f;
    }
    return out;
  }

  // Recorder cycle: stop+start each window so each blob is a self-contained
  // file that whisper can decode without container fragments. The brief
  // (<10ms) gap between cycles is acceptable; it lands in inter-sentence
  // pauses more often than not.
  function runChunkLoop(s) {
    const cycle = () => {
      if (s !== session || s.stopFlag) return;
      // Skip recording while video paused — captureStream emits silence so
      // we'd burn a whisper call to learn nothing.
      if (videoEl?.paused) {
        setTimeout(cycle, 400);
        return;
      }
      let recorder;
      try {
        recorder = new MediaRecorder(s.stream, { mimeType: s.recorderMime });
      } catch {
        try { recorder = new MediaRecorder(s.stream); } catch {
          setTimeout(cycle, 1000);
          return;
        }
      }
      s.activeRecorder = recorder;
      const parts = [];
      recorder.addEventListener("dataavailable", (e) => {
        if (e.data && e.data.size > 0) parts.push(e.data);
      });
      recorder.addEventListener("stop", () => {
        if (s !== session || s.stopFlag) return;
        if (parts.length) {
          const blob = new Blob(parts, { type: s.recorderMime });
          processStandardChunk(s, blob).catch(() => {});
        }
        cycle();
      });
      try { recorder.start(); } catch {
        setTimeout(cycle, 1000);
        return;
      }
      setTimeout(() => {
        try { if (recorder.state !== "inactive") recorder.stop(); } catch {}
      }, STANDARD_CHUNK_MS);
    };
    cycle();
  }

  async function processStandardChunk(s, blob) {
    if (s !== session || s.token !== pageToken) return;
    if (blob.size < STANDARD_MIN_CHUNK_BYTES) return;
    const t = s.token;
    const lang = settings.targetLanguage || "vi";
    const langName = LANG_NAME[lang] || lang;
    const voiceId = settings.standardVoice || STANDARD_DEFAULT_VOICE;
    const kymaKey = s.kymaKey;

    // Re-encode webm/opus blob → 16 kHz mono WAV. Kyma's audio gateway
    // whitelists mp3/wav/m4a only; WAV is the simplest of the three to emit
    // from MediaRecorder output via decode + resample.
    let wavBlob;
    try {
      wavBlob = await webmBlobToWav(blob, s.audioCtx);
    } catch {
      return;
    }
    if (s !== session || s.token !== t) return;

    // 1+2 COMBINED via Vertex Gemini Audio. /v1/audio/understand takes an
    // audio file + a question and returns text — we prompt it to translate
    // straight into the target language so we collapse the legacy 2-step
    // pipeline (Whisper transcribe → Gemini chat translate) into one call.
    // Wins: ~50% latency, ~50% cost, no more AI-Studio free-tier flakiness
    // (Vertex SA route has project-level quota, see kyma-api/src/providers/
    // google-vertex.ts). Wave 1 + Wave 2 of Vertex migration, 2026-05-16.
    const durationSec = STANDARD_CHUNK_MS / 1000;
    const understandFd = new FormData();
    understandFd.append("file", wavBlob, "chunk.wav");
    understandFd.append("model", "gemini-3-flash-audio");
    understandFd.append("duration_sec", String(durationSec));
    understandFd.append(
      "question",
      `Translate the spoken English in this audio into ${langName}. ` +
      `Output ONLY the translated sentence(s) for live dubbing — no quotes, ` +
      `no labels, no commentary, no transcription of the original. ` +
      // SF7 — concise output reduces TTS-vs-source duration drift in
      // verbose target languages (VI/JA/KO). Prefer natural shorter
      // phrasing over literal word-for-word; the goal is a dub that
      // matches the speaker's pacing, not a textbook translation.
      `Be CONCISE — match the original speech duration. Prefer shorter ` +
      `natural phrasing; drop filler words. Preserve ` +
      `names, brand names, and technical terms verbatim. If the audio is ` +
      `silent or non-speech, output an empty string.`,
    );
    let auResp;
    try {
      auResp = await fetch(`${apiBase}/audio/understand`, {
        method: "POST",
        headers: { Authorization: "Bearer " + kymaKey },
        body: understandFd,
        signal: s.abortController.signal,
      });
    } catch {
      return;  // network blip OR aborted via Stop; next chunk will recover
    }
    if (s !== session || s.token !== t) return;
    if (!auResp.ok) {
      const txt = await auResp.text().catch(() => "");
      const parsed = parseKymaError(auResp.status, txt);
      showStandardError(parsed);
      return;
    }
    const au = await auResp.json().catch(() => ({}));
    const targetText = String(au?.answer || "").trim();
    if (!targetText || targetText.length < 2) return;
    // Source text is no longer surfaced separately by the audio-understand
    // path. Keep the source caption pane (settings.showSource) backed by
    // YouTube's own native captions via the existing startCaptionPoll loop —
    // that's the original behavior before Whisper transcription was wired
    // into the side pane.
    currentTargetText = targetText;
    setTargetText(targetText);
    setOverlayState("live");

    // 3. TTS via Minimax. mp3 returned directly as audio bytes.
    //
    // SF7 — adaptive speed to prevent cumulative drift. TTS in verbose
    // target languages (VI ~1.6x English, JA ~1.4x, KO ~1.5x) takes
    // longer to read than the 5-second source chunk. Without speed
    // adjustment, the playback queue grows ~3s per chunk → 30-60s
    // drift per hour. We measure how far behind we already are
    // (queueDepth) and dial the TTS speed up adaptively, capped at
    // 1.30 to keep prosody natural. Above ~10s queue depth we skip
    // the chunk entirely — better to lose a sentence than fall an
    // entire minute behind.
    const queueDepth = Math.max(0, s.nextPlayAt - s.audioCtx.currentTime);
    if (queueDepth > 10) {
      // Hard skip — accept content loss to claw back live-ness.
      return;
    }
    let ttsSpeed = 1.0;
    if (queueDepth > 6) ttsSpeed = 1.30;
    else if (queueDepth > 4) ttsSpeed = 1.20;
    else if (queueDepth > 2) ttsSpeed = 1.10;
    else if (queueDepth > 1) ttsSpeed = 1.05;

    let ttsResp;
    try {
      ttsResp = await fetch(`${apiBase}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + kymaKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "minimax-speech-turbo",
          input: targetText,
          voice_id: voiceId,
          response_format: "mp3",
          speed: ttsSpeed,
        }),
        signal: s.abortController.signal,
      });
    } catch {
      return;
    }
    if (s !== session || s.token !== t) return;
    if (!ttsResp.ok) {
      const txt = await ttsResp.text().catch(() => "");
      const parsed = parseKymaError(ttsResp.status, txt);
      showStandardError(parsed);
      return;
    }
    const arrayBuf = await ttsResp.arrayBuffer();
    if (s !== session || s.token !== t) return;

    let audioBuf;
    try {
      audioBuf = await s.audioCtx.decodeAudioData(arrayBuf);
    } catch {
      return;
    }
    if (s !== session || s.token !== t) return;

    // Schedule against the queue tail so chunks play sequentially without
    // overlap, even when one chunk's pipeline takes longer than another. If
    // the queue tail has fallen behind realtime (silence/error gaps left it
    // stranded in the past), reset it — otherwise the next valid chunk would
    // play immediately AND every chunk after would inherit the stale offset.
    if (s.nextPlayAt < s.audioCtx.currentTime) s.nextPlayAt = 0;
    const startAt = Math.max(s.audioCtx.currentTime + 0.05, s.nextPlayAt);
    const src = s.audioCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(s.outputGain);
    try { src.start(startAt); } catch {}
    s.nextPlayAt = startAt + audioBuf.duration;

    pushHistoryTurn();
  }

  function showStandardError(parsed) {
    setStatusText(parsed.user || "Pipeline error");
    showToast(parsed.user, { cta: parsed.cta, ctaLabel: parsed.ctaLabel }, 6000);
  }

  // ───── Subtitle-first tier (CC fetch → batch translate → batch TTS) ───────
  // Pre-fetches the platform caption track (YouTube only in v0.3), batches the
  // whole transcript through Gemini in one shot, then renders MiniMax TTS in
  // rolling waves and schedules playback at exact caption timestamps. Zero
  // chase delay (cf. Standard chunked pipeline ~5s lag) when CC is available.
  //
  // Fallback chain (see startSession router): subtitle-first → standard chunk.
  const SUBFIRST_BATCH_SIZE = 10;        // sentences per translate request
  const SUBFIRST_LOOKAHEAD_MS = 30_000;  // render this far ahead of playhead
  const SUBFIRST_RENDER_CONCURRENCY = 5; // parallel TTS workers
  const SUBFIRST_GAP_MS = 1500;          // sentence boundary if inter-cue gap > this
  const SUBFIRST_MAX_WORDS = 15;         // OR cumulative words > this

  function getYouTubeVideoId() {
    try {
      const u = new URL(location.href);
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/embed\/([^/?]+)/);
      if (m) return m[1];
      return null;
    } catch {
      return null;
    }
  }

  // CC button selectors — keep multiple as fallbacks for YT UI rewrites.
  const YT_CC_BUTTON_SELECTORS = [
    "button.ytp-subtitles-button",
    ".ytp-chrome-controls .ytp-subtitles-button",
    'button[aria-label*="captions" i]',
    'button[aria-label*="subtitle" i]',
  ];

  function findYTCCButton() {
    for (const sel of YT_CC_BUTTON_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  // Toggling YT's own CC button forces YouTube to fire its internal
  // /api/timedtext request with a full-auth signed URL. Background's
  // webRequest listener captures that URL by videoId. We later restore the
  // button to its original state so the user's CC visibility preference is
  // preserved.
  function triggerYTCCLoad() {
    const btn = findYTCCButton();
    if (!btn) return { triggered: false, wasOff: false };
    const wasOff = btn.getAttribute("aria-pressed") !== "true";
    if (wasOff) {
      try { btn.click(); } catch { return { triggered: false, wasOff }; }
    }
    return { triggered: true, wasOff };
  }

  function restoreYTCCButton(wasOff) {
    if (!wasOff) return;
    const btn = findYTCCButton();
    if (btn && btn.getAttribute("aria-pressed") === "true") {
      try { btn.click(); } catch {}
    }
  }

  // Layer 1: ask background for the most recently observed timedtext URL
  // for this video. If none yet, trigger YT's CC button and poll. Returns
  // { url, lang, kind, isAsr, tlang } or null on timeout.
  async function fetchCCViaIntercept(videoId, signal, timeoutMs = 1800) {
    const askBg = () => new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "GET_YT_CC_URL", videoId },
          (reply) => resolve(reply && reply.ok ? reply : null),
        );
      } catch { resolve(null); }
    });

    // First peek — user may already have CC on (warm cache, no UI flicker).
    let entry = await askBg();
    if (entry?.url) return entry;
    if (signal?.aborted) return null;

    // Cold cache: nudge YT to load CC, then poll.
    const { triggered, wasOff } = triggerYTCCLoad();
    if (!triggered) return null;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
      if (signal?.aborted) { restoreYTCCButton(wasOff); return null; }
      entry = await askBg();
      if (entry?.url) {
        restoreYTCCButton(wasOff);
        return entry;
      }
    }
    restoreYTCCButton(wasOff);
    return null;
  }

  // YouTube tightened the public timedtext API end-2024 — plain URLs like
  // `?lang=en&v=ID&fmt=json3` now return HTTP 200 with empty body for most
  // videos. The signed URLs (with `signature`, `expire`, `sparams` params)
  // live inside `ytInitialPlayerResponse.captions.playerCaptionsTracklist
  // Renderer.captionTracks[].baseUrl` on the watch page itself. We parse
  // that from the inline <script> in the DOM and append `&fmt=json3` to
  // get JSON events back. Verified 2026-05-16 against Paul Graham's YC
  // talk where the plain URL returned 0 bytes but the signed URL works.
  function readPlayerResponseFromDom() {
    // ytInitialPlayerResponse is set by YouTube inside a top-level
    // `<script>` tag near the end of <head>. Content scripts run in an
    // isolated world so we can't read window.ytInitialPlayerResponse,
    // but we CAN read the script text via querySelector.
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      const t = s.textContent;
      if (!t || !t.includes("ytInitialPlayerResponse")) continue;
      const m = t.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})\s*;\s*(?:var|<\/script>|window\.|$)/);
      if (!m) continue;
      try {
        return JSON.parse(m[1]);
      } catch {
        // Some pages serialize with trailing chars before ;. Try a more
        // lenient parser: balanced-brace scan from match start.
        const raw = m[1];
        let depth = 0;
        let end = -1;
        for (let i = 0; i < raw.length; i++) {
          const c = raw[i];
          if (c === "{") depth++;
          else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        if (end > 0) {
          try { return JSON.parse(raw.slice(0, end)); } catch {}
        }
      }
    }
    return null;
  }

  function pickCaptionTrack(tracks, targetLang) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const targetCode = (targetLang || "").toLowerCase().split("-")[0];
    const score = (t) => {
      const code = (t.languageCode || "").toLowerCase().split("-")[0];
      let s = 0;
      // Native target-lang track is gold (human-translated subs)
      if (code === targetCode) s += 100;
      // English source most often available + best translation source
      if (code === "en") s += 50;
      // Manual > ASR (manual has no `kind`, ASR has kind: "asr")
      if (!t.kind || t.kind !== "asr") s += 10;
      return s;
    };
    return [...tracks].sort((a, b) => score(b) - score(a))[0];
  }

  async function fetchYouTubeCaptions(videoId, targetLang, signal) {
    // Layer 1: webRequest-intercepted URL (most reliable). Background catches
    // the timedtext URL whenever YouTube itself fetches it; we trigger that
    // fetch by toggling YT's own CC button if it isn't already on.
    try {
      const entry = await fetchCCViaIntercept(videoId, signal);
      if (entry?.url) {
        const url = entry.url + (entry.url.includes("fmt=") ? "" : "&fmt=json3");
        const res = await fetch(url, { credentials: "include", signal });
        if (res.ok) {
          const json = await res.json().catch(() => null);
          const captions = parseJson3Events(json?.events || []);
          if (captions.length > 0) {
            return { captions, sourceUrl: url, lang: entry.lang, kind: entry.kind, source: "intercept" };
          }
        }
      }
    } catch (e) {
      if (signal?.aborted) return null;
      // Fall through to Layer 2.
    }

    // Layer 2: pre-signed baseUrl from page's ytInitialPlayerResponse.
    const pr = readPlayerResponseFromDom();
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const picked = pickCaptionTrack(tracks, targetLang);
    if (picked?.baseUrl) {
      const url = picked.baseUrl + (picked.baseUrl.includes("fmt=") ? "" : "&fmt=json3");
      try {
        const res = await fetch(url, { credentials: "include", signal });
        if (res.ok) {
          const json = await res.json().catch(() => null);
          const captions = parseJson3Events(json?.events || []);
          if (captions.length > 0) {
            return { captions, sourceUrl: url, lang: picked.languageCode, kind: picked.kind || null };
          }
        }
      } catch {
        if (signal?.aborted) return null;
      }
    }
    // Layer 3: plain URL pattern. Most videos return empty today but some
    // legacy/embedded contexts still work, and it costs ~200ms.
    const base = "https://www.youtube.com/api/timedtext";
    const v = encodeURIComponent(videoId);
    const lang = encodeURIComponent(targetLang || "vi");
    const fallbackUrls = [
      `${base}?lang=en&v=${v}&fmt=json3`,
      `${base}?lang=${lang}&v=${v}&fmt=json3`,
      `${base}?lang=en&v=${v}&fmt=json3&kind=asr`,
    ];
    for (const url of fallbackUrls) {
      try {
        const res = await fetch(url, { credentials: "include", signal });
        if (!res.ok) continue;
        const json = await res.json().catch(() => null);
        const captions = parseJson3Events(json?.events || []);
        if (captions.length > 0) return { captions, sourceUrl: url };
      } catch {
        if (signal?.aborted) return null;
      }
    }
    return null;
  }

  function parseJson3Events(events) {
    const out = [];
    for (const e of events) {
      if (!e?.segs || typeof e.tStartMs !== "number") continue;
      const text = e.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
      if (!text || text === "\n") continue;
      const start = e.tStartMs / 1000;
      const dur = (e.dDurationMs || 0) / 1000;
      out.push({ start, end: start + dur, text });
    }
    return out;
  }

  // YouTube ASR emits 1-3 words per cue. Regrouping into sentence-shaped
  // chunks gives the translator usable context and keeps TTS calls under
  // ~15 words (cheaper, faster, more natural prosody).
  //
  // ASR sliding window often repeats trailing words across consecutive cues —
  // e.g. cue A ends "the world how" and cue B starts "world how are you". A
  // naive concat ("the world how world how are you") makes TTS read the
  // duplicated chunk twice. mergeWithDedupe collapses the overlap by finding
  // the longest matching suffix-of-A / prefix-of-B and dropping the duplicate
  // tokens from B before joining.
  function mergeWithDedupe(aText, bText) {
    const aTokens = aText.split(/\s+/).filter(Boolean);
    const bTokens = bText.split(/\s+/).filter(Boolean);
    const maxOverlap = Math.min(aTokens.length, bTokens.length, 8);  // cap at 8 to avoid pathological
    let overlap = 0;
    for (let n = maxOverlap; n > 0; n--) {
      const suffix = aTokens.slice(-n).map((s) => s.toLowerCase()).join(" ");
      const prefix = bTokens.slice(0, n).map((s) => s.toLowerCase()).join(" ");
      if (suffix === prefix) { overlap = n; break; }
    }
    const tail = bTokens.slice(overlap).join(" ");
    return tail ? `${aText} ${tail}`.trim() : aText;
  }

  function regroupToSentences(captions) {
    const out = [];
    let acc = null;
    for (const c of captions) {
      if (!acc) { acc = { ...c }; continue; }
      const gapMs = (c.start - acc.end) * 1000;
      const endsSentence = /[.!?…。！？]$/.test(acc.text);
      const tooLong = acc.text.split(/\s+/).length >= SUBFIRST_MAX_WORDS;
      if (endsSentence || gapMs > SUBFIRST_GAP_MS || tooLong) {
        out.push(acc);
        acc = { ...c };
      } else {
        acc.text = mergeWithDedupe(acc.text, c.text);
        acc.end = c.end;
      }
    }
    if (acc) out.push(acc);
    return out;
  }

  // Strict JSON-array request keeps alignment trivial — output[i] maps to
  // input[i]. If Gemini misformats and lengths differ, we fall back to the
  // English source for the unmapped slots so the user still hears something
  // at that timestamp instead of silence.
  async function batchTranslateSubtitles(sentences, langName, kymaKey, signal) {
    const items = sentences.map((s) => s.text);
    const prompt =
      `Translate these ${items.length} subtitle lines to ${langName}. ` +
      `Return ONLY a JSON object {"lines": [...]} with exactly ${items.length} ` +
      `strings in the same order. Preserve names, brand names, and technical ` +
      `terms verbatim. No commentary.\n\n` +
      // SF7 — keep each line concise so the TTS-rendered duration stays
      // close to the original subtitle cue's video-time duration. Verbose
      // languages (VI/JA/KO) otherwise overshoot the cue window and start
      // overlapping with the next sentence's playback slot.
      `Each translated line should be CONCISE — prefer shorter natural ` +
      `phrasing over literal word-for-word, so the dub fits the same time ` +
      `slot as the original cue.\n\n` +
      `Input: ${JSON.stringify(items)}`;
    const res = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer " + kymaKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        messages: [
          { role: "system", content: "You translate subtitles for live dubbing. Output strict JSON only." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
      signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw parseKymaError(res.status, txt);
    }
    const json = await res.json();
    const raw = json?.choices?.[0]?.message?.content || "";
    let translations = null;
    try {
      const parsed = JSON.parse(raw);
      translations = Array.isArray(parsed)
        ? parsed
        : (parsed.lines || parsed.translations || parsed.items || Object.values(parsed)[0]);
    } catch {
      translations = raw.split("\n")
        .map((s) => s.replace(/^\s*[-*\d.]+\s*/, "").trim())
        .filter(Boolean);
    }
    if (!Array.isArray(translations)) translations = [];
    return items.map((src, i) => {
      const t = translations[i];
      return (typeof t === "string" && t.trim()) ? t.trim() : src;
    });
  }

  async function renderTTSForSentence(text, voiceId, kymaKey, audioCtx, signal) {
    const res = await fetch(`${apiBase}/audio/speech`, {
      method: "POST",
      headers: { Authorization: "Bearer " + kymaKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "minimax-speech-turbo",
        input: text,
        voice_id: voiceId,
        response_format: "mp3",
      }),
      signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw parseKymaError(res.status, txt);
    }
    const arrayBuf = await res.arrayBuffer();
    return audioCtx.decodeAudioData(arrayBuf);
  }

  async function startSubtitleFirstSession() {
    const video = findVideo();
    if (!video) return { ok: false, error: "No video on this page." };
    videoEl = video;
    bindVolumeDriftGuard(video);

    const videoId = getYouTubeVideoId();
    if (!videoId) return { ok: false, error: "Could not detect YouTube video id." };

    buildOverlay();
    bindRateChangeWarn(video);
    setStatusText("Loading captions");
    setOverlayState("connecting");

    let audioCtx, outputGain;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      outputGain = audioCtx.createGain();
      outputGain.gain.value = computeGain(settings.voiceVolume ?? 100);
      outputGain.connect(audioCtx.destination);
    } catch (err) {
      removeOverlay();
      return { ok: false, error: "AudioContext unavailable: " + err.message };
    }

    const token = ++pageToken;
    const abortController = new AbortController();
    const newSession = {
      token,
      type: "subtitle-first",
      audioCtx,
      outputGain,
      stream: null,
      remoteAudio: null,
      pc: null,
      dc: null,
      kymaSessionId: null,
      kymaKey: settings.kymaKey,
      abortController,
      // subtitle-first specific
      sentences: [],          // [{start, end, text, _buffer?}] post-regrouping
      translations: [],       // string[] aligned with sentences
      pendingSources: [],     // scheduled AudioBufferSource[] for cleanup
      audioOffset: 0,         // audioCtx.currentTime when video.currentTime = 0
      renderCursor: 0,        // next sentence index to render in background loop
      stopFlag: false,
      _onSeeked: null,
    };
    session = newSession;

    // Remember whether the video was playing so we can restore play state if
    // anything below this point fails. Otherwise the user is left with a
    // paused video and a Ready popup, with no obvious way to recover except
    // clicking the YT play button.
    const wasPlaying = !video.paused;
    newSession.wasPlaying = wasPlaying;
    const restorePlay = () => {
      if (wasPlaying && video.paused) {
        try { video.play().catch(() => {}); } catch {}
      }
    };

    // Pause video while we fetch+translate+render the first 30s of dub.
    try { video.pause(); } catch {}

    let captionResult;
    try {
      captionResult = await fetchYouTubeCaptions(videoId, settings.targetLanguage, abortController.signal);
    } catch {
      captionResult = null;
    }
    if (token !== pageToken || newSession.stopFlag) {
      try { audioCtx.close(); } catch {}
      restorePlay();
      return { ok: false, error: "Cancelled." };
    }
    if (!captionResult || captionResult.captions.length === 0) {
      // No CC available — drop subtitle-first session, fall back to live chunked.
      // Important: tear down the audio context BEFORE handing off, but DO NOT
      // remove the overlay first (removeOverlay sets root=null, which would
      // make the fallback toast a no-op in showToast). Instead let
      // startStandardSession rebuild the overlay, then surface the toast.
      try { audioCtx.close(); } catch {}
      session = null;
      pageToken += 1;  // invalidate the subtitle-first token before standard starts
      removeOverlay();
      const result = await startStandardSession();
      if (result?.ok) {
        // startStandardSession has rebuilt the overlay — toast lands on it.
        // startStandardSession's captureWithRetry calls video.play() internally
        // so we don't need restorePlay() here.
        showToast("No captions for this video — using live mode (~5s lag)", 5000);
      } else {
        // Both subtitle-first and standard failed — restore play so user can
        // at least keep watching the original.
        restorePlay();
      }
      return result;
    }

    const sentences = regroupToSentences(captionResult.captions);
    newSession.sentences = sentences;
    newSession.translations = new Array(sentences.length);
    setStatusText(`Translating ${sentences.length} lines`);

    // First wave covers 2 sentences starting from the current playhead.
    // Crucial that wave 1 starts at the playhead, not index 0 — otherwise
    // when the user clicks Start mid-video, wave 1 renders sentences that
    // are already in the past, scheduleWindow's `at < now - 0.5` filter
    // skips them all, and the user hears nothing until runRollingRenderer
    // catches up ~10-15s later. (Reported by Son 2026-05-19 testing v0.5.3
    // on Google I/O '26 keynote.)
    //
    // Wave 1 cap of 2 (was 5 pre-SF6): keeps the cumulative await chain
    // under Chrome's ~5s transient-user-activation window so `video.play()`
    // below doesn't get blocked.
    const currentTime = video.currentTime;
    const lookaheadSec = SUBFIRST_LOOKAHEAD_MS / 1000;
    let firstWaveStart = sentences.findIndex((s) => s.start >= currentTime);
    if (firstWaveStart === -1) firstWaveStart = sentences.length;
    let lookaheadEnd = sentences.findIndex((s) => s.start > currentTime + lookaheadSec);
    if (lookaheadEnd === -1) lookaheadEnd = sentences.length;
    let firstWaveEnd = Math.min(lookaheadEnd, firstWaveStart + 2);
    // Ensure we render at least 1 forward sentence if any exist (e.g. when
    // lookaheadEnd lands exactly at firstWaveStart due to gap in cues).
    if (firstWaveEnd <= firstWaveStart && firstWaveStart < sentences.length) {
      firstWaveEnd = firstWaveStart + 1;
    }

    try {
      await translateBatch(newSession, firstWaveStart, firstWaveEnd);
    } catch (err) {
      if (token !== pageToken || newSession.stopFlag) {
        try { audioCtx.close(); } catch {}
        restorePlay();
        return { ok: false, error: "Cancelled." };
      }
      session = null;
      try { audioCtx.close(); } catch {}
      removeOverlay();
      restorePlay();
      const msg = err?.user || String(err?.message || err);
      return { ok: false, error: msg };
    }
    if (token !== pageToken || newSession.stopFlag) {
      try { audioCtx.close(); } catch {}
      restorePlay();
      return { ok: false, error: "Cancelled." };
    }

    setStatusText("Preparing voices");
    await renderWaveTTS(newSession, firstWaveStart, firstWaveEnd);
    if (token !== pageToken || newSession.stopFlag) {
      try { audioCtx.close(); } catch {}
      restorePlay();
      return { ok: false, error: "Cancelled." };
    }

    newSession.audioOffset = audioCtx.currentTime - video.currentTime;
    scheduleWindow(newSession, firstWaveStart, firstWaveEnd);
    newSession.renderCursor = firstWaveEnd;

    setStatusText("Translating");
    setOverlayState("live");
    applyVolumes(settings.originalVolume, settings.voiceVolume);
    applySourceVisibility();
    startSessionTimer();

    onYTPause = () => {
      setStatusText("Paused");
      setOverlayState("paused");
      emitState({ paused: true, status: "Paused" });
    };
    onYTPlay = () => {
      newSession.audioOffset = audioCtx.currentTime - video.currentTime;
      setStatusText("Translating");
      setOverlayState("live");
      emitState({ paused: false, status: "Translating" });
    };
    const onYTSeeked = () => {
      cancelPendingSources(newSession);
      newSession.audioOffset = audioCtx.currentTime - video.currentTime;
      scheduleAroundPlayhead(newSession);
    };
    // Auto-stop when the video reaches its natural end. Without this the
    // rolling renderer keeps polling + the overlay sits "Translating" forever
    // while the user has already moved on. Realtime tier (different session
    // type) gets the same handler attached in buildRealtimeSession.
    const onYTEnded = () => {
      stopSession("video-ended");
      emitEnded("Video ended.");
    };
    video.addEventListener("pause", onYTPause);
    video.addEventListener("play", onYTPlay);
    video.addEventListener("seeked", onYTSeeked);
    video.addEventListener("ended", onYTEnded);
    newSession._onSeeked = onYTSeeked;
    newSession._onEnded = onYTEnded;

    try { await video.play(); } catch {}
    runRollingRenderer(newSession);
    emitState({ running: true, paused: false, status: "Translating" });
    return { ok: true };
  }

  async function translateBatch(s, startIdx, endIdx) {
    const langName = LANG_NAME[settings.targetLanguage] || "Vietnamese";
    for (let i = startIdx; i < endIdx; i += SUBFIRST_BATCH_SIZE) {
      if (s !== session || s.stopFlag) return;
      const sliceEnd = Math.min(i + SUBFIRST_BATCH_SIZE, endIdx);
      const slice = s.sentences.slice(i, sliceEnd);
      const translations = await batchTranslateSubtitles(slice, langName, s.kymaKey, s.abortController.signal);
      if (s !== session || s.stopFlag) return;
      for (let j = 0; j < translations.length; j++) s.translations[i + j] = translations[j];
    }
  }

  async function renderWaveTTS(s, startIdx, endIdx) {
    const voiceId = settings.standardVoice || STANDARD_DEFAULT_VOICE;
    const queue = [];
    for (let i = startIdx; i < endIdx; i++) {
      if (s.sentences[i]?._buffer) continue;
      if (!s.translations[i]) continue;
      queue.push(i);
    }
    let cursor = 0;
    const workers = Array.from({ length: SUBFIRST_RENDER_CONCURRENCY }, async () => {
      while (cursor < queue.length) {
        if (s !== session || s.stopFlag) return;
        const idx = queue[cursor++];
        try {
          const buf = await renderTTSForSentence(
            s.translations[idx], voiceId, s.kymaKey, s.audioCtx, s.abortController.signal,
          );
          if (s !== session || s.stopFlag) return;
          s.sentences[idx]._buffer = buf;
        } catch {
          // Individual TTS failure leaves that one sentence silent; rest of
          // the dub still plays. Don't abort the whole wave.
        }
      }
    });
    await Promise.all(workers);
  }

  function scheduleWindow(s, startIdx, endIdx) {
    if (s !== session || !s.audioCtx) return;
    const now = s.audioCtx.currentTime;
    for (let i = startIdx; i < endIdx; i++) {
      const sent = s.sentences[i];
      const buf = sent?._buffer;
      if (!buf) continue;
      const at = s.audioOffset + sent.start;
      // If we've already drifted past this cue's start by >0.5s, skip rather
      // than blast a delayed line that clashes with the next one.
      if (at < now - 0.5) continue;
      const src = s.audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(s.outputGain);
      try { src.start(Math.max(at, now + 0.02)); } catch { continue; }
      src._sentenceIdx = i;
      s.pendingSources.push(src);
    }
    updateLiveDisplay(s);
  }

  function scheduleAroundPlayhead(s) {
    if (!videoEl) return;
    const t = videoEl.currentTime;
    let start = s.sentences.findIndex((sent) => sent.end >= t);
    if (start === -1) return;
    const lookaheadSec = SUBFIRST_LOOKAHEAD_MS / 1000;
    let end = s.sentences.findIndex((sent) => sent.start > t + lookaheadSec);
    if (end === -1) end = s.sentences.length;
    // Schedule whatever is already buffered around the new playhead. We do
    // NOT advance renderCursor here — letting the rolling renderer pick up
    // the gap on its next tick covers both seek-forward (new region to
    // render) and seek-backward (already-buffered region replays).
    scheduleWindow(s, start, end);
    if (start < s.renderCursor) s.renderCursor = start;
  }

  function cancelPendingSources(s) {
    for (const src of s.pendingSources) {
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    }
    s.pendingSources = [];
  }

  function updateLiveDisplay(s) {
    if (!videoEl || !elements.target) return;
    const t = videoEl.currentTime;
    const idx = s.sentences.findIndex((sent) => sent.start <= t && sent.end >= t);
    if (idx === -1) return;
    const translated = s.translations[idx];
    const source = s.sentences[idx].text;
    if (translated) {
      currentTargetText = translated;
      setTargetText(translated);
    }
    currentSourceText = source;
    if (elements.source && settings.showSource) {
      elements.source.textContent = source.slice(-220);
    }
  }

  async function runRollingRenderer(s) {
    while (s === session && !s.stopFlag) {
      await new Promise((r) => setTimeout(r, 1000));
      if (s !== session || s.stopFlag) continue;
      if (!videoEl) continue;
      const t = videoEl.currentTime;
      const lookaheadSec = SUBFIRST_LOOKAHEAD_MS / 1000;
      let targetIdx = s.sentences.findIndex((sent) => sent.start > t + lookaheadSec);
      if (targetIdx === -1) targetIdx = s.sentences.length;
      if (targetIdx <= s.renderCursor) {
        // Nothing new to render this tick — refresh the on-screen line and idle.
        updateLiveDisplay(s);
        continue;
      }
      const start = s.renderCursor;
      const end = targetIdx;
      try {
        const firstUntranslated = s.translations.findIndex((v, i) => i >= start && i < end && !v);
        if (firstUntranslated !== -1) {
          await translateBatch(s, firstUntranslated, end);
        }
        if (s !== session || s.stopFlag) return;
        await renderWaveTTS(s, start, end);
        if (s !== session || s.stopFlag) return;
        scheduleWindow(s, start, end);
        s.renderCursor = end;
        updateLiveDisplay(s);
      } catch {
        // Background renderer never crashes the session. User still hears
        // what was already rendered; next tick retries.
      }
    }
  }

  // ───── Start session (token-bumped on each call) ──────────────────────────
  async function startSession(incomingSettings) {
    if (session) return { ok: false, error: "Session already running." };
    settings = { ...incomingSettings };
    // v0.6.1: background may override the Kyma API base with the Echoly
    // server proxy (subscription mode). Falls back to the BYOK constant.
    apiBase = settings.apiBase || KYMA_BASE;
    history = [];
    currentTargetText = "";
    currentSourceText = "";

    if (settings.tier === "standard") {
      // Subtitle-first path is YouTube-only in v0.3 and quietly falls back to
      // the chunked Standard pipeline when no caption track is available, so
      // existing users keep the Standard contract (lag tier, MiniMax voice)
      // without needing to flip any setting.
      //
      // Skip subtitle-first for live streams: it pauses the video to render
      // wave 1, which pushes a live viewer out of the live edge into DVR
      // mode permanently. Live + Standard goes straight to chunked, which
      // tolerates continuous playback. (SF6 / TC-6 design decision.)
      const probeVideo = findVideo();
      if (location.hostname.includes("youtube.com") && !isLive(probeVideo)) {
        return startSubtitleFirstSession();
      }
      return startStandardSession();
    }
    if (settings.tier !== "realtime") {
      return { ok: false, error: "Unknown tier: " + settings.tier };
    }

    const video = findVideo();
    if (!video) return { ok: false, error: "No YouTube video on this page." };
    videoEl = video;
    bindVolumeDriftGuard(video);
    const live = isLive(video);
    const wasPlaying = !video.paused;

    let stream;
    try {
      buildOverlay();
      bindRateChangeWarn(video);
      setStatusText("Acquiring audio");
      stream = await captureWithRetry(video);
    } catch (err) {
      removeOverlay();
      return { ok: false, error: err.message };
    }

    // Non-live sync (SF6): pause the video after we have capture tracks so
    // the speaker doesn't run ahead while we set up the WebRTC channel.
    // captureStream tracks survive pause (they emit silence), and resume
    // audio flow when video plays again. Live skips this — pausing a live
    // stream pushes the user out of the live edge permanently.
    if (!live) {
      try { video.pause(); } catch {}
      setStatusText("Connecting");
    }

    const token = ++pageToken;
    let newSession;
    try {
      newSession = await buildRealtimeSession(token, stream, {
        kymaKey: settings.kymaKey,
        targetLanguage: settings.targetLanguage,
        realtimeVoice: settings.realtimeVoice,
      });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      // Restore play state so the user isn't left staring at a frozen
      // frame after a build failure.
      if (!live && wasPlaying) {
        try { video.play().catch(() => {}); } catch {}
      }
      removeOverlay();
      const msg = err.cta
        ? `${err.message} (${err.cta})`
        : err.message;
      return { ok: false, error: msg };
    }
    if (token !== pageToken) {
      // Stop arrived during build
      try { newSession.pc.close(); } catch {}
      if (!live && wasPlaying) {
        try { video.play().catch(() => {}); } catch {}
      }
      removeOverlay();
      return { ok: false, error: "Cancelled before connect completed." };
    }

    session = newSession;
    setOverlayState("live");
    if (live) {
      setStatusText("Translating");
    } else {
      setStatusText("Almost ready");
    }
    startHeartbeat(session.kymaSessionId, session.kymaKey);
    startSessionTimer();
    applyVolumes(settings.originalVolume, settings.voiceVolume);
    applySourceVisibility();
    if (settings.showSource) startCaptionPoll();

    // Pause/play do NOT tear down the session — captureStream goes silent
    // naturally on YT pause, so OpenAI outputs silence. Resume is instant.
    onYTPause = () => {
      setStatusText("Paused");
      setOverlayState("paused");
      emitState({ paused: true, status: "Paused" });
    };
    onYTPlay = () => {
      setStatusText("Translating");
      setOverlayState("live");
      emitState({ paused: false, status: "Translating" });
    };
    // Realtime tier billing is per-minute via Kyma — stopping promptly on
    // video end matters more here than for Standard. The end event maps to
    // a clean session stop which fires the Kyma /end POST and releases the
    // realtime session collateral.
    const onYTEnded = () => {
      stopSession("video-ended");
      emitEnded("Video ended.");
    };
    video.addEventListener("pause", onYTPause);
    video.addEventListener("play", onYTPlay);
    video.addEventListener("ended", onYTEnded);
    session._onEnded = onYTEnded;

    // Non-live: PC is built; now wait briefly for ICE to actually connect
    // before resuming playback so the first audio captured already has a
    // live channel to flow into. Timeout falls through to play() anyway —
    // if PC truly failed, the iceconnectionstatechange listener inside
    // buildRealtimeSession will stop the session cleanly.
    if (!live) {
      await waitForPCConnected(newSession.pc, 3000);
      if (token !== pageToken) {
        return { ok: false, error: "Cancelled before play." };
      }
      try {
        await video.play();
        setStatusText("Translating");
      } catch {
        // play() blocked by autoplay policy despite our best-effort gesture
        // chain. Surface a prompt so the user knows what to do.
        setStatusText("Press YouTube play to start dub");
        showToast("Press YouTube play to start dub", 6000);
      }
    }

    emitState({ running: true, paused: false, status: "Translating" });
    return { ok: true };
  }

  function stopSession(reason = "stop") {
    pageToken += 1;
    clearSessionTimer();
    stopHeartbeat();
    stopCaptionPoll();
    if (videoEl) {
      if (onYTPause) videoEl.removeEventListener("pause", onYTPause);
      if (onYTPlay) videoEl.removeEventListener("play", onYTPlay);
      // Subtitle-first session has its own seek listener attached on start.
      if (session?.type === "subtitle-first" && session._onSeeked) {
        try { videoEl.removeEventListener("seeked", session._onSeeked); } catch {}
      }
      // All session types attach an `ended` listener for auto-stop on
      // natural video end. Remove it here to avoid the (now-detached)
      // handler re-entering stopSession on the next end event.
      if (session?._onEnded) {
        try { videoEl.removeEventListener("ended", session._onEnded); } catch {}
      }
      // SF3 — drop the volume drift guard before resetting volume, so our
      // own restore writes don't trigger it.
      unbindVolumeDriftGuard();
      // SF8 — drop the playback-rate warn listener too.
      unbindRateChangeWarn();
      videoEl.muted = false;
      videoEl.volume = 1.0;
      videoEl = null;
    }
    onYTPause = null;
    onYTPlay = null;
    if (session) {
      try {
        // Standard tier: halt the recorder loop so no further chunks fire,
        // and abort any in-flight whisper/translate/TTS fetch so we stop
        // burning Kyma credits the moment the user clicks Stop.
        if (session.type === "standard") {
          session.stopFlag = true;
          if (session.abortController) {
            try { session.abortController.abort(); } catch {}
          }
          if (session.activeRecorder && session.activeRecorder.state !== "inactive") {
            try { session.activeRecorder.stop(); } catch {}
          }
        }
        if (session.type === "subtitle-first") {
          session.stopFlag = true;
          if (session.abortController) {
            try { session.abortController.abort(); } catch {}
          }
          cancelPendingSources(session);
        }
        if (session.remoteAudio) {
          session.remoteAudio.pause();
          session.remoteAudio.srcObject = null;
          session.remoteAudio.remove();
        }
        if (session.outputGain) session.outputGain.disconnect();
        if (session.audioCtx) session.audioCtx.close();
        if (session.dc) session.dc.close();
        if (session.pc) session.pc.close();
        if (session.stream) session.stream.getTracks().forEach((t) => t.stop());
      } catch {}
      // Realtime tier holds Kyma session collateral; standard tier doesn't.
      if (session.kymaSessionId) {
        void endKymaSession(session.kymaSessionId, session.kymaKey);
      }
      session = null;
    }
    if (prevSession) {
      try { prevSession.pc?.close(); } catch {}
      void endKymaSession(prevSession.kymaSessionId, prevSession.kymaKey);
      prevSession = null;
    }
    history = [];
    currentTargetText = "";
    removeOverlay();
  }

  function applySettingsLive(newSettings) {
    const prev = settings || {};
    settings = { ...prev, ...newSettings };
    // Tier swap mid-session needs a full restart (different pipelines, can't
    // hot-swap). Surface the constraint so the user knows why their toggle
    // didn't take effect; they can press Stop then Start.
    if ("tier" in newSettings && newSettings.tier !== prev.tier && session) {
      showToast("Stop and Start to switch tiers", 5000);
    }
    if (elements.langSelect && newSettings.targetLanguage) {
      elements.langSelect.value = newSettings.targetLanguage;
    }
    // Voice select shape depends on tier — repopulate before assigning value
    // so the new id exists in the dropdown.
    if (elements.voiceSelect &&
        (newSettings.realtimeVoice !== undefined || newSettings.standardVoice !== undefined)) {
      const tier = settings.tier || "realtime";
      populateVoicePicker(tier);
    }
    if ("showSource" in newSettings) {
      applySourceVisibility();
      if (settings.showSource && session) startCaptionPoll();
      else stopCaptionPoll();
    }
    // Realtime swaps require a full session handover (new client_secret +
    // PeerConnection). Standard pipeline picks up new lang/voice on the next
    // chunk — no tear-down required.
    if (session?.type !== "standard") {
      if (("targetLanguage" in newSettings && newSettings.targetLanguage !== prev.targetLanguage) ||
          ("realtimeVoice" in newSettings && newSettings.realtimeVoice !== prev.realtimeVoice)) {
        void requestHandover(newSettings);
      }
    }
    if ("originalVolume" in newSettings || "voiceVolume" in newSettings) {
      applyVolumes(settings.originalVolume, settings.voiceVolume);
    }
  }

  // ───── SPA navigation handling ────────────────────────────────────────────
  // YT navigates internally without full page reload. Our static manifest
  // ensures content.js loads on /watch URLs, but a /watch → /watch nav
  // happens via History API. Detect URL change and stop session cleanly.
  setInterval(() => {
    if (location.href !== lastSpaUrl) {
      lastSpaUrl = location.href;
      if (session) {
        stopSession("yt-navigation");
        emitEnded("YouTube navigated.");
      }
    }
  }, 500);

  // ───── Tab unload — fire /end with keepalive ──────────────────────────────
  const handleUnload = () => {
    if (session) {
      void endKymaSession(session.kymaSessionId, session.kymaKey);
    }
  };
  window.addEventListener("beforeunload", handleUnload);
  window.addEventListener("pagehide", handleUnload);

  // ───── Background message router ──────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      switch (msg?.type) {
        case "CONTENT_PING":
          sendResponse({ ok: true, version: ECHOLY_VERSION });
          break;
        case "CONTENT_START":
          sendResponse(await startSession(msg.settings || {}));
          break;
        case "CONTENT_STOP":
          stopSession("backend-stop");
          sendResponse({ ok: true });
          break;
        case "CONTENT_UPDATE_SETTINGS":
          applySettingsLive(msg.settings || {});
          sendResponse({ ok: true });
          break;
        case "CONTENT_UPDATE_VOLUME":
          settings = { ...(settings || {}), originalVolume: msg.originalVolume, voiceVolume: msg.voiceVolume };
          applyVolumes(msg.originalVolume, msg.voiceVolume);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "Unknown content message: " + msg?.type });
      }
    })();
    return true;
  });
})();
