import type { ObserveResult } from "../../src/models";

/** Minimal valid observation for tests that bypass the real observe pipeline. */
export const observeResultStub = {
  observationId: "observe-result-stub",
  display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
  updatedAt: 0,
  screenSize: { width: 1080, height: 1920 },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
} satisfies ObserveResult;
