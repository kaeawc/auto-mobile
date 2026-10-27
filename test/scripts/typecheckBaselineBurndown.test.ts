import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../src/features/observe/ios";
import { CtrlProxyHierarchy as CtrlProxyHierarchyDelegate } from "../../src/features/observe/ios/CtrlProxyHierarchy";

describe("typecheck burndown", () => {
  test("iOS barrel keeps the CtrlProxyHierarchy delegate runtime export", () => {
    expect(CtrlProxyHierarchy).toBe(CtrlProxyHierarchyDelegate);
  });
});
