import { describe, expect, test } from "bun:test";
import type { DeviceDisplays, VideoRecordingDisplayTransition } from "../../../src/models";
import { androidPanelTransitionWarnings } from "../../../src/features/video/AndroidPanelTransitionWarnings";
import { recordingDisplayWarnings } from "../../../src/features/video/IosRecordingDisplay";

// Pixel 9 Pro Fold sweep fixture from #17753.
const COVER = { key: "4619827551948147201", role: "cover" } as const;
const INNER = { key: "4619827259835644672", role: "inner" } as const;
const displays: DeviceDisplays = {
  panels: [
    { ...INNER, sizePx: { width: 2076, height: 2152 } },
    { ...COVER, sizePx: { width: 1080, height: 2424 } },
  ],
  postures: ["opened", "closed"],
};
const foldSweep: VideoRecordingDisplayTransition[] = [
  { atMs: 4837, from: COVER, to: INNER },
  { atMs: 10183, from: INNER, to: COVER },
];

describe("androidPanelTransitionWarnings", () => {
  test("a fold to a different-size panel warns once with the cropped span and remedy", () => {
    expect(androidPanelTransitionWarnings(displays, COVER, foldSweep)).toEqual([
      `Android recording kept capturing panel "${COVER.key}" (cover, 1080x2424) after the active display changed to panel "${INNER.key}" (inner, 2076x2152) at 4837ms; frames from 4837ms to 10183ms are cropped or letterboxed to the recorded 1080x2424 size. Stop the recording before setPosture or a fold and start a new one after it to capture the new panel at its full size.`,
    ]);
  });

  test("a final transition away names an open-ended span", () => {
    const [warning] = androidPanelTransitionWarnings(displays, COVER, foldSweep.slice(0, 1));
    expect(warning).toContain("frames after 4837ms are cropped or letterboxed");
  });

  test("a same-size panel change warns about an inactive panel instead of cropping", () => {
    const twin: DeviceDisplays = {
      panels: displays.panels.map((panel) => ({ ...panel, sizePx: { width: 10, height: 20 } })),
      postures: [],
    };
    const [warning] = androidPanelTransitionWarnings(twin, COVER, foldSweep);
    expect(warning).toContain("frames from 4837ms to 10183ms may show an inactive panel.");
  });

  test("an unresolved destination panel still warns", () => {
    const [warning] = androidPanelTransitionWarnings(displays, COVER, [
      { atMs: 50, from: COVER, to: { key: "unknown", role: "unknown" } },
    ]);
    expect(warning).toContain("changed to an unresolved panel at 50ms");
    expect(warning).toContain("cropped or letterboxed to the recorded 1080x2424 size");
  });

  test("the start-time seeded transition of a deliberately chosen panel is not warned", () => {
    const seeded = { atMs: 0, from: COVER, to: INNER };
    expect(androidPanelTransitionWarnings(displays, COVER, [seeded], seeded)).toEqual([]);
  });

  test("no transitions yield no warnings", () => {
    expect(androidPanelTransitionWarnings(displays, COVER, [])).toEqual([]);
  });
});

describe("recordingDisplayWarnings", () => {
  test("Android appends transition warnings after the start-time warning", () => {
    const warnings = recordingDisplayWarnings({
      device: { platform: "android", displays },
      warning: "start warning",
      recordedPanel: COVER,
      transitions: foldSweep,
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toBe("start warning");
    expect(warnings[1]).toStartWith("Android recording kept capturing");
  });

  test("iOS keeps its own transition wording", () => {
    const [warning] = recordingDisplayWarnings({
      device: { platform: "ios", displays },
      recordedPanel: COVER,
      transitions: foldSweep.slice(0, 1),
    });
    expect(warning).toStartWith("iOS recording kept capturing");
  });
});
