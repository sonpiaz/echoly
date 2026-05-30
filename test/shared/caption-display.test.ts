import { describe, expect, it } from "vitest";
import { captionDisplayFromSettings } from "@/shared/caption-display";

describe("captionDisplayFromSettings", () => {
  it("defaults target on-video to true when unset", () => {
    expect(captionDisplayFromSettings({})).toEqual({
      showTargetOnVideo: true,
      showSourceInPanel: false,
    });
  });

  it("respects explicit showTargetCaptions and showSource", () => {
    expect(
      captionDisplayFromSettings({
        showTargetCaptions: false,
        showSource: true,
      }),
    ).toEqual({
      showTargetOnVideo: false,
      showSourceInPanel: true,
    });
  });
});
