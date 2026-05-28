// ────────────────────────────────────────────────────────────────────────────
// RealtimePipeline — WebRTC PeerConnection lifecycle for the Realtime tier, and
// the zero-gap F4 handover. Mint/heartbeat/end hit apiBase; the SDP offer POSTs
// DIRECT to OPENAI_CALLS_URL (bypasses apiBase — the legacy client-direct WebRTC
// seam). Realtime callbacks use the DUAL token-guard (sm.isRealtimeStale).
// (legacy/content.js: buildRealtimeSession 637, handleRealtimeEvent 799,
// requestHandover 930.)
// ────────────────────────────────────────────────────────────────────────────

import { LANG_NAME, OPENAI_CALLS_URL } from "@/shared/constants";
import { parseKymaError } from "@/lib/kyma";
import { parseServerError, type ParsedServerError } from "@/lib/server-errors";
import { computeGain } from "@/lib/audio";
import type { RealtimeSession } from "../session-manager";
import type { ContentApp } from "../index";

/** Result of the SDP exchange — same shape for BYOK (client-direct OpenAI)
 *  and proxy (server-mediated /v1/rtc/translate). */
interface SignalingResult {
  answerSdp: string;
  /** Server-issued realtime session id (BYOK: Kyma's; proxy: rt_<ulid>). Used
   *  as the keying for heartbeat + end. */
  sessionId: string | null;
  /** Auth bearer for subsequent heartbeat/end calls. BYOK: client_secret;
   *  proxy: the Echoly ec_session token. */
  bearer: string;
}

/** A build error that may carry a CTA (insufficient_balance). */
interface CtaError extends Error {
  cta?: string;
  ctaLabel?: string;
}

export interface RealtimeBuildOpts {
  kymaKey: string;
  targetLanguage: string;
  realtimeVoice: string;
}

export class RealtimePipeline {
  constructor(private readonly app: ContentApp) {}

  /**
   * Build a fully-wired (but NOT yet active) realtime session: mint a client
   * secret from Kyma → create the PeerConnection + data channel → pre-create the
   * Web Audio graph → SDP offer/answer DIRECT to OpenAI. Returns the session;
   * the CALLER assigns it to `sm.session` after a token recheck. Every async
   * step is dual-guarded. (legacy buildRealtimeSession.)
   */
  async buildRealtimeSession(
    token: number,
    audioStream: MediaStream,
    opts: RealtimeBuildOpts,
  ): Promise<RealtimeSession> {
    const { sm, overlay } = this.app;
    const kymaKey = opts.kymaKey;
    const lang = opts.targetLanguage || "vi";
    const voice = opts.realtimeVoice || "";

    overlay.setStatusText("Connecting");
    overlay.setOverlayState("connecting");

    // World switch (Wave 3): proxy (signed-in) skips the Kyma mint entirely —
    // SDP goes straight to /v1/rtc/translate with ec_session Bearer. BYOK
    // (guest) keeps the legacy client_secret mint + SDP-direct-to-OpenAI flow.
    const isProxy = sm.settings?.apiMode === "proxy";

    let clientSecret: string | undefined;
    let kymaSessionId: string | null = null;

    if (!isProxy) {
      let mintResp: Response;
      try {
        mintResp = await fetch(
          `${sm.apiBase}/realtime/translations/client_secrets`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + kymaKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              session: {
                model: "gpt-realtime-translate",
                audio: {
                  output: { language: lang, ...(voice ? { voice } : {}) },
                },
              },
            }),
          },
        );
      } catch {
        throw new Error("Network error reaching Kyma.");
      }
      if (token !== sm.pageToken) throw new Error("Stale session.");
      if (!mintResp.ok) {
        const text = await mintResp.text().catch(() => "");
        const parsed = parseKymaError(mintResp.status, text);
        const err: CtaError = new Error(parsed.user);
        err.cta = parsed.cta;
        err.ctaLabel = parsed.ctaLabel;
        throw err;
      }
      const mint = (await mintResp.json()) as {
        value?: string;
        kyma_session_id?: string;
      };
      if (token !== sm.pageToken) throw new Error("Stale session.");
      clientSecret = mint.value;
      kymaSessionId = mint.kyma_session_id ?? null;
      if (!clientSecret) throw new Error("Kyma response missing client_secret.");
    }

    const pc = new RTCPeerConnection();
    for (const track of audioStream.getAudioTracks())
      pc.addTrack(track, audioStream);

    const dc = pc.createDataChannel("oai-events");
    dc.addEventListener("message", (e: MessageEvent) => {
      if (sm.isRealtimeStale(token)) return;
      this.handleRealtimeEvent(e.data as string, token);
    });

    // Pre-create AudioContext + outputGain BEFORE ontrack so the Voice slider
    // has a valid target during the 2-5s Realtime cold-start (SF3 fix).
    let preCtx: AudioContext | null = null;
    let preGain: GainNode | null = null;
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      preCtx = new Ctor();
      if (preCtx.state === "suspended") preCtx.resume().catch(() => {});
      preGain = preCtx.createGain();
      preGain.gain.value = computeGain(sm.settings?.voiceVolume ?? 100);
      preGain.connect(preCtx.destination);
    } catch {
      try {
        preCtx?.close();
      } catch {
        /* ignore */
      }
      preCtx = null;
      preGain = null;
    }

    const newSession: RealtimeSession = {
      token,
      pc,
      dc,
      stream: audioStream,
      remoteAudio: null,
      audioCtx: preCtx,
      outputGain: preGain,
      kymaSessionId,
      kymaKey,
      targetLanguage: lang,
      realtimeVoice: voice,
    };

    pc.addEventListener("track", (event: RTCTrackEvent) => {
      if (newSession.remoteAudio) return;
      const audio = document.createElement("audio");
      audio.autoplay = true;
      // Default muted; flipped to false on HTMLAudio fallback.
      audio.muted = true;
      audio.srcObject = event.streams[0]!;
      document.body.appendChild(audio);
      newSession.remoteAudio = audio;

      // Advanced outputDeviceId — route the dub track to the user-chosen sink.
      // setSinkId may reject (Bluetooth removal, permissioned device gone, etc.);
      // we log and stay on the default sink so playback never silently breaks.
      const sinkId = sm.settings?.advanced?.outputDeviceId ?? "";
      const a = audio as HTMLAudioElement & {
        setSinkId?: (id: string) => Promise<void>;
      };
      if (sinkId && typeof a.setSinkId === "function") {
        a.setSinkId(sinkId).catch((err: unknown) => {
          console.warn(
            "[echoly] setSinkId failed for Realtime remote audio; falling back to default",
            err,
          );
        });
      }

      const ctxRunning =
        !!newSession.audioCtx && newSession.audioCtx.state !== "closed";
      if (newSession.outputGain && ctxRunning) {
        try {
          const src = newSession.audioCtx!.createMediaStreamSource(
            event.streams[0]!,
          );
          src.connect(newSession.outputGain);
          if (newSession.audioCtx!.state === "suspended") {
            newSession.audioCtx!.resume().catch(() => {});
          }
        } catch {
          // Web Audio wiring failed — tear down + play through HTMLAudio.
          try {
            newSession.audioCtx!.close();
          } catch {
            /* ignore */
          }
          newSession.audioCtx = null;
          newSession.outputGain = null;
          audio.muted = false;
          audio.volume = Math.min((sm.settings?.voiceVolume ?? 100) / 100, 1.0);
        }
      } else {
        // No usable Web Audio context — HTMLAudio fallback.
        if (newSession.audioCtx) {
          try {
            newSession.audioCtx.close();
          } catch {
            /* ignore */
          }
        }
        newSession.audioCtx = null;
        newSession.outputGain = null;
        audio.muted = false;
        audio.volume = Math.min((sm.settings?.voiceVolume ?? 100) / 100, 1.0);
      }
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      if (sm.isRealtimeStale(token)) return;
      if (
        ["closed", "failed", "disconnected"].includes(pc.iceConnectionState)
      ) {
        // The newSession===session check prevents a stale handover candidate
        // from killing the live session.
        if (newSession === sm.session) {
          this.app.stopSession("connection-lost");
          sm.emitEnded("Connection lost.");
        }
      }
    });

    const offer = await pc.createOffer();
    if (token !== sm.pageToken) throw new Error("Stale session.");
    await pc.setLocalDescription(offer);

    // SDP exchange — two worlds:
    //  • BYOK  : DIRECT to OpenAI (ephemeral clientSecret from the Kyma mint
    //            above). Kyma cannot relay WebRTC media plane, hence the
    //            client-direct seam — see plan §2 / patch comments.
    //  • Proxy : single POST to ${apiBase}/rtc/translate with the ec_session
    //            Bearer; server (mediasoup) terminates the peer + bridges to
    //            OpenAI server-side using its own provider key. Server-issued
    //            session id arrives in the `X-Echoly-Session-Id` response header.
    let sdpResp: Response;
    if (isProxy) {
      const qs = new URLSearchParams({ targetLanguage: lang });
      if (voice) qs.set("voice", voice);
      sdpResp = await fetch(`${sm.apiBase}/rtc/translate?${qs.toString()}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + kymaKey, // proxy mode: kymaKey === ec_session
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });
    } else {
      sdpResp = await fetch(OPENAI_CALLS_URL, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + clientSecret!,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });
    }
    if (token !== sm.pageToken) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      throw new Error("Stale session.");
    }
    if (!sdpResp.ok) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      // Proxy mode: server returns the unified 402/429/413 envelope on
      // tier_locked/quota/etc. — parse it so the controller can surface the
      // Upgrade CTA. BYOK: the legacy raw-text path is sufficient (mint already
      // burned its own error path; SDP failures here are mostly OpenAI-internal).
      if (isProxy) {
        const parsed = await parseServerError(sdpResp);
        const err: CtaError = new Error(parsed.user);
        if (parsed.cta) err.cta = parsed.cta;
        if (parsed.ctaLabel) err.ctaLabel = parsed.ctaLabel;
        throw err;
      }
      const t = await sdpResp.text().catch(() => "");
      void sm.endKymaSession(kymaSessionId, kymaKey);
      throw new Error(`SDP exchange ${sdpResp.status}: ${t.slice(0, 160)}`);
    }
    // Capture the server-issued session id (proxy) — used for heartbeat + end.
    // BYOK kymaSessionId came from the mint response above.
    if (isProxy) {
      kymaSessionId = sdpResp.headers.get("x-echoly-session-id") || null;
    }
    const answerSdp = await sdpResp.text();
    if (token !== sm.pageToken) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      throw new Error("Stale session.");
    }
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    return newSession;
  }

  /** Realtime data-channel event handler (dual-guarded at entry). Appends
   *  transcript deltas to currentTargetText; on done, pushes a history turn.
   *  Multi-name acceptance handles OpenAI event-name drift. (legacy.) */
  handleRealtimeEvent(raw: string, token: number): void {
    const { sm, overlay } = this.app;
    if (sm.isRealtimeStale(token)) return;
    let evt: {
      type?: string;
      delta?: unknown;
      transcript?: string;
    };
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }
    if (evt.type === "error") {
      overlay.setStatusText("Translation error");
      return;
    }
    const isDelta =
      evt.type === "session.output_transcript.delta" ||
      evt.type === "response.audio_transcript.delta" ||
      evt.type === "response.output_audio_transcript.delta" ||
      (evt.type === "response.text.delta" && typeof evt.delta === "string");
    if (isDelta && evt.delta) {
      sm.currentTargetText += evt.delta as string;
      overlay.setTargetText(sm.currentTargetText);
      overlay.setOverlayState("live");
      return;
    }
    const isDone =
      evt.type === "session.output_transcript.done" ||
      evt.type === "response.audio_transcript.done" ||
      evt.type === "response.output_audio_transcript.done" ||
      evt.type === "response.text.done";
    if (isDone) {
      if (evt.transcript) sm.currentTargetText = evt.transcript;
      overlay.setTargetText(sm.currentTargetText);
      this.app.pushHistoryTurn();
      return;
    }
  }

  /**
   * F4 — realtime-only zero-gap lang/voice swap. No-op if unchanged. Marks a
   * history turn with a `→` chip, bumps the token, builds a NEW parallel session,
   * swaps it in, and 400ms later tears down prevSession. On build failure it
   * KEEPS the old session running. (legacy requestHandover.)
   *
   * NOTE on H3 (preserved, not "fixed"): the token is bumped BEFORE the build
   * and is NOT reverted on the failure path — matching legacy behavior exactly.
   */
  async requestHandover(partial: {
    targetLanguage?: string;
    realtimeVoice?: string;
  }): Promise<void> {
    const { sm, overlay, capture } = this.app;
    const session = sm.session;
    if (!session) return;
    // `session` here is always a realtime session (only realtime calls this).
    const rt = session as RealtimeSession;
    const baseSettings = sm.settings!;
    const newSettings = { ...baseSettings, ...partial };
    const same =
      newSettings.targetLanguage === rt.targetLanguage &&
      (newSettings.realtimeVoice || "") === (rt.realtimeVoice || "");
    if (same) return;

    const fromLang = LANG_NAME[rt.targetLanguage] || rt.targetLanguage;
    const toLang =
      LANG_NAME[newSettings.targetLanguage] || newSettings.targetLanguage;
    if (newSettings.targetLanguage !== rt.targetLanguage) {
      // Marker chip "vi → en" (legacy content.js:942). The overlay owns the
      // flush of its in-flight turn + the chip; mirror the legacy reset of the
      // logic-side current-turn buffer so the next session's deltas start fresh.
      overlay.pushHistoryMarker(`${fromLang} → ${toLang}`);
      sm.currentTargetText = "";
      overlay.setStatusText("Switching to " + toLang);
    } else {
      // Marker chip "Switching voice" (legacy content.js:945).
      overlay.pushHistoryMarker("Switching voice");
      sm.currentTargetText = "";
      overlay.setStatusText("Switching voice");
    }
    overlay.setOverlayState("connecting");

    const newToken = sm.nextToken();
    sm.settings = newSettings;
    sm.notifyBackground({ type: "UPDATE_SETTINGS", settings: newSettings });
    overlay.populateVoicePicker("realtime", newSettings.realtimeVoice || "");
    // Sync the language <select> to the new target (legacy content.js:953).
    overlay.setLanguageSelection(newSettings.targetLanguage);

    let newSession: RealtimeSession;
    try {
      newSession = await this.buildRealtimeSession(newToken, rt.stream!, {
        kymaKey: newSettings.kymaKey,
        targetLanguage: newSettings.targetLanguage,
        realtimeVoice: newSettings.realtimeVoice,
      });
      if (newToken !== sm.pageToken) {
        // Yet another change came in; abandon this build.
        try {
          newSession.pc!.close();
        } catch {
          /* ignore */
        }
        return;
      }
    } catch (err) {
      if (newToken !== sm.pageToken) return;
      overlay.setStatusText("Switch failed — keeping current session");
      overlay.setOverlayState("live");
      const e = err as CtaError;
      overlay.showToast(e.message, {
        durationMs: 9000,
        cta: e.cta,
        ctaLabel: e.ctaLabel,
      });
      return; // Old session stays running — no swap performed.
    }

    // Swap: install new, hold old, tear down old 400ms later.
    sm.prevSession = sm.session;
    sm.session = newSession;
    overlay.setStatusText("Translating");
    overlay.setOverlayState("live");

    setTimeout(() => {
      const prev = sm.prevSession;
      if (prev) {
        try {
          if (prev.remoteAudio) {
            prev.remoteAudio.pause();
            prev.remoteAudio.srcObject = null;
            prev.remoteAudio.remove();
          }
          if (prev.outputGain) prev.outputGain.disconnect();
          if (prev.audioCtx) prev.audioCtx.close();
          prev.pc?.close();
        } catch {
          /* best-effort teardown */
        }
        void sm.endKymaSession(prev.kymaSessionId, prev.kymaKey);
        sm.prevSession = null;
      }
    }, 400);

    sm.startHeartbeat(newSession.kymaSessionId, newSession.kymaKey);
    capture.applyVolumes(newSettings.originalVolume, newSettings.voiceVolume);
  }
}
