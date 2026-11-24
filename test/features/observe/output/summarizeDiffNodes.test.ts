import { describe, expect, test } from "bun:test";
import { summarizeDiffNodes } from "../../../../src/features/observe/output/resultOutput/diff";
import {
  MAX_DIFF_SUMMARY_LABELS,
  MAX_DIFF_SUMMARY_LABEL_LENGTH,
} from "../../../../src/features/observe/output/resultOutput/diffTypes";

const node = (text: string) => ({ key: text, attributes: { text } });

describe("summarizeDiffNodes", () => {
  test("returns undefined for an empty list", () => {
    expect(summarizeDiffNodes([])).toBeUndefined();
  });

  test("keeps a short label as is", () => {
    expect(summarizeDiffNodes([node("Wi-Fi")])).toEqual({ count: 1, labels: ["Wi-Fi"] });
  });

  // #19145: an unprojected label is the raw text, which can be a whole paragraph.
  test("cuts a long label to the cap with an ellipsis (#19145)", () => {
    const paragraph = "Lorem ipsum dolor sit amet ".repeat(20);
    const summary = summarizeDiffNodes([node(paragraph)]);
    const label = summary?.labels?.[0] ?? "";
    expect(label).toHaveLength(MAX_DIFF_SUMMARY_LABEL_LENGTH);
    expect(label.endsWith("…")).toBe(true);
    expect(paragraph.startsWith(label.slice(0, -1))).toBe(true);
  });

  test("keeps a label exactly at the cap uncut", () => {
    const exact = "x".repeat(MAX_DIFF_SUMMARY_LABEL_LENGTH);
    expect(summarizeDiffNodes([node(exact)])?.labels).toEqual([exact]);
  });

  test("never leaves a lone surrogate at the cut", () => {
    const text = `${"a".repeat(MAX_DIFF_SUMMARY_LABEL_LENGTH - 2)}😀😀😀`;
    const label = summarizeDiffNodes([node(text)])?.labels?.[0] ?? "";
    expect(label).toBe(`${"a".repeat(MAX_DIFF_SUMMARY_LABEL_LENGTH - 2)}…`);
  });

  test("keeps at most the label cap of distinct labels after cutting", () => {
    const shared = "y".repeat(MAX_DIFF_SUMMARY_LABEL_LENGTH * 2);
    const nodes = [
      node(`${shared}1`),
      node(`${shared}2`),
      ...Array.from({ length: 10 }, (_, index) => node(`row${index}`)),
    ];
    const summary = summarizeDiffNodes(nodes);
    expect(summary?.count).toBe(12);
    expect(summary?.labels).toHaveLength(MAX_DIFF_SUMMARY_LABELS);
    expect(summary?.labels?.[0]).toBe(`${"y".repeat(MAX_DIFF_SUMMARY_LABEL_LENGTH - 1)}…`);
    expect(summary?.labels?.[1]).toBe("row0");
  });
});
