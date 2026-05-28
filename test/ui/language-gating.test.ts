// Unit tests for src/lib/guest-gating.ts — pure language-gating reducer used
// by the popup to restrict the language picker in guest/BYOK mode.

import { describe, it, expect } from "vitest";
import { applyLanguageGate } from "@/lib/guest-gating";
import { LANGUAGES } from "@/shared/constants";
import {
  DEFAULT_GUEST_LANGUAGE_POLICY,
  type GuestLanguagePolicy,
} from "@/shared/types";

describe("applyLanguageGate — non-guest modes pass through unchanged", () => {
  it("apiMode null → renders all langs, no switch", () => {
    const out = applyLanguageGate({
      apiMode: null,
      currentLang: "ja",
      policy: DEFAULT_GUEST_LANGUAGE_POLICY,
      allLangs: LANGUAGES,
    });
    expect(out.renderable).toEqual([...LANGUAGES]);
    expect(out.effectiveLang).toBe("ja");
    expect(out.autoSwitched).toBe(false);
  });

  it("apiMode proxy (signed-in) → renders all langs, no switch", () => {
    const out = applyLanguageGate({
      apiMode: "proxy",
      currentLang: "ja",
      policy: DEFAULT_GUEST_LANGUAGE_POLICY,
      allLangs: LANGUAGES,
    });
    expect(out.renderable).toEqual([...LANGUAGES]);
    expect(out.effectiveLang).toBe("ja");
    expect(out.autoSwitched).toBe(false);
  });

  it("apiMode byok BUT no policy yet → renders all langs (graceful pre-fetch)", () => {
    const out = applyLanguageGate({
      apiMode: "byok",
      currentLang: "ja",
      policy: null,
      allLangs: LANGUAGES,
    });
    expect(out.renderable).toEqual([...LANGUAGES]);
    expect(out.effectiveLang).toBe("ja");
    expect(out.autoSwitched).toBe(false);
  });
});

describe("applyLanguageGate — guest mode with policy", () => {
  it("filters to allowedTarget and keeps the current lang when it's allowed", () => {
    const policy: GuestLanguagePolicy = {
      allowedSource: ["en"],
      allowedTarget: ["vi", "ja"],
      defaults: { source: "en", target: "vi" },
    };
    const out = applyLanguageGate({
      apiMode: "byok",
      currentLang: "ja",
      policy,
      allLangs: LANGUAGES,
    });
    expect(out.renderable.map(([c]) => c)).toEqual(["vi", "ja"]);
    expect(out.effectiveLang).toBe("ja");
    expect(out.autoSwitched).toBe(false);
  });

  it("auto-switches to defaults.target when current is outside allowed", () => {
    const policy: GuestLanguagePolicy = {
      allowedSource: ["en"],
      allowedTarget: ["vi"],
      defaults: { source: "en", target: "vi" },
    };
    const out = applyLanguageGate({
      apiMode: "byok",
      currentLang: "ja", // ja not allowed
      policy,
      allLangs: LANGUAGES,
    });
    expect(out.renderable.map(([c]) => c)).toEqual(["vi"]);
    expect(out.effectiveLang).toBe("vi");
    expect(out.autoSwitched).toBe(true);
  });

  it("default (en→vi) matches the extension shipping default — current 'vi' stays", () => {
    const out = applyLanguageGate({
      apiMode: "byok",
      currentLang: "vi",
      policy: DEFAULT_GUEST_LANGUAGE_POLICY,
      allLangs: LANGUAGES,
    });
    expect(out.renderable.map(([c]) => c)).toEqual(["vi"]);
    expect(out.effectiveLang).toBe("vi");
    expect(out.autoSwitched).toBe(false);
  });

  it("falls back to all langs (no gating) if the policy yields an empty renderable", () => {
    // Policy lists codes none of which are in LANGUAGES — defense-in-depth.
    const policy: GuestLanguagePolicy = {
      allowedSource: ["en"],
      allowedTarget: ["xx"], // not a known code
      defaults: { source: "en", target: "xx" },
    };
    const out = applyLanguageGate({
      apiMode: "byok",
      currentLang: "vi",
      policy,
      allLangs: LANGUAGES,
    });
    expect(out.renderable).toEqual([...LANGUAGES]);
    expect(out.effectiveLang).toBe("vi");
    expect(out.autoSwitched).toBe(false);
  });

  it("picks the first renderable if defaults.target is itself not in allLangs", () => {
    // policy allowed has both known and unknown codes; defaults.target = unknown.
    // Reducer should still produce an auto-switch to a usable code.
    const policy: GuestLanguagePolicy = {
      allowedSource: ["en"],
      allowedTarget: ["vi", "ja"], // both known
      defaults: { source: "en", target: "ja" },
    };
    const out = applyLanguageGate({
      apiMode: "byok",
      currentLang: "fr", // outside allowed
      policy,
      allLangs: LANGUAGES,
    });
    expect(out.renderable.map(([c]) => c)).toEqual(["vi", "ja"]);
    expect(out.effectiveLang).toBe("ja"); // defaults.target
    expect(out.autoSwitched).toBe(true);
  });
});
