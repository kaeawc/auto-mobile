import ts from "typescript";
import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * FUNNEL 2 guard: every device-addressed operation — with OR without a session —
 * must pass the single admission gate `DevicePool.assertDeviceActionable`, which
 * refuses a serial whose pooled identity is quarantined.
 *
 * Coverage comes from the SEAM, not from the inventory below. Four review rounds
 * of gating entry points one at a time each found another route that reached a
 * device without crossing the one just gated — a sessionless tool call, a
 * resource read, a stream resolver, a fan-out target. So the gate sits where
 * every Android device-addressed operation converges: binding a serial to a
 * device client, which is `AdbClientFactory.create(device)` and the memoizing
 * `AndroidCtrlProxyClient.getInstance(device)`. Android-only is complete
 * coverage rather than a gap, because `DevicePool.hasReusableSerial` restricts
 * the quarantine to Android emulator serials
 * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
 *
 * The socket-handler inventory below is kept because those gates refuse EARLIER
 * and with a purpose-specific message — before a capture source is created,
 * before an observation is taken and acked with no frames — not because the seam
 * needs them.
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

  function walkSrc(dir: string = join(ROOT, "src"), files: string[] = []): string[] {
    // withFileTypes, not a statSync per entry: one syscall for the whole
    // directory instead of one per file across ~1000 files in src/.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkSrc(full, files);
      } else if (entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
    return files;
  }

  /**
   * Socket servers that accept device-addressed requests from clients. The
   * capture and recording servers are here because authorization is NOT this
   * gate: the quarantine deliberately preserves the owning session, so an
   * authorized subscribe/start still passes and would capture whichever
   * replacement AVD now answers on the serial
   * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
   */
  const SCANNED = [
    "src/daemon/daemon.ts",
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
      file: "src/daemon/daemon.ts",
      fn: "applyStorageSubscriptionRequest",
      what:
        "each target an all-device subscribe_storage expands to — the request names no serial, " +
        "so the socket server's preflight cannot run",
    },
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
   * Resolvers: they turn a serial into a `BootedDevice` and RETURN it, acting on
   * nothing. The gate belongs to the handler that receives the device —
   * `handleStart` above — which this file already pins, so gating here too would
   * only duplicate the refusal. What a resolver running its OWN discovery DOES
   * owe is FUNNEL 1: `deviceDiscoveryReconcileFunnel.test.ts` pins that this one
   * folds its observation in, so the handler's gate reads the state this
   * discovery established ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
   */
  const RESOLVERS_ONLY: readonly string[] = [
    "src/daemon/webrtcStreamSocketServer.ts#resolveWebRtcStreamDevice",
  ];

  /**
   * Replace every comment's characters with spaces, in place, so a mention in
   * prose ("see `getBootedDevices`") is not counted as a call site while every
   * OFFSET in the file stays exactly where it was. Preserving offsets is what
   * lets the real parser run on the untouched source and still read
   * comment-free body text: handing the parser a shortened, scanner-rewritten
   * copy silently dropped declarations, because a bare scanner cannot tell a
   * regex literal from division.
   */
  function blankComments(source: string): string {
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      /* skipTrivia */ false,
      ts.LanguageVariant.Standard,
      source,
    );
    const out = source.split("");
    let offset = 0;
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      const text = scanner.getTokenText();
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        for (let index = offset; index < offset + text.length; index += 1) {
          // Newlines survive so line structure — and any assertion that reads
          // it — is unchanged.
          if (out[index] !== "\n" && out[index] !== "\r") {
            out[index] = " ";
          }
        }
      }
      offset += text.length;
    }
    return out.join("");
  }

  interface NamedFunction {
    readonly name: string;
    readonly body: string;
  }

  const functionCache = new Map<string, NamedFunction[]>();

  /**
   * Every named function/method declaration in a file, with its body text.
   *
   * Comments are blanked ONCE for the whole file and each body is sliced out of
   * that offset-preserving copy, so every body is comment-free for one scanner
   * pass instead of one per function — the per-function form blew the 100ms
   * per-test budget on CI for a file the size of `socketServer.ts`. The
   * per-file result is memoized for the same reason: the handler table below
   * reads the same file several times.
   */
  function namedFunctions(file: string): NamedFunction[] {
    const cached = functionCache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const text = readFileSync(join(ROOT, file), "utf8");
    const blanked = blankComments(text);
    const source = ts.createSourceFile(
      file,
      text,
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
        found.push({
          name: node.name.text,
          body: blanked.slice(node.getStart(source), node.getEnd()),
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    functionCache.set(file, found);
    return found;
  }

  // Parsing the scanned socket servers is a fixture shared by every assertion
  // below, not work any one of them owns.
  beforeAll(() => {
    for (const file of SCANNED) {
      namedFunctions(file);
    }
  });

  test("the gate exists on the pool under its single name", () => {
    const pool = blankComments(readFileSync(join(ROOT, "src/daemon/devicePool.ts"), "utf8"));
    expect(pool).toMatch(new RegExp(`\\b${GATE}\\(deviceId: string, purpose: string\\): void`));
    // The session-keyed gate is a CALLER of the device gate, not a second gate.
    const sessionGate = pool.slice(pool.indexOf("assertSessionReadyForAutomation(sessionId"));
    expect(sessionGate.slice(0, sessionGate.indexOf("\n  }\n"))).toContain(GATE);
  });

  test("the stream server reaches the gate through the resolver it already holds", () => {
    const resolver = blankComments(
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

  /**
   * The seam itself: one gate, at the only place a serial becomes a device
   * client. Pinned by source scan for the same reason as everything else here —
   * "gate before you bind" is an ordering obligation no signature expresses.
   */
  test("the adb client factory gates every device-bound client", () => {
    const factory = blankComments(
      readFileSync(join(ROOT, "src/utils/android-cmdline-tools/AdbClientFactory.ts"), "utf8"),
    );
    expect(factory).toContain(`daemonDeviceAdmissionGate.${GATE}(device.deviceId`);
    // ... and the escape hatch the quarantine's own machinery needs is a
    // SEPARATE export, so reaching it is a deliberate act.
    expect(factory).toMatch(/export const unadmittedAdbClientFactory: AdbClientFactory/);
  });

  test("the memoizing CtrlProxy client resolution gates too", () => {
    // `getInstance` caches per serial, so a client built before the quarantine
    // would be handed back without the factory seam being crossed again.
    const client = blankComments(
      readFileSync(join(ROOT, "src/features/observe/android/AndroidCtrlProxyClient.ts"), "utf8"),
    );
    const getInstance = client.slice(client.indexOf("public static getInstance("));
    expect(getInstance.slice(0, getInstance.indexOf("\n  }\n"))).toContain(
      `daemonDeviceAdmissionGate.${GATE}(device.deviceId`,
    );
  });

  test("only the identity, lifecycle and teardown machinery is below the seam", () => {
    // Discovery reading the AVD name on a quarantined serial is the only event
    // that can LIFT the quarantine, and `emu kill` is how the pool settles a
    // serial it can no longer identify. Everything else in src/ binds through
    // the gated factory.
    const users: string[] = [];
    for (const file of walkSrc()) {
      if (!readFileSync(file).includes("unadmittedAdbClientFactory")) {
        continue;
      }
      users.push(relative(ROOT, file).split(sep).join("/"));
    }
    expect(users.sort()).toEqual([
      "src/utils/android-cmdline-tools/AdbClientFactory.ts",
      "src/utils/android-cmdline-tools/AndroidEmulatorClient.ts",
    ]);
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
