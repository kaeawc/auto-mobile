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
import { verifiedForegroundApp } from "../../../src/features/accessibility/AuditForegroundRefusal";

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

/** A fake foreground read; undefined is an observation that names no app. */
function foregroundIs(appId: string | undefined) {
  const reads: string[] = [];
  return {
    reads,
    reader: async (device: BootedDevice) => {
      reads.push(device.deviceId);
      return appId;
    },
  };
}

function audit(result: CtrlProxyAccessibilityAuditResult, foreground?: string) {
  const sender = new FakeAuditSender(result);
  const read = foregroundIs(foreground);
  return {
    sender,
    reads: read.reads,
    audit: new NativeAccessibilityAudit(() => sender, read.reader),
  };
}

const PASSING: CtrlProxyAccessibilityAuditResult = {
  success: true,
  totalTimeMs: 1,
  issues: [],
  unsupportedChecks: [],
};

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

  test("a background appId is refused before the runner, naming both apps (#17303)", async () => {
    const { sender, audit: subject } = audit(PASSING, "com.apple.springboard");

    const result = await subject.run(ios, { appId: "com.apple.Preferences" });

    expect(result).toMatchObject({ success: false, engine: "xcuitest", issues: [] });
    expect(result.errorCode).toBeUndefined();
    expect(result.error).toBe(
      "The accessibility audit checks the foreground screen; com.apple.Preferences is not in the foreground (com.apple.springboard is). Bring com.apple.Preferences to the foreground or omit appId.",
    );
    expect(sender.requests).toEqual([]);
  });

  test("the foreground appId reaches the runner", async () => {
    const { sender, audit: subject } = audit(PASSING, "com.example.app");

    const result = await subject.run(ios, { appId: "com.example.app" });

    expect(result.success).toBe(true);
    expect(sender.requests).toHaveLength(1);
  });

  test("without appId the foreground is not read", async () => {
    const { reads, audit: subject } = audit(PASSING, "com.other.app");

    const result = await subject.run(ios);

    expect(result.success).toBe(true);
    expect(reads).toEqual([]);
  });

  test.each([
    ["a background app", "Invalid target app 57020"],
    ["an app that is not running", "Invalid XCUIApplication"],
  ])("the runner's raw error for %s maps to the refusal", async (_case, raw) => {
    const { audit: subject } = audit({ success: false, totalTimeMs: 1, error: raw });

    const result = await subject.run(ios, { appId: "com.apple.MobileSMS" });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "The accessibility audit checks the foreground screen; com.apple.MobileSMS is not in the foreground. Bring com.apple.MobileSMS to the foreground or omit appId.",
    );
  });

  test("a failed foreground read still runs the audit", async () => {
    const sender = new FakeAuditSender(PASSING);
    const subject = new NativeAccessibilityAudit(
      () => sender,
      async () => {
        throw new Error("observe failed");
      },
    );

    const result = await subject.run(ios, { appId: "com.example.app" });

    expect(result.success).toBe(true);
    expect(sender.requests).toHaveLength(1);
  });

  test("a stale observation's foreground is unknown, not a mismatch", () => {
    const activeWindow = { appId: "com.previous.app", activityName: "", layoutSeqSum: 0 };

    expect(verifiedForegroundApp({ activeWindow, freshness: { isFresh: false } })).toBeUndefined();
    expect(verifiedForegroundApp({ activeWindow, freshness: { isFresh: true } })).toBe(
      "com.previous.app",
    );
    expect(verifiedForegroundApp({ activeWindow })).toBe("com.previous.app");
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
