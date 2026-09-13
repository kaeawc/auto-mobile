import ts from "typescript";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * FUNNEL 2 guard: every device-addressed operation at the daemon socket boundary
 * — with OR without a session — must pass the single admission gate
 * `DevicePool.assertDeviceActionable`, which refuses a serial whose pooled
 * identity is quarantined.
 *
 * The regression this pins: the quarantine was first enforced only at
 * `assertSessionReadyForAutomation`, which is keyed on a SESSION.
 * `runTrackedDeviceInput` reaches that gate only when `getSessionForDevice` finds
 * one, so an explicit-`deviceId` tap/swipe/typeText/button/key/gesture on an IDLE
 * quarantined emulator returned early and executed against whatever now answers
 * on the serial. Separately, `request_observation` observed first and only then
 * discovered that routing was suspended, acknowledging `success: true` after
 * delivering zero frames
 * ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
 *
 * A source scan, not a type, for the same reason as the discovery funnel's guard:
 * "call the gate before you act" is an ordering obligation no signature can
 * express.
 */
describe("device-addressed admission gate (issue #6863)", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  const GATE = "assertDeviceActionable";

  /**
   * Socket servers that accept device-addressed requests from clients. The
   * capture and recording servers are here because authorization is NOT this
   * gate: the quarantine deliberately preserves the owning session, so an
   * authorized subscribe/start still passes and would capture whichever
   * replacement AVD now answers on the serial
   * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
   */
  const SCANNED = [
    "src/daemon/socketServer.ts",
    "src/daemon/deviceDataStreamSocketServer.ts",
    "src/daemon/videoStreamSocketServer.ts",
    "src/daemon/webrtcStreamSocketServer.ts",
    "src/daemon/testRecordingSocketServer.ts",
  ] as const;

  /**
   * The device-addressed choke points, and how each reaches the gate. Every
   * function in a scanned file that resolves an incoming `deviceId` must appear
   * here; a new one fails the scan below until it is listed WITH its gate call.
   */
  interface Handler {
    readonly file: string;
    /** Enclosing function whose body must contain the gate call. */
    readonly fn: string;
    readonly what: string;
  }

  const GATED_HANDLERS: readonly Handler[] = [
    {
      file: "src/daemon/socketServer.ts",
      fn: "runTrackedDeviceInput",
      what:
        "input/tap, input/swipe, input/typeText, input/pressButton, input/key and the " +
        "gestureStart/Move/End stream — gated BEFORE the sessionless early return",
    },
    {
      file: "src/daemon/socketServer.ts",
      fn: "resolveKeyValueMutationClient",
      what: "ide/* SharedPreferences and key-value mutations",
    },
    {
      file: "src/daemon/deviceDataStreamSocketServer.ts",
      fn: "handleObservationRequest",
      what: "request_observation — refuses BEFORE observing, instead of acking an empty push",
    },
    {
      file: "src/daemon/deviceDataStreamSocketServer.ts",
      fn: "resolveStorageTargetDeviceId",
      what:
        "subscribe_storage addressed by RAW serial — the session-keyed form is already " +
        "withheld by resolveDeviceId; teardown is deliberately exempt",
    },
    {
      file: "src/daemon/videoStreamSocketServer.ts",
      fn: "processLine",
      what: "video-stream subscribe — gated before any capture source is created",
    },
    {
      file: "src/daemon/webrtcStreamSocketServer.ts",
      fn: "handleStart",
      what: "webrtcStream start — gated before the WHIP publisher attaches to the device",
    },
    {
      file: "src/daemon/testRecordingSocketServer.ts",
      fn: "handleRequest",
      what: "testRecording start — gated before resolveDevice readies the runtime",
    },
  ];

  /**
   * Pure resolvers: they turn a serial into a `BootedDevice` and RETURN it,
   * acting on nothing. The gate belongs to the handler that receives the device —
   * `handleStart` above — which this file already pins, so gating here too would
   * only duplicate the refusal.
   */
  const RESOLVERS_ONLY: readonly string[] = [
    "src/daemon/webrtcStreamSocketServer.ts#resolveWebRtcStreamDevice",
  ];

  function stripComments(source: string): string {
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      /* skipTrivia */ false,
      ts.LanguageVariant.Standard,
      source,
    );
    let result = "";
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        continue;
      }
      result += scanner.getTokenText();
    }
    return result;
  }

  interface NamedFunction {
    readonly name: string;
    readonly body: string;
  }

  /** Every named function/method declaration in a file, with its body text. */
  function namedFunctions(file: string): NamedFunction[] {
    const source = ts.createSourceFile(
      file,
      readFileSync(join(ROOT, file), "utf8"),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
    );
    const found: NamedFunction[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isMethodDeclaration(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isPropertyDeclaration(node)) &&
        node.name !== undefined &&
        ts.isIdentifier(node.name)
      ) {
        found.push({ name: node.name.text, body: stripComments(node.getText(source)) });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return found;
  }

  test("the gate exists on the pool under its single name", () => {
    const pool = stripComments(readFileSync(join(ROOT, "src/daemon/devicePool.ts"), "utf8"));
    expect(pool).toMatch(new RegExp(`\\b${GATE}\\(deviceId: string, purpose: string\\): void`));
    // The session-keyed gate is a CALLER of the device gate, not a second gate.
    const sessionGate = pool.slice(pool.indexOf("assertSessionReadyForAutomation(sessionId"));
    expect(sessionGate.slice(0, sessionGate.indexOf("\n  }\n"))).toContain(GATE);
  });

  test("the stream server reaches the gate through the resolver it already holds", () => {
    const resolver = stripComments(
      readFileSync(join(ROOT, "src/daemon/deviceSessionResolver.ts"), "utf8"),
    );
    expect(resolver).toMatch(new RegExp(`${GATE}\\(deviceId: string, purpose: string\\): void;`));
  });

  test.each(GATED_HANDLERS.map((handler) => [handler.file, handler.fn, handler.what] as const))(
    "%s#%s gates %s",
    (file, fn) => {
      const target = namedFunctions(file).find((candidate) => candidate.name === fn);
      expect(target).toBeDefined();
      expect(target!.body).toContain(GATE);
    },
  );

  test("no device-addressed handler in a scanned socket server bypasses the gate", () => {
    const listed = new Set(GATED_HANDLERS.map((handler) => `${handler.file}#${handler.fn}`));
    const bypassing: string[] = [];
    for (const file of SCANNED) {
      for (const fn of namedFunctions(file)) {
        // "Device-addressed" = the function resolves a caller-supplied serial
        // against a discovery listing. That is the shape every bypass had.
        const addressesADevice =
          (/\bdeviceId\s*===/.test(fn.body) &&
            /getBootedDevices|requestObservation/.test(fn.body)) ||
          // The capture/recording shape: hand the caller-supplied serial to a
          // device resolver, then act on whatever comes back.
          /resolveDevice\(\s*request\.deviceId/.test(fn.body);
        if (!addressesADevice) {
          continue;
        }
        const key = `${file}#${fn.name}`;
        if (RESOLVERS_ONLY.includes(key)) {
          continue;
        }
        if (!listed.has(key) && !fn.body.includes(GATE)) {
          bypassing.push(key);
        }
      }
    }
    expect(bypassing).toEqual([]);
  });

  test("the scan actually recognises a bypassing handler", () => {
    // Mutation check: the detector above must fire on the shape of the original
    // bug — a handler that resolves an incoming deviceId and never gates it.
    const bypass =
      "const devices = await manager.getBootedDevices(platform);\n" +
      "const target = devices.find((d) => d.deviceId === request.deviceId);";
    expect(/\bdeviceId\s*===/.test(bypass) && /getBootedDevices/.test(bypass)).toBe(true);
    expect(bypass.includes(GATE)).toBe(false);
    // ... and on the capture/recording shape, which resolves the serial through a
    // device resolver instead of scanning a listing itself.
    const captureBypass =
      "const device = await deps.resolveDevice(request.deviceId);\n" +
      "const capture = await this.attach(socket, device, request);";
    expect(/resolveDevice\(\s*request\.deviceId/.test(captureBypass)).toBe(true);
    expect(captureBypass.includes(GATE)).toBe(false);
  });
});
