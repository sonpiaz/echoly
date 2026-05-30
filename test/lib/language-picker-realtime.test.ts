import { describe, expect, it } from "vitest";
import { filterPickerForRealtime } from "@/lib/language-picker";

describe("filterPickerForRealtime", () => {
  it("drops targets outside GPT Realtime coverage", () => {
    const picker: [string, string][] = [
      ["vi", "Vietnamese"],
      ["th", "Thai"],
      ["en", "English"],
    ];
    const out = filterPickerForRealtime(picker);
    expect(out.map(([c]) => c)).toEqual(["vi", "en"]);
  });
});
