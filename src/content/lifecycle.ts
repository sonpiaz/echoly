// LifecycleController — the single source of truth for "what the dub is doing"
// and the SOLE owner of video.pause()/video.play().
//
// SOLUTION §4. This replaces the scattered ~9 boolean flags and ≥6 direct
// video.pause()/play() call sites with ONE explicit 7-state machine + a
// reason-stack pause primitive. Every other module routes its pause/resume
// through here and subscribes to lifecycle events instead of poking flags.
//
// Framework-free; the only DOM assumption is the single <video> element it owns
// (settable — the video swaps on auto-next). No imports beyond the runtime.

/** The 7 lifecycle states. `stopped` is terminal. */
export type LifecycleState =
  | "idle"
  | "starting"
  | "dubbing"
  | "paused"
  | "switching"
  | "stopping"
  | "stopped";

/**
 * Reasons a pause can be held for. The video stays paused while ANY reason is on
 * the stack; it resumes only when the LAST reason is popped.
 *   • user            — the user pressed pause on the source <video>.
 *   • ad              — an ad is playing (Stage C AdWatcher).
 *   • system-buffer   — the dub driver is waiting for a cue's buffer / start-gate.
 *   • switching       — auto-next is rebuilding on a new video.
 *   • connection-lost — a WebRTC peer died during a pause.
 */
export type PauseReason =
  | "user"
  | "ad"
  | "system-buffer"
  | "switching"
  | "connection-lost";

export interface LifecycleEvents {
  /** Emitted on every successful transition with the new state. */
  enter: LifecycleState;
  /** Emitted whenever the effectivePaused value changes (user/ad add/remove). */
  pauseChanged: boolean;
  /** Emitted once when the controller reaches `stopped`. */
  stop: void;
}

type Listener<K extends keyof LifecycleEvents> = (payload: LifecycleEvents[K]) => void;

/** Build-time dev flag (Vite/WXT statically replaces `import.meta.env.DEV` with a
 *  literal). True in `wxt dev` + vitest, false in the store build — so illegal
 *  transitions throw loudly in dev/tests and no-op in prod. */
function isDev(): boolean {
  try {
    return import.meta.env.DEV === true;
  } catch {
    return false;
  }
}

/**
 * Legal transition table. Keys are the FROM state; values are the set of states
 * that may be entered next. `stopping`/`stopped` are reachable from every
 * non-terminal state. `stopped` is terminal (no outgoing edges).
 */
const LEGAL_EDGES: Record<LifecycleState, ReadonlySet<LifecycleState>> = {
  idle: new Set<LifecycleState>(["starting", "stopping", "stopped"]),
  starting: new Set<LifecycleState>(["dubbing", "stopping", "stopped"]),
  dubbing: new Set<LifecycleState>(["paused", "switching", "stopping", "stopped"]),
  // `switching` is reachable from `paused` too: auto-next can fire after a user
  // pause (user paused, then YouTube autoplays the next video → paused → switching
  // → starting → dubbing). Without this edge that transition silently no-ops (prod)
  // / throws (dev) and the controller gets stuck.
  paused: new Set<LifecycleState>(["dubbing", "switching", "stopping", "stopped"]),
  switching: new Set<LifecycleState>(["starting", "stopping", "stopped"]),
  stopping: new Set<LifecycleState>(["stopped"]),
  stopped: new Set<LifecycleState>([]),
};

export class LifecycleController {
  #state: LifecycleState = "idle";

  /** The <video> this controller owns. Swapped on auto-next / restart. */
  #video: HTMLVideoElement | null = null;

  /**
   * Ordered set of active pause reasons. Insertion order is preserved (Set);
   * the video is paused iff this is non-empty. A reason is idempotent — pushing
   * an already-present reason is a no-op (no double video.pause()).
   */
  #reasons = new Set<PauseReason>();

  /**
   * Synchronous guard set TRUE immediately before any controller-issued
   * video.pause()/play() and cleared the moment the call returns. The bound
   * onPause/onPlay DOM handlers check isSelfIssued() and no-op on our own events
   * (replaces the per-session `_systemPaused` onPause guard).
   */
  #selfIssued = false;

  /** Monotonic supersession counter. Async work captures it and bails when it
   *  no longer matches (collapses pageToken + auto-next activeGen + nav #emitting). */
  #epoch = 0;

  #listeners: { [K in keyof LifecycleEvents]: Set<Listener<K>> } = {
    enter: new Set(),
    pauseChanged: new Set(),
    stop: new Set(),
  };

  // ── State ────────────────────────────────────────────────────────────────

  get state(): LifecycleState {
    return this.#state;
  }

  /**
   * The only state mutator. Validates the FROM→TO edge against LEGAL_EDGES.
   * Illegal edges throw in dev / are a silent no-op in prod. A no-op same-state
   * transition is ignored (does not re-emit). Emits `enter` (and `stop` when the
   * destination is `stopped`).
   */
  transition(to: LifecycleState): void {
    const from = this.#state;
    if (from === to) return;
    if (!LEGAL_EDGES[from].has(to)) {
      const msg = `[lifecycle] illegal transition ${from} → ${to}`;
      if (isDev()) throw new Error(msg);
      // prod: swallow — never crash the content script on a state-machine slip.
      return;
    }
    this.#state = to;
    this.#emit("enter", to);
    if (to === "stopped") this.#emit("stop", undefined);
  }

  /**
   * Reset the controller for a brand-new session. The previous session's terminal
   * teardown parks the controller in `stopped` (a terminal state with no outgoing
   * edges), so the next session would be unable to transition out of it. This puts
   * the machine back to `idle`, clears any lingering pause reasons, and bumps the
   * epoch so any still-in-flight async work from the prior session supersedes
   * itself. Called at the top of startSession so each session starts clean.
   *
   * This is the ONLY sanctioned way to leave a terminal state — it bypasses the
   * LEGAL_EDGES table by design (a fresh session, not a transition). Does NOT
   * re-emit `enter`/`stop` (the prior session already emitted its `stop`).
   */
  resetForNewSession(): void {
    this.#state = "idle";
    const wasPaused = this.effectivePaused;
    this.#reasons.clear();
    if (wasPaused) this.#emit("pauseChanged", false);
    this.#epoch++;
  }

  // ── Video element ownership ───────────────────────────────────────────────

  /** Swap the owned <video> (auto-next / restart). Does NOT touch the reason
   *  stack — pause state carries across a video swap by design. */
  setVideo(video: HTMLVideoElement | null): void {
    this.#video = video;
  }

  get video(): HTMLVideoElement | null {
    return this.#video;
  }

  // ── Reason-stack pause / resume (the load-bearing primitive) ──────────────

  /**
   * Push `reason`. If the stack WAS empty, issue the controller's video.pause()
   * (guarded by #selfIssued so onPause no-ops). Idempotent per reason. Safe with
   * no video bound (state-only). Emits `pauseChanged` if effectivePaused flipped.
   */
  pause(reason: PauseReason): void {
    if (this.#reasons.has(reason)) return;
    const wasEmpty = this.#reasons.size === 0;
    const effBefore = this.effectivePaused;
    this.#reasons.add(reason);
    if (wasEmpty) this.#pauseVideo();
    if (this.effectivePaused !== effBefore) this.#emit("pauseChanged", this.effectivePaused);
  }

  /**
   * Pop `reason`. If the stack BECOMES empty, issue the controller's
   * video.play() (guarded by #selfIssued) and return its promise so callers can
   * await it (dub-start lock-step, Stage D). Idempotent per reason. Returns a
   * resolved promise when nothing actually un-paused. Emits `pauseChanged` if
   * effectivePaused flipped.
   */
  resume(reason: PauseReason): Promise<void> {
    if (!this.#reasons.has(reason)) return Promise.resolve();
    const effBefore = this.effectivePaused;
    this.#reasons.delete(reason);
    let p: Promise<void> = Promise.resolve();
    if (this.#reasons.size === 0) p = this.#playVideo();
    if (this.effectivePaused !== effBefore) this.#emit("pauseChanged", this.effectivePaused);
    return p;
  }

  /** True while the given reason is on the stack. */
  isPausedFor(reason: PauseReason): boolean {
    return this.#reasons.has(reason);
  }

  /**
   * Drop a SINGLE reason WITHOUT issuing a video.play(). Used when the caller is
   * about to take over playback itself (auto-next/switching rebuilds + plays the
   * NEW video, so the controller must not also play the OLD one). Use `resume()`
   * — not this — for a real user/ad resume that should un-pause the video. Emits
   * `pauseChanged` if effectivePaused flipped.
   */
  dropReason(reason: PauseReason): void {
    if (!this.#reasons.has(reason)) return;
    const effBefore = this.effectivePaused;
    this.#reasons.delete(reason);
    if (this.effectivePaused !== effBefore) this.#emit("pauseChanged", this.effectivePaused);
  }

  /** Drop every reason WITHOUT issuing a video.play() (terminal teardown only —
   *  stopSession owns the video from here, the controller must not fight it). */
  clearReasons(): void {
    const effBefore = this.effectivePaused;
    this.#reasons.clear();
    if (this.effectivePaused !== effBefore) this.#emit("pauseChanged", this.effectivePaused);
  }

  /**
   * The single truth for "is the dub paused as far as the user/billing is
   * concerned". Excludes transient system-buffer / switching / connection-lost —
   * those freeze playback but are NOT a user-visible pause and must NOT freeze
   * heartbeat billing.
   */
  get effectivePaused(): boolean {
    return this.#reasons.has("user") || this.#reasons.has("ad");
  }

  // ── Self-issued guard ─────────────────────────────────────────────────────

  /** True while a controller-issued video.pause()/play() is in flight. The bound
   *  onPause/onPlay handlers check this and no-op on our own events. */
  isSelfIssued(): boolean {
    return this.#selfIssued;
  }

  // ── Epoch (supersession) ──────────────────────────────────────────────────

  get epoch(): number {
    return this.#epoch;
  }

  /** Bump the epoch so any in-flight async work supersedes itself. */
  bumpEpoch(): number {
    return ++this.#epoch;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  on<K extends keyof LifecycleEvents>(event: K, fn: Listener<K>): () => void {
    this.#listeners[event].add(fn);
    return () => this.#listeners[event].delete(fn);
  }

  off<K extends keyof LifecycleEvents>(event: K, fn: Listener<K>): void {
    this.#listeners[event].delete(fn);
  }

  #emit<K extends keyof LifecycleEvents>(event: K, payload: LifecycleEvents[K]): void {
    for (const fn of this.#listeners[event]) {
      try {
        fn(payload);
      } catch {
        /* a subscriber error must not break the lifecycle */
      }
    }
  }

  // ── Private video ops (the ONLY place video.pause()/play() is called) ─────

  // The "pause"/"play" DOM events are dispatched on the media element's task
  // queue — a macrotask AFTER the synchronous .pause()/.play() call returns. So
  // the onPause/onPlay handler reads isSelfIssued() in that later task. We set
  // the flag synchronously before the call and clear it on the next macrotask
  // (setTimeout 0), which runs after the event task has been processed. This is
  // the faithful generalization of the legacy synchronous-flag-before-pause
  // invariant. A nested set→set is fine (latest clear wins) — re-entrant
  // controller ops are not a real scenario.
  #scheduleSelfIssuedClear(): void {
    setTimeout(() => {
      this.#selfIssued = false;
    }, 0);
  }

  #pauseVideo(): void {
    const v = this.#video;
    if (!v) return;
    this.#selfIssued = true;
    try {
      v.pause();
    } catch {
      /* ignore */
    }
    this.#scheduleSelfIssuedClear();
  }

  #playVideo(): Promise<void> {
    const v = this.#video;
    if (!v) return Promise.resolve();
    this.#selfIssued = true;
    let promise: Promise<void>;
    try {
      // video.play() returns a promise; some impls/mocks return void.
      const r = v.play() as unknown as Promise<void> | undefined;
      promise = r && typeof r.then === "function" ? r : Promise.resolve();
    } catch (err) {
      promise = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    this.#scheduleSelfIssuedClear();
    // Return the RAW play() promise (may REJECT on autoplay-block) so lock-step
    // callers (Stage D) and the VOD release sites can detect rejection and show
    // the press-play toast. Fire-and-forget callers must .catch() themselves.
    return promise;
  }
}
