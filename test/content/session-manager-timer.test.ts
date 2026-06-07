// @vitest-environment jsdom
//
// SessionManager 55/60-min warn+limit timer — pause/resume correctness.
//
// Regression (Issue #6): the connection-lost recovery path (pause-controller)
// calls resumeSessionTimer() WITHOUT a prior pauseSessionTimer(), so _pausedAt === 0.
// Without a guard, `Date.now() - _pausedAt` extends the auto-stop deadline by the
// full epoch (~55,000 years), effectively disabling the 60-min auto-stop. The fix
// is an early-return when _pausedAt === 0 (no pause ⇒ nothing to resume).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager } from "@/content/session-manager";
import { SESSION_LIMIT_MS, SESSION_WARNING_MS } from "@/shared/constants";

describe("SessionManager.resumeSessionTimer — _pausedAt=0 guard (Issue #6)", () => {
  let sm: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    sm = new SessionManager();
  });
  afterEach(() => {
    sm.clearSessionTimer();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resumeSessionTimer() with NO prior pause (pausedAt=0) does NOT extend the auto-stop deadline", () => {
    const onLimit = vi.fn();
    sm.startSessionTimer(vi.fn(), onLimit);

    // Connection-lost recovery resumes WITHOUT pausing first → _pausedAt is still 0.
    sm.resumeSessionTimer();

    // Just before the original 60-min limit: must NOT have been pushed out.
    vi.advanceTimersByTime(SESSION_LIMIT_MS - 1);
    expect(onLimit).not.toHaveBeenCalled();
    // At the original limit: fires exactly on schedule (deadline untouched).
    vi.advanceTimersByTime(1);
    expect(onLimit).toHaveBeenCalledTimes(1);
  });

  it("a real pause→resume still shifts the deadline forward by the paused duration", () => {
    const onLimit = vi.fn();
    sm.startSessionTimer(vi.fn(), onLimit);

    // Run 10 min, pause for 5 min, resume.
    vi.advanceTimersByTime(10 * 60 * 1000);
    sm.pauseSessionTimer();
    vi.advanceTimersByTime(5 * 60 * 1000);
    sm.resumeSessionTimer();

    // The deadline shifted forward by the 5-min pause: at the ORIGINAL 60-min mark
    // it must NOT have fired yet (5 min of slack remain).
    vi.advanceTimersByTime(SESSION_LIMIT_MS - 10 * 60 * 1000 - 1);
    expect(onLimit).not.toHaveBeenCalled();
    // After the remaining 5 min (the paused slack), it fires.
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(onLimit).toHaveBeenCalledTimes(1);
  });

  it("the 55-min warning is also unaffected by a pausedAt=0 resume", () => {
    const onWarning = vi.fn();
    sm.startSessionTimer(onWarning, vi.fn());
    sm.resumeSessionTimer(); // pausedAt=0 → no-op

    vi.advanceTimersByTime(SESSION_WARNING_MS - 1);
    expect(onWarning).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onWarning).toHaveBeenCalledTimes(1);
  });
});
