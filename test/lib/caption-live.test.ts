import { describe, expect, it } from "vitest";
import { applyLiveTranslationDelta } from "@/lib/caption-live";

describe("applyLiveTranslationDelta", () => {
  it("appends deltas verbatim (no injected spaces between letters)", () => {
    let s = { text: "M", utteranceOpen: true };
    s = applyLiveTranslationDelta(s, "ã", false);
    expect(s.text).toBe("Mã");
    s = applyLiveTranslationDelta(s, " hóa", false);
    expect(s.text).toBe("Mã hóa");
  });

  it("replaces with cumulative snapshots", () => {
    let s = { text: "Bạn", utteranceOpen: true };
    s = applyLiveTranslationDelta(s, "Bạn có thể", false);
    expect(s.text).toBe("Bạn có thể");
  });

  it("starts a fresh line after final", () => {
    let s = { text: "Câu một.", utteranceOpen: true };
    s = applyLiveTranslationDelta(s, "Câu một.", true);
    expect(s.utteranceOpen).toBe(false);
    s = applyLiveTranslationDelta(s, "Câu hai", false);
    expect(s.text).toBe("Câu hai");
  });

  it("replaces caption on new segment when utterance was closed (Standard per-clause)", () => {
    let s = { text: "First clause dub.", utteranceOpen: false };
    s = applyLiveTranslationDelta(s, "Second clause dub.", false);
    expect(s.text).toBe("Second clause dub.");
    expect(s.utteranceOpen).toBe(true);
  });
});
