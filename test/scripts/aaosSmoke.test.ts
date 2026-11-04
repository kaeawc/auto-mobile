import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  AAOS_SETTINGS_APP_ID,
  assertAutomotiveDevice,
  assertLandscapeObservation,
  assertMotionApplied,
  buildAaosSmokePlan,
  expectNotForeground,
  renderAaosSmokeSummary,
  runAaosSmoke,
  writeAaosSmokeOutputs,
  type AaosSmokeDeps,
  type Payload,
} from "../../scripts/ci/aaos-smoke/aaosSmoke";
import {
  enableFeatureFlags,
  parseFeatureFlagKeys,
} from "../../scripts/ci/aaos-smoke/enableFeatureFlags";
import type { DriveClient } from "../../scripts/mcp-drive";

function envelope(payload: Payload, isError = false): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

/** The default `skeleton` projection: no viewHierarchy or elements on the wire. */
const LANDSCAPE = {
  skeleton: [{ elementId: "e1", label: "Settings", bounds: {}, affordances: ["tap"] }],
  screenSize: { width: 1024, height: 768 },
};

function motion(status: string): Payload {
  return {
    success: true,
    deviceCondition: { success: true, changes: [{ key: "vehicle.motion", status }], active: [] },
  };
}

/** Replies per tool; observe replies are consumed in order so each observe can differ. */
class FakeClient implements DriveClient {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  closed = false;
  constructor(
    private readonly replies: Record<string, unknown>,
    private readonly observes: Payload[] = [],
  ) {}
  callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ tool, args });
    if (tool === "observe") {
      return Promise.resolve(envelope(this.observes.shift() ?? LANDSCAPE));
    }
    return Promise.resolve(this.replies[tool] ?? envelope({ success: true, message: "ok" }));
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function happyClient(overrides: Record<string, unknown> = {}): FakeClient {
  return new FakeClient(
    {
      startDevice: envelope({
        message: "ready",
        formFactor: "automotive",
        runtime: { session: { sessionUuid: "sess-1" } },
      }),
      ...overrides,
    },
    [
      { ...LANDSCAPE, activeWindow: { appId: "com.android.car.carlauncher" } },
      { ...LANDSCAPE, activeWindow: { appId: AAOS_SETTINGS_APP_ID }, screenshotPath: "/tmp/a.png" },
      { ...LANDSCAPE, activeWindow: { appId: "com.android.car.carlauncher" } },
      LANDSCAPE,
    ],
  );
}

function fakeDeps(client: DriveClient) {
  const files = new Map<string, string>();
  const copies: string[] = [];
  let clock = 0;
  const deps: AaosSmokeDeps = {
    client,
    outDir: "/out",
    writeFile: (path, contents) => files.set(path, contents),
    copyFile: (_from, to) => {
      copies.push(to);
      return true;
    },
    now: () => (clock += 5),
    log: () => {},
  };
  return { deps, files, copies };
}

/** Every motion reply, keyed off the requested motion, so driving/parked/reset all resolve. */
function motionClient(drivingStatus: string): FakeClient {
  const client = happyClient();
  const original = client.callTool.bind(client);
  client.callTool = (tool, args) => {
    const condition = args.deviceCondition as Payload | undefined;
    if (tool === "setDeviceState" && condition?.vehicle) {
      client.calls.push({ tool, args });
      const value = (condition.vehicle as Payload).motion;
      return Promise.resolve(envelope(motion(value === "driving" ? drivingStatus : "applied")));
    }
    return original(tool, args);
  };
  return client;
}

describe("buildAaosSmokePlan", () => {
  test("starts an automotive AVD with createIfMissing and enables setDeviceState", () => {
    const [start] = buildAaosSmokePlan();
    expect(start!.tool).toBe("startDevice");
    expect(start!.args).toMatchObject({
      platform: "android",
      formFactor: "automotive",
      createIfMissing: true,
      minOsVersion: "14",
      maxOsVersion: "14",
      enableTools: ["setDeviceState"],
    });
  });

  test("covers observe, launch, tap, scroll, back, home and both vehicle states", () => {
    const tools = buildAaosSmokePlan().map((step) => step.tool);
    for (const tool of ["observe", "launchApp", "tapOn", "swipeOn", "pressButton", "homeScreen"]) {
      expect(tools).toContain(tool);
    }
    const motions = buildAaosSmokePlan()
      .map((step) => (step.args.deviceCondition as Payload | undefined)?.vehicle)
      .filter(Boolean);
    expect(motions).toEqual([{ motion: "driving" }, { motion: "parked" }]);
  });

  test("only the reset step runs after a failure", () => {
    expect(
      buildAaosSmokePlan()
        .filter((step) => step.always)
        .map((step) => step.id),
    ).toEqual(["reset"]);
  });
});

describe("assertions", () => {
  test("automotive device", () => {
    expect(assertAutomotiveDevice({ formFactor: "automotive" })).toBeUndefined();
    expect(assertAutomotiveDevice({ formFactor: "phone" })).toContain("phone");
  });

  test("landscape observation", () => {
    expect(assertLandscapeObservation(LANDSCAPE)).toBeUndefined();
    expect(assertLandscapeObservation({ screenSize: { width: 1, height: 2 } })).toContain(
      "no skeleton or view hierarchy",
    );
    expect(assertLandscapeObservation({ ...LANDSCAPE, skeleton: [] })).toContain("empty skeleton");
    expect(
      assertLandscapeObservation({ viewHierarchy: {}, screenSize: { width: 1024, height: 768 } }),
    ).toBeUndefined();
    expect(
      assertLandscapeObservation({ viewHierarchy: {}, screenSize: { width: 768, height: 1024 } }),
    ).toContain("landscape");
    expect(assertLandscapeObservation({ viewHierarchy: {} })).toContain("screenSize");
  });

  test("home check fails when the payload names no foreground app", () => {
    const notSettings = expectNotForeground(AAOS_SETTINGS_APP_ID);
    expect(notSettings({ activeWindow: { appId: "com.android.car.carlauncher" } })).toBeUndefined();
    expect(notSettings({ activeWindow: { appId: AAOS_SETTINGS_APP_ID } })).toContain(
      "still in the foreground",
    );
    expect(notSettings(LANDSCAPE)).toContain("observed no foreground app");
    expect(notSettings({ activeWindow: {} })).toContain("observed no foreground app");
  });

  test("motion must be applied, not unsupported", () => {
    expect(assertMotionApplied("driving")(motion("applied"))).toBeUndefined();
    expect(assertMotionApplied("driving")(motion("unchanged"))).toBeUndefined();
    expect(assertMotionApplied("driving")(motion("unsupported"))).toContain("unsupported");
    expect(
      assertMotionApplied("parked")({ deviceCondition: { success: false, error: "user build" } }),
    ).toContain("user build");
  });
});

describe("runAaosSmoke", () => {
  test("passes the happy path, injects the minted session and records artifacts", async () => {
    const client = motionClient("applied");
    const { deps, files, copies } = fakeDeps(client);
    const result = await runAaosSmoke(buildAaosSmokePlan(), deps);
    expect(result.steps.filter((step) => step.status !== "passed")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.session).toBe("sess-1");
    expect(client.calls[1]!.args.sessionUuid).toBe("sess-1");
    expect(client.closed).toBe(true);
    // Built with path.join so the expectation holds on Windows separators too.
    expect(files.has(join("/out", "steps", "01-start.json"))).toBe(true);
    expect(copies).toEqual([join("/out", "screenshots", "04-observe-launched.png")]);
  });

  test("a broken assertion fails its step, skips the rest and still resets", async () => {
    const client = motionClient("applied");
    const { deps } = fakeDeps(client);
    const result = await runAaosSmoke(buildAaosSmokePlan({ breakAssertion: true }), deps);
    expect(result.ok).toBe(false);
    const failed = result.steps.find((step) => step.status === "failed");
    expect(failed?.id).toBe("observe-launched");
    expect(failed?.detail).toContain("com.example.deliberately.broken");
    expect(result.steps.find((step) => step.id === "tap")?.status).toBe("skipped");
    expect(result.steps.at(-1)).toMatchObject({ id: "reset", status: "passed" });
    const summary = renderAaosSmokeSummary(result);
    expect(summary).toContain("**Failed** at `observe-launched` (`observe`)");
    expect(summary).toContain("| tap | tapOn |");
  });

  test("an unsupported driving state fails with the reported status", async () => {
    const { deps } = fakeDeps(motionClient("unsupported"));
    const result = await runAaosSmoke(buildAaosSmokePlan(), deps);
    const failed = result.steps.find((step) => step.status === "failed");
    expect(failed?.id).toBe("driving");
    expect(failed?.detail).toContain("unsupported");
  });

  test("tool errors and thrown calls are failures with their text", async () => {
    const client = happyClient({ startDevice: envelope({ error: "no automotive image" }, true) });
    const { deps } = fakeDeps(client);
    const result = await runAaosSmoke(buildAaosSmokePlan(), deps);
    expect(result.steps[0]).toMatchObject({ status: "failed" });
    expect(result.steps[0]!.detail).toContain("no automotive image");

    const throwing = happyClient();
    throwing.callTool = () => Promise.reject(new Error("transport closed"));
    const thrown = await runAaosSmoke(buildAaosSmokePlan(), fakeDeps(throwing).deps);
    expect(thrown.steps[0]!.detail).toBe("call threw: transport closed");
    expect(throwing.closed).toBe(true);
  });

  test("a step JSON write failure is a detail and the plan still reaches the reset", async () => {
    const client = motionClient("applied");
    const { deps } = fakeDeps(client);
    const logs: string[] = [];
    deps.log = (message) => logs.push(message);
    deps.writeFile = (path) => {
      if (path.endsWith("01-start.json")) {
        throw new Error("ENOSPC: no space left on device");
      }
    };
    const result = await runAaosSmoke(buildAaosSmokePlan(), deps);
    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({
      id: "start",
      status: "passed",
      detail: "could not write step JSON: ENOSPC: no space left on device",
    });
    expect(result.steps.at(-1)).toMatchObject({ id: "reset", status: "passed" });
    expect(logs.some((line) => line.includes("could not write"))).toBe(true);
    expect(client.closed).toBe(true);
  });

  test("a write failure on a failing step keeps the verdict first", async () => {
    const client = happyClient({ startDevice: envelope({ error: "no automotive image" }, true) });
    const { deps } = fakeDeps(client);
    deps.writeFile = () => {
      throw new Error("EACCES");
    };
    const result = await runAaosSmoke(buildAaosSmokePlan(), deps);
    expect(result.steps[0]!.status).toBe("failed");
    expect(result.steps[0]!.detail).toMatch(
      /^tool error: .*no automotive image.*; could not write step JSON: EACCES$/,
    );
    expect(result.steps.at(-1)).toMatchObject({ id: "reset", status: "passed" });
  });

  test("summary escapes table pipes and reports a pass", () => {
    const summary = renderAaosSmokeSummary({
      ok: true,
      steps: [{ id: "a", tool: "t", expectation: "x | y", status: "passed", durationMs: 3 }],
    });
    expect(summary).toContain("**Passed**");
    expect(summary).toContain("x \\| y");
  });
});

describe("writeAaosSmokeOutputs", () => {
  const result = { ok: false, steps: [] };

  test("writes summary.md, result.json and appends the step summary", () => {
    const written = new Map<string, string>();
    const appended: string[] = [];
    const failures = writeAaosSmokeOutputs(result, "## summary", {
      outDir: "/out",
      stepSummaryPath: "/gh/summary",
      writeFile: (path, contents) => written.set(path, contents),
      appendFile: (path, contents) => appended.push(`${path}:${contents}`),
      log: () => {},
    });
    expect(failures).toEqual([]);
    expect(written.get(join("/out", "summary.md"))).toBe("## summary");
    expect(JSON.parse(written.get(join("/out", "result.json"))!)).toEqual(result);
    expect(appended).toEqual(["/gh/summary:## summary"]);
  });

  test("one failed write does not drop the others", () => {
    const written: string[] = [];
    const logs: string[] = [];
    const appended: string[] = [];
    const failures = writeAaosSmokeOutputs(result, "## summary", {
      outDir: "/out",
      stepSummaryPath: "/gh/summary",
      writeFile: (path) => {
        if (path.endsWith("summary.md")) {
          throw new Error("EROFS");
        }
        written.push(path);
      },
      appendFile: (path) => appended.push(path),
      log: (message) => logs.push(message),
    });
    expect(failures).toEqual(["could not write summary.md: EROFS"]);
    expect(logs).toEqual(failures);
    expect(written).toEqual([join("/out", "result.json")]);
    expect(appended).toEqual(["/gh/summary"]);
  });

  test("skips the step summary when GITHUB_STEP_SUMMARY is unset", () => {
    const appended: string[] = [];
    writeAaosSmokeOutputs(result, "s", {
      outDir: "/out",
      writeFile: () => {},
      appendFile: (path) => appended.push(path),
      log: () => {},
    });
    expect(appended).toEqual([]);
  });
});

describe("enableFeatureFlags", () => {
  test("validates keys and enables each one", async () => {
    expect(parseFeatureFlagKeys(["device-condition"])).toEqual(["device-condition"]);
    expect(() => parseFeatureFlagKeys([])).toThrow("usage");
    expect(() => parseFeatureFlagKeys(["nope"])).toThrow("unknown feature flag(s): nope");
    const set: string[] = [];
    await enableFeatureFlags(["device-condition"], {
      setFlag: (key, enabled) => {
        set.push(`${key}=${String(enabled)}`);
        return Promise.resolve();
      },
    });
    expect(set).toEqual(["device-condition=true"]);
  });
});
