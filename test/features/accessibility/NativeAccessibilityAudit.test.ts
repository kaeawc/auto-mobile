import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  NativeAccessibilityAudit,
  resolveAuditChecks,
  type IosAccessibilityAuditSender,
} from "../../../src/features/accessibility/NativeAccessibilityAudit";
import type {
  CtrlProxyAccessibilityAuditResult,
  IosAccessibilityAuditRequest,
  RunnerAccessibilityAuditIssue,
} from "../../../src/features/observe/ios/CtrlProxyAccessibilityAudit";

const ios: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};
const android: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

class FakeAuditSender implements IosAccessibilityAuditSender {
  readonly requests: IosAccessibilityAuditRequest[] = [];
  constructor(private readonly result: CtrlProxyAccessibilityAuditResult) {}

  async requestAccessibilityAudit(
    request: IosAccessibilityAuditRequest,
  ): Promise<CtrlProxyAccessibilityAuditResult> {
    this.requests.push(request);
    return this.result;
  }
}

function issue(index: number): RunnerAccessibilityAuditIssue {
  return {
    check: index % 2 === 0 ? "contrast" : "hitRegion",
    summary: `issue ${index}`,
    elementId: `element-${index}`,
    bounds: { left: 0, top: index, right: 10, bottom: index + 10 },
  };
}

function audit(result: CtrlProxyAccessibilityAuditResult) {
  const sender = new FakeAuditSender(result);
  return { sender, audit: new NativeAccessibilityAudit(() => sender) };
}

describe("NativeAccessibilityAudit (#14086)", () => {
  test("all, or no checks, runs every XCUITest check", () => {
    expect(resolveAuditChecks(undefined)).toHaveLength(7);
    expect(resolveAuditChecks(["all"])).toHaveLength(7);
    expect(resolveAuditChecks(["trait", "contrast"])).toEqual(["contrast", "trait"]);
  });

  test("returns the runner's issues with element ids and bounds", async () => {
    const { sender, audit: subject } = audit({
      success: true,
      totalTimeMs: 12,
      issues: [issue(0), issue(1)],
      unsupportedChecks: [],
    });

    const result = await subject.run(ios, {
      appId: "com.example.app",
      checks: ["contrast", "hitRegion"],
    });

    expect(result).toMatchObject({
      success: true,
      engine: "xcuitest",
      totalIssues: 2,
      truncated: false,
      unsupportedChecks: [],
    });
    expect(result.issues.map((entry) => entry.elementId)).toEqual(["element-0", "element-1"]);
    expect(sender.requests).toEqual([
      { appId: "com.example.app", checks: ["contrast", "hitRegion"] },
    ]);
  });

  test("bounds the output by maxIssues and reports the clip", async () => {
    const { audit: subject } = audit({
      success: true,
      totalTimeMs: 12,
      issues: Array.from({ length: 5 }, (_, index) => issue(index)),
    });

    const result = await subject.run(ios, { maxIssues: 2 });

    expect(result.issues).toHaveLength(2);
    expect(result.totalIssues).toBe(5);
    expect(result.truncated).toBe(true);
  });

  test("defaults the bound to the WCAG audit's 50 issues", async () => {
    const { audit: subject } = audit({
      success: true,
      totalTimeMs: 12,
      issues: Array.from({ length: 60 }, (_, index) => issue(index)),
    });

    const result = await subject.run(ios);

    expect(result.issues).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  test("a runner without the command is a typed unsupported_capability, not a timeout", async () => {
    const { audit: subject } = audit({
      success: false,
      totalTimeMs: 0,
      unsupported: true,
      error: "request_accessibility_audit is not supported by the connected device service",
    });

    const result = await subject.run(ios);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("unsupported_capability");
    expect(result.error).toContain("restart the daemon");
  });

  test("a runner-reported failure keeps the issues collected before it", async () => {
    const { audit: subject } = audit({
      success: false,
      totalTimeMs: 5,
      error: "Accessibility audit of com.example.app failed: boom",
      issues: [issue(0)],
    });

    const result = await subject.run(ios);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBeUndefined();
    expect(result.error).toContain("boom");
    expect(result.issues).toHaveLength(1);
  });

  test("Android reports the native audit unsupported and points at the WCAG audit", async () => {
    const { sender, audit: subject } = audit({ success: true, totalTimeMs: 0 });

    const result = await subject.run(android, { checks: ["contrast"] });

    expect(result).toMatchObject({
      success: false,
      engine: "atf",
      errorCode: "unsupported_platform",
      unsupportedChecks: ["contrast"],
    });
    expect(result.error).toContain("WCAG");
    expect(sender.requests).toEqual([]);
  });
});
