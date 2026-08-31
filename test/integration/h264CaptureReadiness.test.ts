import { describe, expect, spyOn, test } from "bun:test";
import {
  H264AnnexBParser,
  NAL_TYPE_IDR,
  NAL_TYPE_PPS,
  NAL_TYPE_SPS,
} from "../../src/features/webrtc/h264";
import { FakeTimer } from "../fakes/FakeTimer";
import { createH264CaptureReadiness } from "./h264CaptureReadiness";

const START_CODE = Buffer.from([0, 0, 0, 1]);

function nal(type: number): Buffer {
  return Buffer.from([type]);
}

function completeNals(...types: number[]): Buffer {
  return Buffer.concat([...types.flatMap((type) => [START_CODE, nal(type)]), START_CODE]);
}

describe("createH264CaptureReadiness", () => {
  test("requires the requested number of complete SPS/PPS/IDR sets", async () => {
    const timer = new FakeTimer();
    const readiness = createH264CaptureReadiness(2, 100, timer);
    const waiting = readiness.wait();

    readiness.onData(completeNals(NAL_TYPE_SPS, NAL_TYPE_PPS, NAL_TYPE_IDR, NAL_TYPE_SPS));
    expect(timer.getPendingTimeoutCount()).toBe(1);

    readiness.onData(completeNals(NAL_TYPE_PPS, NAL_TYPE_IDR));
    await waiting;
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("routes parser failures through wait and clears its injected timer", async () => {
    const timer = new FakeTimer();
    const parserFailure = new Error("malformed H.264");
    const push = spyOn(H264AnnexBParser.prototype, "push").mockImplementation(() => {
      throw parserFailure;
    });
    const readiness = createH264CaptureReadiness(1, 100, timer);
    const waiting = readiness.wait();

    try {
      expect(() => readiness.onData(Buffer.alloc(1))).not.toThrow();
      await expect(waiting).rejects.toBe(parserFailure);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      push.mockRestore();
    }
  });
});
