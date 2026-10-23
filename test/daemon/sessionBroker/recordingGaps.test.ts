import { expect, test } from "bun:test";
import { InMemoryMutationRecordingGaps } from "../../../src/daemon/sessionBroker/mutations/recordingGaps";

test("gaps preserve the first reason per session until cleared", () => {
  const gaps = new InMemoryMutationRecordingGaps();
  expect(gaps.reasonFor("a")).toBeUndefined();
  gaps.mark("a", "clipboard: unavailable");
  gaps.mark("a", "later");
  gaps.mark("b", "other");
  expect(gaps.reasonFor("a")).toBe("clipboard: unavailable");
  gaps.clear("a");
  expect(gaps.reasonFor("a")).toBeUndefined();
  expect(gaps.reasonFor("b")).toBe("other");
  gaps.mark("a", "new");
  expect(gaps.reasonFor("a")).toBe("new");
});
