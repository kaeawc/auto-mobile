import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ScreenFingerprint,
  type AccessibilityHierarchy,
} from "../../../src/features/navigation/ScreenFingerprint";
import type { ObserveResult } from "../../../src/models";

const captures = [
  {
    name: "android-home.json",
    hash: "ee762cc4efbe0e112f1c11278dcea4a74f39a54421af29fcbf7e2cdbd004a71b",
    keyboardDetected: false,
    elementCount: 47,
  },
  {
    name: "android-playground-raw-trim-candidates.json",
    hash: "5c6a39c949cfeec058c563e7a0c1bd8f9f9226e1626ca48e3998df4c6b50f64d",
    keyboardDetected: false,
    elementCount: undefined,
  },
  {
    name: "diff/scroll-before.json",
    hash: "5c6a39c949cfeec058c563e7a0c1bd8f9f9226e1626ca48e3998df4c6b50f64d",
    keyboardDetected: false,
    elementCount: undefined,
  },
  {
    name: "diff/scroll-after.json",
    hash: "5c6a39c949cfeec058c563e7a0c1bd8f9f9226e1626ca48e3998df4c6b50f64d",
    keyboardDetected: false,
    elementCount: undefined,
  },
  {
    name: "diff/text-input-empty.json",
    hash: "5c6a39c949cfeec058c563e7a0c1bd8f9f9226e1626ca48e3998df4c6b50f64d",
    keyboardDetected: true,
    elementCount: undefined,
  },
  {
    name: "diff/text-input-typed.json",
    hash: "5c6a39c949cfeec058c563e7a0c1bd8f9f9226e1626ca48e3998df4c6b50f64d",
    keyboardDetected: true,
    elementCount: undefined,
  },
];

describe("ScreenFingerprint captured golden hashes", () => {
  for (const { name, hash, keyboardDetected, elementCount } of captures) {
    const capture = JSON.parse(
      readFileSync(join(import.meta.dir, "../../fixtures/observe", name), "utf8"),
    ) as ObserveResult;
    test(name, () => {
      const result = ScreenFingerprint.compute({
        updatedAt: Number(capture.updatedAt),
        packageName: capture.viewHierarchy?.packageName ?? "",
        hierarchy: capture.viewHierarchy!.hierarchy as AccessibilityHierarchy["hierarchy"],
      });
      expect(result.hash).toBe(hash);
      expect(result.keyboardDetected).toBe(keyboardDetected);
      expect(result.elementCount).toBe(elementCount);
    });
  }
});
