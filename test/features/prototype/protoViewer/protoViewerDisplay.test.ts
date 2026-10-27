import { describe, expect, test } from "bun:test";
import { protoViewerWireResultSchema } from "../../../../src/features/prototype/protoViewer/protoViewerContract";
import { protoViewerDisplayFor } from "../../../../src/features/prototype/protoViewer/protoViewerDisplay";

const LIBRARY_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const displays = {
  panels: [
    { key: "Cover", role: "cover" as const, sizePx: { width: 1206, height: 2622 } },
    { key: "Inner", role: "inner" as const, sizePx: { width: 1902, height: 1338 } },
  ],
  postures: ["closed" as const, "opened" as const],
};

describe("protoViewerDisplayFor", () => {
  test("matches either orientation of the reported native pixels", () => {
    expect(protoViewerDisplayFor("1902x1338", displays)).toEqual({ key: "Inner", role: "inner" });
    expect(protoViewerDisplayFor("1338x1902", displays)).toEqual({ key: "Inner", role: "inner" });
    expect(protoViewerDisplayFor("2622x1206", displays)).toEqual({ key: "Cover", role: "cover" });
  });

  test("reports nothing without a screen, a second panel, or a unique match", () => {
    expect(protoViewerDisplayFor(undefined, displays)).toBeUndefined();
    expect(protoViewerDisplayFor("100x100", displays)).toBeUndefined();
    expect(protoViewerDisplayFor("1902x1338", undefined)).toBeUndefined();
    expect(
      protoViewerDisplayFor("1206x2622", { panels: [displays.panels[0]], postures: ["unknown"] }),
    ).toBeUndefined();
  });
});

describe("wire result screen", () => {
  test("keeps a well-formed screen and rejects a malformed one", () => {
    const base = { status: "opened", request: "r", libraryId: LIBRARY_ID, label: "Demo" };
    expect(protoViewerWireResultSchema.parse({ ...base, screen: "1902x1338" })).toMatchObject({
      screen: "1902x1338",
    });
    expect(protoViewerWireResultSchema.safeParse({ ...base, screen: "wide" }).success).toBe(false);
    expect(protoViewerWireResultSchema.parse(base)).not.toHaveProperty("screen");
  });
});
