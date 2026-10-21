import { beforeEach, describe, expect, test } from "bun:test";
import {
  OnDemandAudit,
  findAuditContainer,
  type MemoryAuditResult,
} from "../../../src/features/audit/OnDemandAudit";
import type { BootedDevice, Element } from "../../../src/models";
import type { WcagViolation } from "../../../src/models/AccessibilityAudit";
import type { PerformanceAuditResult } from "../../../src/models/PerformanceAuditResult";
import {
  FAKE_AUDIT_CARD,
  FakeOnDemandAuditEngines,
  observation,
} from "../../fakes/FakeOnDemandAuditEngines";

const android: BootedDevice = { deviceId: "audit-device", platform: "android", name: "Pixel" };

const bounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

const card = FAKE_AUDIT_CARD;

function violation(
  fingerprint: string,
  severity: WcagViolation["severity"],
  elementBounds = bounds(10, 10, 50, 50),
): WcagViolation {
  return {
    type: "touch-target-too-small",
    severity,
    criterion: "2.5.5",
    message: fingerprint,
    element: { bounds: elementBounds, "resource-id": `com.example:id/${fingerprint}` },
    fingerprint,
  };
}

describe("OnDemandAudit (#14075)", () => {
  let engines: FakeOnDemandAuditEngines;
  const audit = (device: BootedDevice = android) => new OnDemandAudit(device, engines);

  beforeEach(() => {
    engines = new FakeOnDemandAuditEngines();
  });

  test("defaults to an accessibility audit of the foreground app, with flags off", async () => {
    engines.violations = [violation("small", "warning")];

    const result = await audit().run();

    expect(engines.calls).toEqual(["observe", "accessibility:com.example:/tmp/shot.png"]);
    expect(engines.configs).toEqual([{ level: "AA", failureMode: "report", useBaseline: false }]);
    expect(result.success).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.accessibility?.violations.map((v) => v.fingerprint)).toEqual(["small"]);
    expect(result.accessibility?.violations[0]?.element["resource-id"]).toBe(
      "com.example:id/small",
    );
  });

  test("uses the flag's config when set, but never its per-screen baseline", async () => {
    engines.flagConfig = { level: "AAA", failureMode: "strict", useBaseline: true };

    await audit().run();

    expect(engines.configs).toEqual([{ level: "AAA", failureMode: "strict", useBaseline: false }]);
  });

  test("failOn fails at the requested severity", async () => {
    engines.violations = [violation("small", "warning")];

    expect((await audit().run({ failOn: "error" })).failed).toBe(false);
    const failing = await audit().run({ failOn: "warning" });
    expect(failing.failed).toBe(true);
    expect(failing.success).toBe(false);
  });

  test("container scoping keeps only violations inside the container", async () => {
    engines.violations = [
      violation("inside", "error", bounds(10, 10, 50, 50)),
      violation("outside", "error", bounds(10, 700, 50, 760)),
    ];

    const result = await audit().run({ container: { elementId: "card" } });

    expect(result.accessibility?.violations.map((v) => v.fingerprint)).toEqual(["inside"]);
    const missing = await audit().run({ container: { text: "Nope" } });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("container not found");
  });

  test("baseline record then compare reports only new violations", async () => {
    engines.violations = [violation("old", "error"), violation("fixed", "error")];
    const recorded = await audit().run({ baseline: { name: "home", mode: "record" } });
    expect(recorded.baselineRecorded).toBe("home");

    engines.violations = [violation("old", "error"), violation("added", "warning")];
    const compared = await audit().run({
      baseline: { name: "home", mode: "compare" },
      failOn: "error",
    });

    expect(compared.baselineDiff?.new.map((v) => v.fingerprint)).toEqual(["added"]);
    expect(compared.baselineDiff?.fixed).toEqual(["fixed"]);
    expect(compared.baselineDiff?.unchanged).toBe(1);
    // The only new violation is a warning, so failOn error does not fail.
    expect(compared.failed).toBe(false);
  });

  test("comparing against a missing baseline is an error", async () => {
    const result = await audit().run({ baseline: { name: "none", mode: "compare" } });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No accessibility baseline named 'none'");
  });

  test("performance and memory run on request and fail failOn when they fail", async () => {
    const failing: Pick<PerformanceAuditResult, "passed" | "violations" | "diagnostics"> = {
      passed: false,
      violations: [],
      diagnostics: "jank",
    };
    engines.performanceResult = failing as PerformanceAuditResult;
    engines.memoryResult = { passed: true } as MemoryAuditResult;

    const result = await audit().run({ kinds: ["performance", "memory"], failOn: "error" });

    expect(engines.calls).toEqual(["observe", "performance", "memory:com.example"]);
    expect(result.performance?.passed).toBe(false);
    expect(result.memory?.passed).toBe(true);
    expect(result.failed).toBe(true);
  });

  test("performance needs the audited app in the foreground", async () => {
    const result = await audit().run({ kinds: ["performance"], appId: "com.other" });

    expect(engines.calls).toEqual(["observe"]);
    expect(result.unsupported?.performance).toContain("not in the foreground");
  });

  test("no foreground app and no appId is an error", async () => {
    engines.observed = { ...observation(), activeWindow: undefined };

    const result = await audit().run();

    expect(result.success).toBe(false);
    expect(result.error).toContain("No foreground app");
  });

  test("iOS reports each kind as unsupported without observing", async () => {
    const result = await audit({ deviceId: "sim", platform: "ios", name: "iPhone" }).run({
      kinds: ["accessibility", "memory"],
    });

    expect(engines.calls).toEqual([]);
    expect(Object.keys(result.unsupported ?? {})).toEqual(["accessibility", "memory"]);
    expect(result.unsupported?.accessibility).toContain("accessibilityAudit");
  });

  test("findAuditContainer matches a short resource id, text or content-desc", () => {
    const labelled: Element = { bounds: bounds(0, 0, 1, 1), "content-desc": "Settings" };
    expect(findAuditContainer([card], { elementId: "card" })).toBe(card);
    expect(findAuditContainer([card], { elementId: "com.example:id/card" })).toBe(card);
    expect(findAuditContainer([card, labelled], { text: "Settings" })).toBe(labelled);
    expect(findAuditContainer([card], { elementId: "other" })).toBe(undefined);
  });
});
