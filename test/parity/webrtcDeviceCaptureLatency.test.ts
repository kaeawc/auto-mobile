import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { CAPTURE_STAGES } from "../helpers/captureStageTimeline";

const repoRoot = join(import.meta.dir, "../..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const INTEGRATION_TEST_PATH = "test/integration/webrtcDeviceCapture.integration.test.ts";

/** Source with comments stripped, so a commented-out call cannot satisfy a guard. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Index of `needle`, asserted present first. A bare `indexOf` returns -1 when
 * the call site is deleted outright, and -1 satisfies any "comes before" check —
 * so an ordering guard built on it passes precisely when the code is gone.
 */
function indexOfRequired(source: string, needle: string): number {
  const index = source.indexOf(needle);
  expect(`${needle} present: ${index >= 0}`).toBe(`${needle} present: true`);
  return index;
}

interface AstNode {
  type: string;
  [key: string]: unknown;
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function visitAst(value: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitAst(item, visit);
    }
    return;
  }
  if (!isAstNode(value)) {
    return;
  }
  visit(value);
  for (const child of Object.values(value)) {
    visitAst(child, visit);
  }
}

function execFileOptionNames(source: string): string[][] {
  const optionNames: string[][] = [];
  visitAst(parseSync(INTEGRATION_TEST_PATH, source).program, (node) => {
    if (
      node.type !== "CallExpression" ||
      !isAstNode(node.callee) ||
      node.callee.type !== "Identifier" ||
      node.callee.name !== "execFileAsync" ||
      !Array.isArray(node.arguments)
    ) {
      return;
    }
    const options = node.arguments[2];
    if (
      !isAstNode(options) ||
      options.type !== "ObjectExpression" ||
      !Array.isArray(options.properties)
    ) {
      optionNames.push([]);
      return;
    }
    optionNames.push(
      options.properties.flatMap((property) => {
        if (
          !isAstNode(property) ||
          property.type !== "Property" ||
          !isAstNode(property.key) ||
          property.key.type !== "Identifier" ||
          typeof property.key.name !== "string"
        ) {
          return [];
        }
        return [property.key.name];
      }),
    );
  });
  return optionNames;
}

/**
 * The device lane needs a real emulator/simulator, so its instrumentation
 * cannot be exercised here. These guards pin the wiring instead: every stage is
 * marked in pipeline order, each stage measures the event it is named for, the
 * record survives a timeout, and no assertion depends on how long a hosted
 * runner happened to take (#4343).
 */
describe("#4343 device capture latency instrumentation", () => {
  test("marks every capture-to-browser stage, in pipeline order", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));
    const positions = CAPTURE_STAGES.map((stage) => source.indexOf(`timeline.mark("${stage}")`));

    for (const [index, position] of positions.entries()) {
      expect(`${CAPTURE_STAGES[index]}:${position >= 0}`).toBe(`${CAPTURE_STAGES[index]}:true`);
    }
    // A mark that moved out of its pipeline position would still be "present",
    // so pin the order the call sites appear in as well.
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  test("takes source-started from the daemon rather than from the start response", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));

    // The stream descriptor's own signal — a video-only start returns before
    // capture begins, so the start response cannot stand in for it.
    expect(source).toContain("sourceStarted === true");
    expect(indexOfRequired(source, 'timeline.mark("sourceStarted")')).toBeLessThan(
      indexOfRequired(source, 'action: "start"'),
    );
  });

  test("launches the browser before the measured window opens", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));

    // Chrome cold start is seconds on a hosted runner; inside the window it
    // would land in the WHEP-connect stage and dominate it.
    // Match the call site, not the declaration of `launchChromeReader` — the
    // declaration (which itself contains `start(chromeBinary()`) sits at the
    // top of the file and would satisfy any ordering check vacuously.
    const startRequestIndex = indexOfRequired(source, 'timeline.mark("startRequest")');
    expect(indexOfRequired(source, "({ chrome, cdp } = await launchChromeReader(")).toBeLessThan(
      startRequestIndex,
    );
  });

  test("writes the latency record from afterAll so a timed-out run still reports", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));
    const afterAllIndex = source.indexOf("afterAll(");

    // bun skips the test body's `finally` when the deadline fires but still runs
    // afterAll, so writing from the body would drop exactly the slowest samples.
    expect(afterAllIndex).toBeGreaterThan(0);
    expect(source.indexOf("afterAll(", afterAllIndex + 1)).toBe(-1);
    expect(source.indexOf("stage-latency.json")).toBeGreaterThan(afterAllIndex);
    expect(source.indexOf("result.txt")).toBeGreaterThan(afterAllIndex);
  });

  test("prints the formatted record so a passing CI run reports its timings", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));

    expect(source).toContain("console.log(`[#4343] device capture stage latency");
  });

  test("asserts nothing about measured durations", () => {
    // Collapsed so a multi-line expect() cannot slip past a line-scoped scan.
    // An assertion on a variable aliasing a timing value would still evade this;
    // the guard covers direct use, which is how such an assertion gets written.
    const collapsed = withoutComments(read(INTEGRATION_TEST_PATH)).replace(/\s+/g, " ");
    const assertions = collapsed.match(/expect\([^;]*?\)\s*\.[a-zA-Z]+\(/g) ?? [];

    expect(assertions.length).toBeGreaterThan(0);
    expect(
      assertions.filter((assertion) =>
        /timeline|record|elapsedMs|deltaMs|captureToBrowserMs|latency/.test(assertion),
      ),
    ).toEqual([]);
  });

  test("gives the fixture-restore afterEach hook an explicit timeout past bun's 5s default (#4354)", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));

    // Bun caps a hook with no explicit deadline at 5000ms, so a cosmetic
    // simctl/adb restore that contends with a just-stopped capture fails an
    // otherwise-passing run. The hook must carry its own generous timeout.
    const hookMatch = /afterEach\([\s\S]*?\},\s*([A-Z_]+)\s*\)/.exec(source);
    expect(hookMatch).not.toBeNull();
    const timeoutConstant = hookMatch![1];

    const constantValue = new RegExp(`const ${timeoutConstant} = (\\d[\\d_]*)`).exec(source)?.[1];
    expect(constantValue).toBeDefined();
    expect(Number(constantValue!.replace(/_/g, ""))).toBeGreaterThan(5_000);
  });

  test("bounds each fixture-restore subprocess so a wedged simctl/adb is killed, not waited on (#4354)", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));
    const afterEachIndex = indexOfRequired(source, "afterEach(");
    // The hook closes on its explicit timeout argument; slice to there rather
    // than to a bare `});`, which an options object `{ timeout: N });` would
    // trip on and truncate the region mid-hook.
    const hookEnd = source.indexOf("}, TEARDOWN_HOOK_TIMEOUT_MS)", afterEachIndex);
    expect(hookEnd).toBeGreaterThan(afterEachIndex);
    const hookBody = source.slice(afterEachIndex, hookEnd);

    // Every execFileAsync inside the restore hook must pass a timeout; an
    // unbounded child can outlast even the generous hook deadline.
    const restoreCalls = hookBody.match(/execFileAsync\(/g) ?? [];
    expect(restoreCalls.length).toBeGreaterThan(0);
    const boundedCalls = hookBody.match(/execFileAsync\([\s\S]*?timeout:/g) ?? [];
    expect(boundedCalls.length).toBe(restoreCalls.length);
  });

  test("measures the fixture-restore hook as a phase so a teardown failure is attributable from the artifact (#4354)", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));
    const afterEachIndex = indexOfRequired(source, "afterEach(");

    // The hook records its own elapsed time and status into the stage record,
    // so a red teardown is visible without reading job logs. Whitespace-tolerant:
    // the call is written as a multi-line `timeline\n.runPhase(` chain.
    const phaseInHook = /runPhase\(\s*"fixtureRestore"/.exec(source.slice(afterEachIndex));
    expect(phaseInHook).not.toBeNull();
  });

  test("wraps the pipeline teardown finally in its own measured phase (#4354)", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));

    expect(source).toContain('runPhase("pipelineTeardown"');
  });

  test("bounds real-I/O operations and leaves a teardown fallback for a timed-out body (#5715)", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));

    // The outer test deadline only reports a whole-suite hang. Every operation
    // that can block on the hosted runner needs its own failure path, while the
    // retained cleanup callback lets afterAll reap processes if Bun skips finally.
    expect(source).toContain("const REAL_IO_TIMEOUT_MS = 30_000;");
    expect(source).toContain("signal: AbortSignal.timeout(REAL_IO_TIMEOUT_MS)");
    expect(source).toContain("handshakeTimeout: REAL_IO_TIMEOUT_MS");
    expect(source).toContain("CDP_COMMAND_TIMEOUT_MS");
    expect(source).toContain('import { waitFor, withDeadline } from "../helpers/abortableWaitFor"');
    expect(source).toContain("async (signal) => {");
    expect(source).toContain("changeFixture(signal) : launchFixture(signal)");
    expect(source).toContain("let pendingPipelineTeardown: (() => Promise<void>) | undefined;");
    expect(source).toContain("const cleanup = pendingPipelineTeardown;");
    expect(source).toContain("teardownPromise ??= teardown()");
    expect(source).toContain("onStarted(chrome);");
    expect(source).toContain("const cleanupErrors: unknown[] = [];");
    expect(source).toContain("await cleanupStep(() => stop(chrome));");
    expect(source).toContain(
      'new AggregateError(cleanupErrors, "WebRTC device-capture teardown failed")',
    );
    expect(source).toContain("const TEARDOWN_HOOK_TIMEOUT_MS = 45_000;");

    const afterAllIndex = indexOfRequired(source, "afterAll(");
    const cleanupIndex = indexOfRequired(source.slice(afterAllIndex), "await cleanup?.()");
    const recordIndex = indexOfRequired(source.slice(afterAllIndex), "timeline.toRecord(");
    expect(cleanupIndex).toBeLessThan(recordIndex);
  });

  test("gives every subprocess its own forced-kill deadline (#5715)", () => {
    // This uses the repository's installed Oxc TypeScript parser rather than
    // matching nested call expressions with a line regex. Adding a subprocess,
    // or deleting options from one existing call, must fail this guard.
    const calls = execFileOptionNames(read(INTEGRATION_TEST_PATH));

    expect(calls.length).toBeGreaterThan(0);
    for (const optionNames of calls) {
      expect(optionNames).toEqual(expect.arrayContaining(["timeout", "killSignal"]));
    }
  });

  test("keeps the default skipped-suite load path free of WebRTC and simulator runtime graphs (#5715)", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));

    // The macOS default test job does not enable device integration. Loading
    // these runtime graphs before registering describe.skip can wedge the
    // isolate before Bun prints the skipped test result.
    expect(source).not.toContain('from "../../src/features/webrtc/IosH264Source"');
    expect(source).not.toContain('from "../../src/server/webrtcStreamManager"');
    expect(source).not.toContain('from "../../src/utils/ios-cmdline-tools/SimCtlClient"');
    expect(source).not.toContain('from "../../src/features/webrtc/webrtcStreamingConfig"');
    expect(source).toContain('await import("../../src/features/webrtc/IosH264Source")');
    expect(source).toContain('await import("../../src/server/webrtcStreamManager")');
    expect(source).toContain('await import("../../src/utils/ios-cmdline-tools/SimCtlClient")');
    expect(source).toContain('await import("../../src/features/webrtc/webrtcStreamingConfig")');
  });

  test("collects phases on the shared timeline and keeps afterAll the sole record writer (#4354)", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));
    const afterAllIndex = source.indexOf("afterAll(");

    // Both phases record onto the module-scope `timeline` — the same instance
    // afterAll serializes — so they survive a test-body timeout the way the
    // stage marks do, rather than being lost on a local per-test object.
    const sharedTimelinePhases = source.match(/timeline\s*\.\s*runPhase\(/g) ?? [];
    expect(sharedTimelinePhases.length).toBeGreaterThanOrEqual(2);
    // afterAll is still the only place the record is written to disk.
    expect(source.indexOf("stage-latency.json")).toBeGreaterThan(afterAllIndex);
    expect(source.indexOf("writeFile", afterAllIndex)).toBeGreaterThan(afterAllIndex);
  });

  test("records the iOS WebRTC streaming fps, not the MCP-observation default (#4349)", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));

    // The generic SIMULATOR_FPS_DEFAULT is 5, tuned for one-shot observation; the
    // WebRTC path runs WEBRTC_IOS_SIMULATOR_FPS_DEFAULT (15). Sourcing the record
    // from the wrong constant made every prior iOS sample wrong by 3x.
    expect(source).toContain("WEBRTC_IOS_SIMULATOR_FPS_DEFAULT");
    // Word-boundary match, so the bare MCP-observation constant is caught in any
    // position — import, ternary, a local, a call argument — while the
    // `WEBRTC_IOS_`-prefixed constant never matches (the boundary before
    // SIMULATOR fails when preceded by `_`). A substring scan for
    // `SIMULATOR_FPS_DEFAULT}` both missed the indirect forms and would have
    // false-failed once anyone wrapped the correct constant in a template.
    expect(source).not.toMatch(/\bSIMULATOR_FPS_DEFAULT\b/);
  });

  test("samples egress bitrate and decoded fps into the record (#4349)", () => {
    const source = withoutComments(read(INTEGRATION_TEST_PATH));

    // Two cumulative inbound-RTP readings bracket the measured window; both feed
    // the record so the operating point behind the AC2 decision is observable.
    const first = indexOfRequired(source, "const before = await egressSample(cdp)");
    const second = indexOfRequired(source, "const after = await egressSample(cdp)");
    expect(first).toBeLessThan(second);
    expect(source).toContain("egressKbps = egressKbpsBetween(before, after)");
    expect(source).toContain("decodedFps = decodedFpsBetween(before, after)");
    // Carried on the record written from afterAll.
    const afterAllIndex = indexOfRequired(source, "afterAll(");
    expect(source.indexOf("egressKbps,", afterAllIndex)).toBeGreaterThan(afterAllIndex);
    expect(source.indexOf("decodedFps,", afterAllIndex)).toBeGreaterThan(afterAllIndex);
  });

  test("mirrors the Android capture fps from the video-server default quality preset", () => {
    const integration = read(INTEGRATION_TEST_PATH);
    const encoder = read("src/features/webrtc/PersistentEncoderH264Source.ts");
    const preset = read(
      "android/video-server/src/main/kotlin/dev/jasonpearson/automobile/video/QualityPreset.kt",
    );

    // The lane runs the persistent encoder, which sends `--quality medium`.
    expect(encoder).toContain('this.options.quality ?? "medium"');
    // Sliced rather than matched in one regex so a ktfmt reflow or an argument
    // reorder inside MEDIUM(...) does not turn a formatting change into a
    // spurious failure here.
    const medium = /MEDIUM\(([\s\S]*?)\)/.exec(preset)?.[1];
    expect(medium).toBeDefined();
    const mediumFps = /fps\s*=\s*(\d+)/.exec(medium ?? "")?.[1];
    expect(mediumFps).toBeDefined();
    expect(integration).toContain(`const ANDROID_VIDEO_SERVER_MEDIUM_FPS = ${mediumFps};`);
  });
});
