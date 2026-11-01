import { describe, expect, test } from "bun:test";
import type { DriveClient, DriveStep } from "../../../scripts/mcp-drive";
import {
  HARNESS_TOOLS,
  runHarness,
  type HarnessOptions,
} from "../../../scripts/persona-robustness/harness";
import {
  BASELINE_PERSONA_ID,
  personaPerturbation,
  selectPerturbations,
} from "../../../scripts/persona-robustness/matrix";
import { renderMarkdown } from "../../../scripts/persona-robustness/report";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";

isolateToolRegistry();

const APP = "com.example.app";

function envelope(payload: Record<string, unknown>, isError = false): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

const PLAN_OK = { success: true, executedSteps: 4, totalSteps: 4 };
const PLAN_FAILED = {
  success: false,
  executedSteps: 2,
  totalSteps: 4,
  failedStep: { stepIndex: 2, tool: "tapOn", error: "Element not found" },
};

/**
 * Tracks what is applied on the "device" and answers executePlan from it. `breaks` decides
 * whether a plan fails given the applied calls; `failApply` and `failReset` inject harness errors.
 */
class FakeDevice implements DriveClient {
  calls: DriveStep[] = [];
  applied: DriveStep[] = [];
  constructor(
    private readonly breaks: (applied: DriveStep[]) => boolean,
    private readonly failures: {
      apply?: string;
      reset?: number;
      status?: Record<string, string>;
    } = {},
  ) {}

  callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ tool, args });
    if (tool === "getAndroid") {
      return Promise.resolve(
        envelope({ message: "ready", runtime: { session: { sessionUuid: "sess-1" } } }),
      );
    }
    if (tool === "executePlan") {
      return Promise.resolve(envelope(this.breaks(this.applied) ? PLAN_FAILED : PLAN_OK));
    }
    if (tool === "manufacturerProfile" && args.action === "reset") {
      const resets = this.calls.filter((c) => c.tool === tool && c.args.action === "reset").length;
      if (resets === this.failures.reset) {
        return Promise.resolve(envelope({ error: "adb offline" }, true));
      }
      this.applied = [];
      return Promise.resolve(envelope({ success: true }));
    }
    if (this.failures.apply && JSON.stringify(args).includes(this.failures.apply)) {
      return Promise.resolve(envelope({ error: "overlay unsupported" }, true));
    }
    const status = this.failures.status?.[tool];
    if (status) {
      this.applied.push({ tool, args });
      return Promise.resolve(envelope({ success: true, status }));
    }
    this.applied.push({ tool, args });
    return Promise.resolve(envelope({ success: true }));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function options(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  return {
    planName: "navigate-demo-index",
    planContent: "name: x\nsteps: []\n",
    appId: APP,
    baseline: personaPerturbation(BASELINE_PERSONA_ID, APP),
    perturbations: selectPerturbations(["samsung-oneui", "display:font-scale-1.3"], APP),
    repeats: 1,
    ablate: false,
    ...overrides,
  };
}

function deps(client: DriveClient, logs: string[] = []) {
  let clock = 0;
  return { client, log: (message: string) => logs.push(message), now: () => (clock += 10) };
}

const usesCutout = (applied: DriveStep[]) =>
  applied.some(
    (step) =>
      JSON.stringify(step.args).includes('"cutout":"hole"') ||
      step.args.manufacturerProfile === "samsung-oneui",
  );

describe("runHarness", () => {
  test("mints a session, resets first, and resets after every replay", async () => {
    const device = new FakeDevice(() => false);
    const report = await runHarness(options(), deps(device));
    expect(report.session).toBe("sess-1");
    expect(report.aborted).toBeUndefined();
    const sequence = device.calls.map((c) => `${c.tool}:${String(c.args.action ?? "")}`);
    expect(sequence).toEqual([
      "getAndroid:",
      "manufacturerProfile:reset",
      "manufacturerProfile:apply",
      "executePlan:",
      "manufacturerProfile:reset",
      "manufacturerProfile:apply",
      "executePlan:",
      "manufacturerProfile:reset",
      "displayProfile:apply",
      "executePlan:",
      "manufacturerProfile:reset",
    ]);
    expect(device.calls.slice(1).every((c) => c.args.sessionUuid === "sess-1")).toBe(true);
    expect(report.baseline.verdict).toBe("pass");
    expect(report.results.map((r) => r.verdict)).toEqual(["pass", "pass"]);
  });

  test("reuses a held session, enabling the harness tools on it first", async () => {
    const device = new FakeDevice(() => false);
    await runHarness(options({ session: "held" }), deps(device));
    expect(device.calls.some((c) => c.tool === "getAndroid")).toBe(false);
    expect(device.calls.every((c) => c.args.sessionUuid === "held")).toBe(true);
    expect(device.calls[0]).toEqual({
      tool: "setToolEnabled",
      args: { toolNames: [...HARNESS_TOOLS], enabled: true, sessionUuid: "held" },
    });
  });

  test("acquisition declares the harness tools and every replay names the platform", async () => {
    const device = new FakeDevice(() => false);
    await runHarness(options({ acquireArgs: { avdName: "Pixel_9" } }), deps(device));
    expect(device.calls[0]).toEqual({
      tool: "getAndroid",
      args: { avdName: "Pixel_9", enableTools: [...HARNESS_TOOLS] },
    });
    const plans = device.calls.filter((c) => c.tool === "executePlan");
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((c) => c.args.platform === "android")).toBe(true);
  });

  test("an apply that reports an unapplied effect is a harness error, not a pass", async () => {
    const device = new FakeDevice(() => false, { status: { displayProfile: "unsupported" } });
    const report = await runHarness(options(), deps(device));
    const stressor = report.results.find((r) => r.id === "display:font-scale-1.3");
    expect(stressor?.verdict).toBe("error");
    expect(stressor?.runs[0]?.error).toContain("status unsupported");
    expect(device.calls.filter((c) => c.tool === "executePlan")).toHaveLength(2);
  });

  test("ablation attributes a persona failure to the facet that fails alone", async () => {
    const device = new FakeDevice(usesCutout);
    const report = await runHarness(options({ ablate: true }), deps(device));
    const samsung = report.results.find((r) => r.id === "samsung-oneui");
    expect(samsung?.verdict).toBe("failed");
    expect(samsung?.attribution).toEqual({
      kind: "facets",
      facets: ["display:cutout=hole,navigationMode=threebutton"],
    });
    expect(report.ablations.map((r) => [r.id, r.verdict])).toEqual([
      ["samsung-oneui/keyboard:samsung", "pass"],
      ["samsung-oneui/kill:samsung-sleeping", "pass"],
      ["samsung-oneui/display:cutout=hole,navigationMode=threebutton", "failed"],
    ]);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("| samsung-oneui |");
    expect(markdown).toContain("#2 tapOn: Element not found");
    expect(markdown).toContain("## Facet ablations");
    expect(markdown).toContain("- samsung-oneui keyboard: experimental");
  });

  test("without --ablate a persona failure names its facets as candidates", async () => {
    const device = new FakeDevice(usesCutout);
    const report = await runHarness(options(), deps(device));
    expect(report.results[0]?.attribution.kind).toBe("not-ablated");
    expect(report.ablations).toEqual([]);
  });

  test("a failing baseline makes every failure not attributable and skips ablation", async () => {
    const device = new FakeDevice(() => true);
    const report = await runHarness(options({ ablate: true }), deps(device));
    expect(report.baseline.verdict).toBe("failed");
    expect(report.results.every((r) => r.attribution.kind === "not-attributable")).toBe(true);
    expect(report.ablations).toEqual([]);
  });

  test("repeats with mixed outcomes are flaky", async () => {
    let plans = 0;
    const device = new FakeDevice((applied) => {
      plans += 1;
      return applied.some((s) => s.tool === "displayProfile") && plans % 2 === 0;
    });
    const report = await runHarness(
      options({ perturbations: selectPerturbations(["display:font-scale-1.3"], APP), repeats: 2 }),
      deps(device),
    );
    expect(report.results[0]?.runs.map((r) => r.outcome)).toEqual(["pass", "failed"]);
    expect(report.results[0]?.verdict).toBe("flaky");
  });

  test("an apply failure is a harness error, skips the plan, and still resets", async () => {
    const device = new FakeDevice(() => false, { apply: "fontScale" });
    const report = await runHarness(options(), deps(device));
    const stressor = report.results.find((r) => r.id === "display:font-scale-1.3");
    expect(stressor?.verdict).toBe("error");
    expect(stressor?.runs[0]?.error).toContain("overlay unsupported");
    expect(device.calls.filter((c) => c.tool === "executePlan")).toHaveLength(2);
    expect(device.calls.at(-1)?.args.action).toBe("reset");
  });

  test("a failed reset aborts the run and keeps the results so far", async () => {
    const device = new FakeDevice(() => false, { reset: 3 });
    const logs: string[] = [];
    const report = await runHarness(options(), deps(device, logs));
    expect(report.aborted).toContain("reset after samsung-oneui failed");
    expect(report.results).toEqual([]);
    expect(report.baseline.verdict).toBe("pass");
    expect(renderMarkdown(report)).toContain("**Aborted:**");
    expect(logs.at(-1)).toContain("aborted");
  });

  test("rejects a non-positive repeat count", async () => {
    await expect(
      runHarness(options({ repeats: 0 }), deps(new FakeDevice(() => false))),
    ).rejects.toThrow(/repeats/);
  });
});
