import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

describe("MediaMTX WebRTC configuration", () => {
  test("allows enough time for a device encoder to provide its first track", () => {
    const config = load(readFileSync("examples/mediamtx/mediamtx.yml", "utf8")) as {
      webrtcTrackGatherTimeout?: string;
    };

    expect(config.webrtcTrackGatherTimeout).toBe("30s");
  });
});
