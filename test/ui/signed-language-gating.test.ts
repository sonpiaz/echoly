import { describe, expect, it } from "vitest";
import { langPickerFromPairs, applySignedLanguageGate } from "@/lib/language-picker";

describe("langPickerFromPairs", () => {
  it("dedupes targets and sorts by display name", () => {
    const picker = langPickerFromPairs(
      [
        { source: "en", target: "vi" },
        { source: "en", target: "ja" },
        { source: "vi", target: "en" },
      ],
      { en: "English", vi: "Vietnamese", ja: "Japanese" },
    );
    expect(picker.map(([c]) => c)).toEqual(["en", "ja", "vi"]);
  });
});

describe("applySignedLanguageGate", () => {
  const picker = [
    ["vi", "Vietnamese"],
    ["ja", "Japanese"],
  ] as const;

  it("keeps current language when allowed", () => {
    const out = applySignedLanguageGate({ currentLang: "vi", picker });
    expect(out.effectiveLang).toBe("vi");
    expect(out.autoSwitched).toBe(false);
    expect(out.renderable).toHaveLength(2);
  });

  it("auto-switches to first allowed when current is locked out", () => {
    const out = applySignedLanguageGate({ currentLang: "es", picker });
    expect(out.effectiveLang).toBe("vi");
    expect(out.autoSwitched).toBe(true);
  });
});
