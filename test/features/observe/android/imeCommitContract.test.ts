import { describe, expect, test } from "bun:test";
import contract from "../../../fixtures/ime-commit-contract.json";
import {
  IME_COMMIT_TIMEOUT,
  imeCommitSegmentCount,
  imeCommitTimeoutMs,
} from "../../../../src/features/observe/android/CtrlProxyText";

describe("shared IME commit contract", () => {
  test("host formula constants match the contract", () => {
    expect(IME_COMMIT_TIMEOUT).toEqual(contract.host);
  });
  test.each(contract.segmentCases)("segment boundaries for $text", ({ text, segments }) => {
    expect(imeCommitSegmentCount(text)).toBe(segments);
  });
  test.each(contract.timeoutCases)("host timeout for $text", ({ text, hostTimeoutMs }) => {
    expect(imeCommitTimeoutMs(text)).toBe(hostTimeoutMs);
  });
});
