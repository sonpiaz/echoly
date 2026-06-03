# External Best Practices: Smooth Dub — Startup Latency, A/V Sync, Buffering, Loading UX

**Research agent: external authoritative sources**
**Date: 2026-06-02**
**Scope:** Techniques extracted from web standards, browser vendor blogs, and real-world player codebases. Each section maps directly to one of the four user complaints. Highest-leverage techniques are marked `[HIGH]`.

---

## 0. Map to complaints

| Complaint | Primary sections |
|---|---|
| 1. Long startup latency before first dub audio | §1 Perceived latency UX, §2 WebRTC warmup, §3 TTS streaming + prebuffer |
| 2. A/V desync on resume | §4 Pause/Resume gating |
| 3. Overall smoothness | §3 Audio scheduling, §4 drift correction, §5 AudioContext unlock |
| 4. No branded loading indicator | §6 Branded UX |

---

## 1. Perceived Latency Reduction — Optimistic UI and Speculative Prefetch

### 1.1 Optimistic UI [HIGH]

**What it is:** Update the UI immediately on user action, assume success, and correct only on error. The user sees the result of their click before any server round-trip completes.

**When to apply:** The moment the user clicks "Start". Show the overlay in its "connecting" state (spinner, pulsing logo) before any network call is made. Do not wait for the WebRTC connection to be established before showing UI.

**Implementation sketch:**
```js
startButton.addEventListener('click', () => {
  // 1. Immediately show overlay in "connecting" state
  showOverlay({ state: 'connecting' });
  // 2. Start the connection process in the background
  startDubSession().catch(err => {
    showOverlay({ state: 'error', message: err.message });
  });
});
```

**Pitfall:** If the connection fails, the optimistic state must be rolled back cleanly. Always have an error path that returns the overlay to a neutral state.

**Source:** [Pending and Optimistic UI — Remix docs](https://v2.remix.run/docs/discussion/pending-ui/); [LogRocket — skeleton loading screen design](https://blog.logrocket.com/ux-design/skeleton-loading-screen-design/)

---

### 1.2 Speculative Preconnect on User Intent [HIGH]

**What it is:** DNS resolution + TCP + TLS handshake to the API server triggered on hover/focus, before the user clicks Start. By the time they click, the connection socket is already open.

**When to apply:** Whenever the user moves focus toward the Start button (mouseenter, focusin). The preconnect costs ~0 if unused (connection is dropped after a few seconds of idle), but saves 200–400 ms if the click follows.

**Implementation sketch (content script):**
```js
// Injected in extension content script — use DOM API, not <link> tags
startBtn.addEventListener('mouseenter', () => {
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = 'https://api.echolyhq.com';
  document.head.appendChild(link);
  // Also DNS-prefetch the OpenAI realtime endpoint
  const dns = document.createElement('link');
  dns.rel = 'dns-prefetch';
  dns.href = 'https://api.openai.com';
  document.head.appendChild(dns);
}, { once: true });
```

**Pitfall:** `preconnect` hints in injected scripts still work (they target the document's network stack). However, the extension's `permissions` manifest must allow connections to those origins anyway. Avoid injecting duplicate hints on repeated hover.

**Source:** [MDN — Speculative loading](https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Speculative_loading); [web.dev — resource hints](https://web.dev/learn/performance/resource-hints)

---

### 1.3 Progressive Disclosure / Time Estimation

**What it is:** Show a progress bar or phase label ("Connecting…", "Buffering…", "Ready!") that advances through predictable states. Even fake progress reduces perceived wait by up to 30%.

**When to apply:** During the startup sequence: connecting → first-chunk received → playing.

**Implementation sketch:**
```js
const phases = ['Connecting', 'Warming up', 'Buffering first dub…', 'Playing'];
let phaseIndex = 0;
function advancePhase() {
  overlayLabel.textContent = phases[Math.min(phaseIndex++, phases.length - 1)];
}
// Call advancePhase() at each real milestone:
// - after WebRTC ICE connected
// - after first TTS chunk decoded
// - on first AudioBufferSourceNode.start()
```

**Source:** [Designing for the Doherty Threshold — LogRocket](https://blog.logrocket.com/ux-design/designing-instant-feedback-doherty-threshold/); [Skeleton screens research — SitePoint](https://www.sitepoint.com/how-to-speed-up-your-ux-with-skeleton-screens/)

---

## 2. WebRTC Time-to-First-Audio Reduction

### 2.1 Trickle ICE [HIGH]

**What it is:** Send ICE candidates to the signaling server as they are discovered locally, rather than waiting for ICE gathering to complete. The remote peer can start connectivity checks immediately against each candidate as it arrives.

**When to apply:** Always. This is the single highest-leverage WebRTC latency optimization and is now the default expectation per the W3C spec.

**Connection timeline without Trickle ICE:**
```
T0: setLocalDescription()
T1: [waiting for ALL candidates]  ← up to 2–3 s on mobile
T2: send offer+all candidates to server
T3: server responds with answer
T4: ICE checks begin
T5: DTLS handshake
T6: first audio arrives
```

**Connection timeline with Trickle ICE:**
```
T0: setLocalDescription()
T0+50ms: first host candidate sent → ICE checks begin immediately
T1: server reflexive candidate sent → checks continue
T2: DTLS handshake runs in parallel with remaining gathering
T3: first audio arrives  ← 500 ms–1.5 s saved
```

**Implementation sketch:**
```js
const pc = new RTCPeerConnection({ iceServers });

// Send each candidate as it arrives
pc.addEventListener('icecandidate', (e) => {
  if (e.candidate) {
    signalingChannel.send({ type: 'candidate', candidate: e.candidate });
  }
  // null candidate = gathering complete; signal this too
});

// On the receiving end, add each candidate immediately
signalingChannel.on('candidate', async ({ candidate }) => {
  // PITFALL: must buffer candidates that arrive before setRemoteDescription()
  if (pc.remoteDescription) {
    await pc.addIceCandidate(candidate);
  } else {
    pendingCandidates.push(candidate);
  }
});

// After setRemoteDescription(), flush buffered candidates
await pc.setRemoteDescription(answer);
for (const c of pendingCandidates) {
  await pc.addIceCandidate(c);
}
pendingCandidates = [];
```

**Critical pitfall:** `addIceCandidate()` throws if called before `setRemoteDescription()`. Always buffer candidates that arrive before the remote description is set, and drain the buffer immediately after.

**Source:** [GetStream — ICE Candidate Tutorial](https://getstream.io/resources/projects/webrtc/basics/ice-candidates/); [webrtcHacks — Trickle ICE](https://webrtchacks.com/trickle-ice/); [webrtc.org — peer connections](https://webrtc.org/getting-started/peer-connections)

---

### 2.2 ICE Candidate Pool Pre-warming [HIGH]

**What it is:** `RTCConfiguration.iceCandidatePoolSize` tells the browser to begin ICE candidate gathering *before* `setLocalDescription()` is called. Candidates are ready by the time the user triggers a call.

**When to apply:** Create the `RTCPeerConnection` on page load (or on Start button hover), with `iceCandidatePoolSize > 0`, so STUN/TURN round-trips happen in the background before the user has even initiated the call.

**Implementation sketch:**
```js
// Pre-warm on extension load or on Start hover
let warmPc = null;

function preWarmPeerConnection() {
  if (warmPc) return;
  warmPc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    iceCandidatePoolSize: 4,  // gather 4 candidates speculatively
  });
}

// On actual Start:
function startCall() {
  const pc = warmPc ?? new RTCPeerConnection({ iceServers });
  warmPc = null;  // consume the warmed connection
  // ... proceed with offer/answer
}
```

**Pitfall:** If `iceCandidatePoolSize` is changed after `setLocalDescription()` has already been called, the operation throws. Pool the connection before negotiation begins. Also: if the user never starts, the dormant RTCPeerConnection should be closed on tab unload to free resources.

**Source:** [MDN — RTCPeerConnection constructor](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection); [Chromium Intent to Ship — ICE candidate pooling](https://groups.google.com/a/chromium.org/g/blink-dev/c/dWXRWoi5ueg/m/nFiVhj5LCAAJ)

---

### 2.3 OpenAI Realtime API — Unified Interface and Ephemeral Token Timing [HIGH]

**What it is:** OpenAI's WebRTC Realtime API supports two connection flows. The "Unified Interface" combines SDP + session configuration in a single server round-trip. The "Ephemeral Token" flow mints a short-lived credential server-side, so the browser can connect directly to OpenAI without exposing the API key.

**Startup latency anatomy (Ephemeral Token path):**
```
Browser → Server:  "mint me a token"           (HTTP, ~50–150 ms)
Server → OpenAI:   token mint request           (HTTP, ~100–300 ms)
Server → Browser:  ephemeral token              
Browser creates RTCPeerConnection + SDP offer   (~10 ms)
Browser → OpenAI:  POST /v1/realtime/calls + SDP offer  (~50–200 ms)
OpenAI → Browser:  answer SDP                  
ICE checks + DTLS handshake                    (~100–500 ms)
First audio frame                              
TOTAL: ~400–1200 ms
```

**Optimization:** Pre-fetch the ephemeral token on Start button hover (it's just an HTTP request). By the time the user clicks, the token is already in memory. Then create the peer connection and fire off the offer immediately.

**Implementation sketch:**
```js
let pendingToken = null;

startBtn.addEventListener('mouseenter', async () => {
  if (!pendingToken) {
    pendingToken = fetchEphemeralToken(); // returns a Promise
  }
}, { once: true });

async function startRealtimeSession() {
  const token = await (pendingToken ?? fetchEphemeralToken());
  pendingToken = null;
  const pc = new RTCPeerConnection({ iceCandidatePoolSize: 4 });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const answer = await postToOpenAI(token, offer.sdp);
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });
}
```

**OpenAI's actual ICE configuration** (as of GA release): advertises 3 Azure-distributed endpoints, uses port 443 TCP (firewall-friendly), uses Opus with in-band FEC for error resilience.

**Source:** [OpenAI Realtime WebRTC docs](https://developers.openai.com/api/docs/guides/realtime-webrtc); [webrtcHacks — How OpenAI does WebRTC](https://webrtchacks.com/how-openai-does-webrtc-in-the-new-gpt-realtime/); [SheerBit — Getting Started with OpenAI Realtime over WebRTC](https://sheerbit.com/getting-started-with-openai-realtime-over-webrtc-architecture-signaling-and-first-audio-call/)

---

### 2.4 DTLS 1.3 (Browser Default as of 2025)

**What it is:** DTLS 1.3 removes one full round-trip from the handshake (compared to DTLS 1.2). Chrome 137+, Firefox 123+, Safari 17+ default to DTLS 1.3. No application code change needed — this is automatic if both peers support it.

**Benefit:** ~50 ms saved on high-latency links, more on mobile.

**Source:** [VideoSDK — WebRTC Low Latency 2025](https://www.videosdk.live/developer-hub/webrtc/webrtc-low-latency); [webrtc-developers.com — anatomy of a WebRTC connection](https://www.webrtc-developers.com/anatomy-of-a-webrtc-connection/)

---

## 3. Chunked TTS Audio Scheduling Against Video Clock

### 3.1 The "Tale of Two Clocks" Lookahead Scheduler [HIGH]

**What it is:** The canonical Web Audio scheduling pattern from Chris Wilson (web.dev). `AudioContext.currentTime` is a high-precision audio clock (accurate to sample level) that runs on a separate thread, unaffected by main-thread GC or layout. `setTimeout` is imprecise (~4–15 ms jitter). The pattern uses `setTimeout` as a *wakeup mechanism* to look ahead and pre-schedule audio events using the audio clock.

**When to apply:** Whenever you are scheduling sequences of audio chunks (TTS segments) that must play at specific video-clock times.

**Core loop:**
```js
const SCHEDULE_AHEAD_TIME = 0.1;   // 100ms lookahead window
const SCHEDULER_INTERVAL  = 25;    // 25ms wakeup interval

let nextChunkTime = audioCtx.currentTime; // audio-clock time for next chunk

function scheduleChunks() {
  while (chunkQueue.length > 0 &&
         chunkQueue[0].videoTime <= videoEl.currentTime + SCHEDULE_AHEAD_TIME) {
    const chunk = chunkQueue.shift();
    // Map video time → audio clock time
    const audioTime = audioCtx.currentTime +
                      (chunk.videoTime - videoEl.currentTime);
    playChunk(chunk.buffer, Math.max(audioTime, nextChunkTime));
    nextChunkTime = audioCtx.currentTime + chunk.buffer.duration;
  }
  setTimeout(scheduleChunks, SCHEDULER_INTERVAL);
}

function playChunk(audioBuffer, startAt) {
  const src = audioCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(audioCtx.destination);
  src.start(startAt);
  // Fire-and-forget; src is garbage collected after it finishes
}
```

**Tuning:** Start with 100 ms lookahead / 25 ms interval. On slow devices widen the lookahead. Narrowing the lookahead reduces latency but risks "ticks" if GC fires.

**Source:** [web.dev — A Tale of Two Clocks](https://web.dev/articles/audio-scheduling); [ircam-ismm — Timing and Scheduling tutorial](https://ircam-ismm.github.io/webaudio-tutorials/scheduling/timing-and-scheduling.html)

---

### 3.2 Gapless Sequential AudioBufferSourceNode Chaining [HIGH]

**What it is:** Each `AudioBufferSourceNode` is single-use. To play successive TTS chunks with zero gap, schedule each node's `start()` at the *exact end time* of the previous node.

**Critical pitfall (45 ms gap bug):** AAC/MP3 encoders add priming silence at the beginning of each chunk. If you play chunks sequentially without detecting and skipping this silence, you get audible 45 ms gaps between segments.

**Implementation sketch:**
```js
let nextStartTime = audioCtx.currentTime; // tracks end of last scheduled chunk

async function enqueueChunk(arrayBuffer) {
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  // Detect and skip encoder priming silence (AAC/MP3)
  const gapDuration = findStartGapDuration(audioBuffer);

  const src = audioCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(audioCtx.destination);

  // Schedule to start exactly when the previous chunk ends,
  // but skip the encoder's priming silence
  const scheduleAt = Math.max(nextStartTime, audioCtx.currentTime + 0.01);
  src.start(scheduleAt, gapDuration);

  // Advance the pointer by the audible duration (total - gap)
  nextStartTime = scheduleAt + (audioBuffer.duration - gapDuration);
}

function findStartGapDuration(audioBuffer) {
  const ch = audioBuffer.getChannelData(0);
  for (let i = 0; i < ch.length; i++) {
    if (Math.abs(ch[i]) > 1e-4) return i / audioBuffer.sampleRate;
  }
  return 0;
}
```

**For streaming TTS (chunks arriving live):** Use `nextStartTime` as the single source of truth. If a chunk arrives before the previous one has started playing, it will be queued correctly. If a chunk arrives *late* (after `nextStartTime` has passed), clamp `scheduleAt` to `audioCtx.currentTime + smallSafetyMargin` and accept that one gap.

**Source:** [JakeArchibald.com — Sounds Fun](https://jakearchibald.com/2016/sounds-fun/); [web-audio-buffer-queue library](https://github.com/Johni0702/web-audio-buffer-queue); [GitHub — fetch-stream-audio (AnthumChris)](https://github.com/AnthumChris/fetch-stream-audio)

---

### 3.3 Adaptive Prebuffer Threshold Before First Playback

**What it is:** Do not start playback immediately on the first decoded chunk. Accumulate a minimum buffer (40–150 ms of audio) before starting the scheduler. This absorbs network jitter and prevents the very first chunk from playing then immediately stalling if the second chunk is slow.

**When to apply:** Standard tier (TTS-driven dub). Realtime WebRTC manages its own jitter buffer in the audio codec layer (Opus in-band FEC) — this technique is for the Standard path only.

**Implementation sketch:**
```js
const MIN_PREBUFFER_DURATION = 0.12; // 120 ms (tune per network)
let prebufferDuration = 0;
let prebufferReady = false;
const prebufferedChunks = [];

async function onChunkArrived(arrayBuffer) {
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  if (!prebufferReady) {
    prebufferedChunks.push(audioBuffer);
    prebufferDuration += audioBuffer.duration;
    if (prebufferDuration >= MIN_PREBUFFER_DURATION) {
      prebufferReady = true;
      overlayState('playing');  // transition UX out of "buffering"
      // Flush all prebuffered chunks into the scheduler
      for (const buf of prebufferedChunks) enqueueChunk(buf);
      prebufferedChunks.length = 0;
    }
  } else {
    enqueueChunk(audioBuffer);
  }
}
```

**Pitfall:** `decodeAudioData()` requires a *complete* audio container (MP3 frame, AAC ADTS header + payload, WAV header). If the TTS API streams raw PCM or partial containers, you must either (a) use an `AudioWorklet` with a ring buffer instead, or (b) ensure each chunk from the API is a self-contained audio file (e.g., one full MP3/AAC chunk per API response event).

**Source:** [Deepgram — Audio Output Streaming](https://developers.deepgram.com/docs/streaming-the-audio-output); [ElevenLabs — Real-time TTS](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts); [ElevenLabs blog — latency in TTS pipelines](https://elevenlabs.io/blog/enhancing-conversational-ai-latency-with-efficient-tts-pipelines)

---

### 3.4 AudioWorklet Ring Buffer for Raw PCM Streaming

**What it is:** If the TTS source delivers raw PCM (not a container format), `decodeAudioData()` cannot be used. Instead, an `AudioWorkletProcessor` reads from a shared ring buffer that the main thread writes PCM chunks into as they arrive.

**When to apply:** When using a raw-PCM streaming TTS provider (e.g., MiniMax STT→TTS chain that returns 16-bit PCM). For MP3/Opus/AAC chunks, prefer the simpler `decodeAudioData` + `AudioBufferSourceNode` approach (§3.2).

**Sketch:**
```js
// In worklet processor (separate file):
class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ring = new Float32Array(48000 * 2); // 2 s ring
    this._writePtr = 0; this._readPtr = 0;
    this.port.onmessage = ({ data }) => this._write(data);
  }
  _write(pcmFloat32) {
    for (const s of pcmFloat32) {
      this._ring[this._writePtr++ % this._ring.length] = s;
    }
  }
  process(_, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      out[i] = this._readPtr < this._writePtr
        ? this._ring[this._readPtr++ % this._ring.length]
        : 0;
    }
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayerProcessor);

// In main/content thread:
await audioCtx.audioWorklet.addModule('pcm-player-processor.js');
const node = new AudioWorkletNode(audioCtx, 'pcm-player');
node.connect(audioCtx.destination);
// For each PCM chunk from the server:
node.port.postMessage(float32PcmChunk, [float32PcmChunk.buffer]);
```

**Pitfall:** Chrome extensions cannot load worklet modules from `chrome-extension://` URLs in content scripts unless the file is listed in `web_accessible_resources`. Alternatively, use a Blob URL or inline base64.

**Source:** [Chrome Developers — Audio Worklet Design Pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern/); [MDN — Using AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Using_AudioWorklet); [audio-worklet-stream library](https://github.com/ain1084/audio-worklet-stream)

---

## 4. A/V Resync on Pause and Resume

### 4.1 Video "waiting" / "playing" Event Gating Pattern [HIGH]

**What it is:** The HTML5 `<video>` element fires `waiting` when it runs out of buffered data. Mirror this into the dubbed audio: when the video stalls, pause/hold the dub audio; when the video resumes (`playing` event), re-anchor and resume.

**When to apply:** Standard (TTS) tier only. Also handle manual pause/resume via the `pause` and `play` events.

**Implementation sketch:**
```js
videoEl.addEventListener('waiting', () => holdDub());
videoEl.addEventListener('playing', () => resumeDub());
videoEl.addEventListener('pause', () => holdDub());
videoEl.addEventListener('play', () => resumeDub());

function holdDub() {
  // Suspend the AudioContext (freezes currentTime progression)
  audioCtx.suspend();
  // Record video time at hold point
  dubState.holdVideoTime = videoEl.currentTime;
  dubState.holdAudioTime = audioCtx.currentTime;
}

function resumeDub() {
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(() => {
      // Drift check: if video jumped ahead during the hold, skip forward
      const videoDelta = videoEl.currentTime - dubState.holdVideoTime;
      if (videoDelta > 0.25) {  // 250 ms tolerance
        skipDubAheadBy(videoDelta);
      }
    });
  }
}
```

**readyState gate (alternative):** Check `videoEl.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA` (value 3) before resuming dub audio. `HAVE_FUTURE_DATA` means at least one future frame is buffered, safe to play.

```js
function resumeDubWhenReady() {
  if (videoEl.readyState >= 3) {
    resumeDub();
  } else {
    videoEl.addEventListener('canplay', resumeDub, { once: true });
  }
}
```

**Source:** [W3Schools — waiting event](https://www.w3schools.com/tags/av_event_waiting.asp); [MDN — Media buffering and time ranges](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Audio_and_video_delivery/buffering_seeking_time_ranges); [HTML spec — video element](https://html.spec.whatwg.org/multipage/media.html)

---

### 4.2 AudioContext Suspend/Resume as the Pause Mechanism [HIGH]

**What it is:** `audioCtx.suspend()` freezes the audio clock. `audioCtx.resume()` restarts it from where it stopped. This is the correct primitive for pausing Web Audio playback — *not* stopping and recreating source nodes.

**Critical fact:** `AudioContext.currentTime` is NOT a transport position. It is a monotonically increasing clock from context creation. You cannot seek it. When suspended, it stops advancing. On resume, it continues from where it stopped — perfectly preserving already-scheduled future events.

**Clock tracking on pause/resume:**
```js
let audioOffsetAtLastPause = 0;  // cumulative audio played
let audioStartTime = null;        // audioCtx.currentTime when audio started

function pauseAudio() {
  audioOffsetAtLastPause += audioCtx.currentTime - (audioStartTime ?? audioCtx.currentTime);
  audioCtx.suspend();
}

function resumeAudio(videoCurrentTime) {
  // Re-anchor: compute expected audio position from video
  // If video jumped (seek), we must re-queue chunks from videoCurrentTime
  audioCtx.resume();
  audioStartTime = audioCtx.currentTime;
}
```

**Pitfall:** If `audioCtx.suspend()` is called and there are already-scheduled `AudioBufferSourceNode.start()` calls in the future, those nodes will execute as expected once the context resumes. But if the video *seeks* (not just pauses), the old scheduled nodes are at wrong times — they must be cancelled and the chunk queue rebuilt from the new `videoEl.currentTime`.

**Source:** [MDN — AudioContext.resume()](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume); [Hans Garon — Enabling Pause and Resume of Synchronized Audio](https://hansgaron.com/articles/web_audio/enabling_pause_and_resume/); [Web Audio API spec — issue #460](https://github.com/WebAudio/web-audio-api/issues/460)

---

### 4.3 Soft Pause via playbackRate Ramp (Video Holds for Dub)

**What it is:** Instead of a hard `videoEl.pause()`, ramp `videoEl.playbackRate` down to 0 over ~200 ms. This avoids a jarring visual freeze and gives the dubbed audio buffer time to build up before resuming at rate=1.

**When to apply:** On RESUME, if the dub audio buffer is not yet ready (below prebuffer threshold). Hold the video gently rather than abruptly.

**Implementation sketch:**
```js
function softHoldVideo() {
  const startRate = videoEl.playbackRate;
  const rampMs = 200;
  const startTime = performance.now();
  function step() {
    const t = Math.min((performance.now() - startTime) / rampMs, 1);
    videoEl.playbackRate = startRate * (1 - t);
    if (t < 1) requestAnimationFrame(step);
    else videoEl.playbackRate = 0;  // full stop after ramp
  }
  requestAnimationFrame(step);
}

function softReleaseVideo() {
  const targetRate = 1.0;
  const rampMs = 150;
  const startTime = performance.now();
  function step() {
    const t = Math.min((performance.now() - startTime) / rampMs, 1);
    videoEl.playbackRate = targetRate * t;
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
```

**Pitfall:** Some browsers (Firefox, historically) reset `playbackRate` to `defaultPlaybackRate` on `pause`/`play` cycles. Set `videoEl.defaultPlaybackRate = 1.0` explicitly and never let your code touch `defaultPlaybackRate` outside of intentional speed changes.

**Source:** [Firefox bug #1013933 — pause/resume resets speed](https://bugzilla.mozilla.org/show_bug.cgi?id=1013933); [Apple — Controlling Media with JavaScript](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/ControllingMediaWithJavaScript/ControllingMediaWithJavaScript.html)

---

### 4.4 Drift Correction via Video Clock Re-anchoring

**What it is:** Over long sessions, `audioCtx.currentTime` and `videoEl.currentTime` drift apart due to clock rate differences (audio is sample-rate driven; video is frame-rate driven). Periodically compute the drift and correct it.

**When to apply:** Every 5–10 seconds in a running session, or immediately after every resume.

**Implementation sketch:**
```js
// On each scheduleChunks() tick, compute the drift
function getDrift() {
  const expectedAudioTime = videoEl.currentTime - SESSION_START_VIDEO_TIME;
  const actualAudioTime   = audioCtx.currentTime - SESSION_START_AUDIO_TIME;
  return actualAudioTime - expectedAudioTime; // positive = audio ahead
}

const DRIFT_THRESHOLD = 0.05; // 50 ms

function correctDrift() {
  const drift = getDrift();
  if (Math.abs(drift) > DRIFT_THRESHOLD) {
    if (drift > 0) {
      // Audio is ahead: pause the dub scheduler briefly
      nextStartTime += drift;
    } else {
      // Audio is behind: skip the next chunk's silence gap
      // or clamp nextStartTime to current audio clock
      nextStartTime = audioCtx.currentTime;
    }
  }
}
```

**Source:** [web.dev — A Tale of Two Clocks](https://web.dev/articles/audio-scheduling); [Hans Garon — Pause and Resume sync](https://hansgaron.com/articles/web_audio/enabling_pause_and_resume/)

---

## 5. AudioContext Unlock and Autoplay Policy

### 5.1 AudioContext Autoplay Policy in Chrome [HIGH]

**What it is:** Chrome requires a user gesture (click, keydown, touch) before an `AudioContext` can enter `running` state. If created before a gesture, it starts `suspended`. Extensions benefit from relaxed rules: clicking the Start button counts as a user gesture in the page's context.

**Correct unlock pattern:**
```js
let audioCtx = null;

// Create ON the user click, not on load — avoids suspended state entirely
function getOrCreateAudioCtx() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    // If still suspended (some browsers): resume() inside the same click handler
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }
  return audioCtx;
}

startBtn.addEventListener('click', () => {
  const ctx = getOrCreateAudioCtx();
  // Proceed immediately — ctx.state will be 'running' after the above
});
```

**Alternative unlock (if AudioContext must be created at load time):**
```js
document.addEventListener('click', () => {
  if (audioCtx?.state === 'suspended') audioCtx.resume();
}, { once: true });
```

**Extension-specific note:** The Start button click in a content script IS a user gesture in Chrome. But if the AudioContext is created in the background service worker or a separate messaging context (not the tab), it will not inherit the user gesture and may start suspended. Always create the AudioContext in the content script, tied to the click handler.

**Source:** [Chrome Developers — Autoplay Policy](https://developer.chrome.com/blog/autoplay); [Chrome Developers — Web Audio Autoplay](https://developer.chrome.com/blog/web-audio-autoplay); [MDN — AudioContext.resume()](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume)

---

## 6. Branded Loading / Buffering UX

### 6.1 Shimmer / Skeleton for the Overlay Wait State

**What it is:** A CSS gradient animation that simulates content loading. Skeleton screens reduce perceived wait by ~20% compared to plain spinners for identical wait durations.

**When to apply:** During the startup sequence (connecting → first chunk buffering). Show a shimmer on placeholder wave bars or the dub overlay background.

**CSS (no framework, shadow-DOM safe):**
```css
/* Scoped to extension overlay class to avoid polluting host page */
.ec-loading-shimmer {
  background: linear-gradient(-45deg,
    rgba(255,255,255,0.06) 40%,
    rgba(255,255,255,0.18) 50%,
    rgba(255,255,255,0.06) 60%
  );
  background-size: 300% 100%;
  background-position-x: 100%;
  animation: ec-shimmer 1.4s infinite linear;
}

@keyframes ec-shimmer {
  to { background-position-x: 0%; }
}
```

**Shadow DOM isolation:** If the overlay uses `attachShadow({mode:'open'})`, put `@keyframes` inside the shadow root's `<style>` element — keyframes defined outside do not penetrate shadow boundaries.

**Source:** [Codeguage — Shimmer Effect HTML CSS](https://www.codeguage.com/blog/shimmer-effect-html-css); [Smashing Magazine — CSS Blurry Shimmer Effect](https://www.smashingmagazine.com/2024/01/css-blurry-shimmer-effect/)

---

### 6.2 Branded Logo Pulse Spinner [HIGH]

**What it is:** A single logo element (SVG or text) that pulses via `opacity` and `transform: scale()`. Runs on the compositor thread — zero main-thread cost. Suitable for injection into any host page.

**CSS:**
```css
.ec-spinner {
  animation: ec-pulse 1.2s ease-in-out infinite;
  transform-origin: center;
}

@keyframes ec-pulse {
  0%, 100% { opacity: 1;   transform: scale(1.0); }
  50%       { opacity: 0.4; transform: scale(0.88); }
}
```

**Glow ring variant (more branded):**
```css
.ec-spinner-ring {
  width: 36px; height: 36px;
  border-radius: 50%;
  border: 3px solid transparent;
  border-top-color: #f60;   /* brand orange */
  animation: ec-spin 0.9s linear infinite;
}

@keyframes ec-spin {
  to { transform: rotate(360deg); }
}
```

**Micro-interaction tip:** When the loading resolves, transition the spinner out with a brief `scale(1.2)` → `scale(0)` (200 ms ease-in) and fade in the playing state. This gives a satisfying "pop" that signals completion.

**Source:** [CSS Script — Best Loading Spinner Libraries](https://www.cssscript.com/best-loading-spinner-indicator-libraries/); [CSS Loaders Collection](https://css-loaders.com/spinner/); [DEV Community — pure CSS spinner](https://dev.to/peboy/creating-an-animated-pure-css-loading-spinner)

---

### 6.3 Phase-Labelled Progress (No Bar Needed)

**What it is:** Text that changes as real milestones pass. More honest than a fake progress bar, and still reduces perceived wait significantly.

**Pattern:**
```js
const PHASE_LABELS = {
  connecting:   'Connecting…',
  ice_done:     'Securing channel…',
  first_chunk:  'First dub arriving…',
  prebuffered:  'Warming up audio…',
  playing:      '',   // hide overlay entirely
};

function setPhase(phase) {
  overlay.querySelector('.ec-phase-label').textContent = PHASE_LABELS[phase];
  if (phase === 'playing') overlay.classList.add('ec-overlay--hidden');
}
```

**Source:** [Designing for the Doherty Threshold — LogRocket](https://blog.logrocket.com/ux-design/designing-instant-feedback-doherty-threshold/)

---

## 7. Summary Priority Matrix

Rank by estimated impact on the four specific complaints:

| Technique | Complaint | Effort | Impact |
|---|---|---|---|
| Trickle ICE with candidate buffering | Startup latency (Realtime) | Medium | Very High |
| ICE Candidate Pool pre-warm | Startup latency (Realtime) | Low | High |
| Ephemeral token prefetch on hover | Startup latency (Realtime) | Low | High |
| `decodeAudioData` + `nextStartTime` chaining | Smoothness (Standard) | Medium | Very High |
| Priming silence detection (`findStartGapDuration`) | Smoothness (Standard) | Low | High |
| Adaptive prebuffer (120ms) before first play | Startup latency (Standard) | Low | High |
| AudioContext created in click handler | Startup latency (all) | Low | High |
| `waiting`/`playing` event gating | A/V desync on resume | Low | Very High |
| `audioCtx.suspend()`/`resume()` on pause/play | A/V desync on resume | Low | Very High |
| Drift correction every 5 s | Smoothness (long sessions) | Medium | Medium |
| Soft playbackRate ramp on hold | A/V desync on resume | Low | Medium |
| Branded pulse spinner + phase labels | Loading UX | Low | High |
| Shimmer on overlay background | Loading UX | Low | Medium |
| Optimistic UI (show overlay before network) | Perceived startup | Low | High |
| Speculative preconnect on hover | Startup latency | Low | Medium |
| AudioWorklet ring buffer (PCM path only) | Smoothness (PCM TTS) | High | High |

---

## Sources

- [web.dev — A Tale of Two Clocks](https://web.dev/articles/audio-scheduling)
- [ircam-ismm — Timing and Scheduling tutorial](https://ircam-ismm.github.io/webaudio-tutorials/scheduling/timing-and-scheduling.html)
- [JakeArchibald.com — Sounds Fun (gapless playback)](https://jakearchibald.com/2016/sounds-fun/)
- [OpenAI Realtime WebRTC docs](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [webrtcHacks — How OpenAI does WebRTC](https://webrtchacks.com/how-openai-does-webrtc-in-the-new-gpt-realtime/)
- [SheerBit — OpenAI Realtime over WebRTC](https://sheerbit.com/getting-started-with-openai-realtime-over-webrtc-architecture-signaling-and-first-audio-call/)
- [OpenAI — Delivering Low-Latency Voice AI at Scale](https://openai.com/index/delivering-low-latency-voice-ai-at-scale/)
- [GetStream — ICE Candidate Tutorial](https://getstream.io/resources/projects/webrtc/basics/ice-candidates/)
- [webrtcHacks — Trickle ICE](https://webrtchacks.com/trickle-ice/)
- [webrtc.org — Getting started with peer connections](https://webrtc.org/getting-started/peer-connections)
- [MDN — RTCPeerConnection constructor (iceCandidatePoolSize)](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection)
- [Chromium — ICE candidate pooling intent to ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/dWXRWoi5ueg/m/nFiVhj5LCAAJ)
- [webrtc-developers.com — Anatomy of a WebRTC Connection](https://www.webrtc-developers.com/anatomy-of-a-webrtc-connection/)
- [VideoSDK — WebRTC Low Latency 2025](https://www.videosdk.live/developer-hub/webrtc/webrtc-low-latency)
- [MDN — Speculative loading](https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Speculative_loading)
- [web.dev — Resource hints](https://web.dev/learn/performance/resource-hints)
- [MDN — AudioContext.resume()](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume)
- [MDN — AudioContext.suspend()](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/suspend)
- [Hans Garon — Pause and Resume of Synchronized Audio](https://hansgaron.com/articles/web_audio/enabling_pause_and_resume/)
- [Web Audio API spec — issue #460 (currentTime during suspend)](https://github.com/WebAudio/web-audio-api/issues/460)
- [MDN — Media buffering and time ranges](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Audio_and_video_delivery/buffering_seeking_time_ranges)
- [W3Schools — waiting event](https://www.w3schools.com/tags/av_event_waiting.asp)
- [HTML spec — video element](https://html.spec.whatwg.org/multipage/media.html)
- [Chrome Developers — Autoplay Policy](https://developer.chrome.com/blog/autoplay)
- [Chrome Developers — Web Audio Autoplay](https://developer.chrome.com/blog/web-audio-autoplay)
- [Chrome Developers — Audio Worklet Design Pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern/)
- [MDN — Using AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Using_AudioWorklet)
- [audio-worklet-stream library](https://github.com/ain1084/audio-worklet-stream)
- [GitHub — fetch-stream-audio (AnthumChris)](https://github.com/AnthumChris/fetch-stream-audio)
- [web-audio-buffer-queue library](https://github.com/Johni0702/web-audio-buffer-queue)
- [Deepgram — Audio Output Streaming](https://developers.deepgram.com/docs/streaming-the-audio-output)
- [ElevenLabs — Real-time TTS WebSockets](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts)
- [ElevenLabs blog — latency in TTS pipelines](https://elevenlabs.io/blog/enhancing-conversational-ai-latency-with-efficient-tts-pipelines)
- [Shaka Player — buffer config tutorial](https://shaka-player-demo.appspot.com/docs/api/tutorial-network-and-buffering-config.html)
- [Codeguage — Shimmer Effect HTML CSS](https://www.codeguage.com/blog/shimmer-effect-html-css)
- [Smashing Magazine — CSS Blurry Shimmer Effect](https://www.smashingmagazine.com/2024/01/css-blurry-shimmer-effect/)
- [LogRocket — skeleton loading screen design](https://blog.logrocket.com/ux-design/skeleton-loading-screen-design/)
- [LogRocket — Doherty Threshold in UX](https://blog.logrocket.com/ux-design/designing-instant-feedback-doherty-threshold/)
- [Remix — Pending and Optimistic UI](https://v2.remix.run/docs/discussion/pending-ui/)
- [SitePoint — skeleton screens UX](https://www.sitepoint.com/how-to-speed-up-your-ux-with-skeleton-screens/)
- [Firefox bug #1013933 — pause/resume resets playbackRate](https://bugzilla.mozilla.org/show_bug.cgi?id=1013933)
- [Apple — Controlling Media with JavaScript](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/ControllingMediaWithJavaScript/ControllingMediaWithJavaScript.html)
- [MDN — Autoplay guide for media and Web Audio APIs](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
- [WAAClock — scheduling library](https://github.com/sebpiq/WAAClock)
- [CSS Loaders Collection](https://css-loaders.com/spinner/)
