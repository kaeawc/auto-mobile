import { describe, expect, test } from "bun:test";
import { OverlayCommitGenerations } from "../../../src/features/overlay/OverlayCommitGenerations";

describe("OverlayCommitGenerations", () => {
  test("only the newest show of an id on a device is latest", () => {
    const generations = new OverlayCommitGenerations();
    const older = generations.begin("dev", "panel");
    const newer = generations.begin("dev", "panel");
    expect(generations.isLatest("dev", "panel", older)).toBe(false);
    expect(generations.isLatest("dev", "panel", newer)).toBe(true);
  });

  test("generations are independent per device and per id", () => {
    const generations = new OverlayCommitGenerations();
    const first = generations.begin("dev", "panel");
    generations.begin("other", "panel");
    generations.begin("dev", "second");
    expect(generations.isLatest("dev", "panel", first)).toBe(true);
  });
});
