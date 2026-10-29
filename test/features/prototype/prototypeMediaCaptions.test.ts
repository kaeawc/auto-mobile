import { describe, expect, test } from "bun:test";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const track = (id: string, source: Record<string, unknown>) => ({
  id,
  language: "en",
  label: `Track ${id}`,
  source,
});

function spec(captions: unknown[], cues: unknown = [{ startMs: 0, endMs: 1000, text: "Hi" }]) {
  return {
    id: "captions",
    window: { placement: { type: "fullscreen" } },
    data: { cues: { en: cues } },
    requires: { platform: ["media"] },
    media: { players: { main: { kind: "video", source: { sample: "countdown" } } } },
    root: { type: "videoPlayer", player: "main", captions },
  };
}

describe("videoPlayer captions", () => {
  test("asset and /data tracks validate", () => {
    const result = validatePrototypeSpec(
      spec([track("en", { data: "/data/cues/en" }), track("fr", { asset: "trailerFr" })]),
    );
    expect(result.success).toBe(true);
  });

  test("track ids are unique and hls: ids are reserved for in-band tracks", () => {
    expect(
      validatePrototypeSpec(spec([track("a", { asset: "x" }), track("a", { asset: "y" })])),
    ).toEqual({
      success: false,
      error: { path: "root.captions[1].id", message: "Duplicate caption id" },
    });
    expect(validatePrototypeSpec(spec([track("hls:en", { asset: "x" })]))).toEqual({
      success: false,
      error: {
        path: "root.captions[0].id",
        message: "Caption ids starting with hls: are reserved",
      },
    });
  });

  test("data cues point at a declared array and each cue ends after it starts", () => {
    expect(validatePrototypeSpec(spec([track("en", { data: "/data/cues" })]))).toEqual({
      success: false,
      error: {
        path: "root.captions[0].source.data",
        message: "Caption data must point to a /data array",
      },
    });
    const backwards = spec(
      [track("en", { data: "/data/cues/en" })],
      [{ startMs: 500, endMs: 500, text: "Hi" }],
    );
    expect(validatePrototypeSpec(backwards)).toEqual({
      success: false,
      error: { path: "data.cues.en[0].endMs", message: "A caption cue must end after it starts" },
    });
  });

  test("track ids are kept as authored, so the checked ids are the parsed ids", () => {
    const padded = spec([track(" en ", { asset: "x" }), track("en", { asset: "y" })]);
    expect(validatePrototypeSpec(padded).success).toBe(true);
    const parsed = prototypeSpecSchema.parse(padded);
    expect(JSON.stringify(parsed)).toContain('"id":" en "');
  });
});
