import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync, Visitor, type Expression } from "oxc-parser";
import {
  INTERNAL_TOOL_PARAM_NAMES,
  INTERNAL_MCP_SESSION_PARAM,
  INTERNAL_ONE_SHOT_CLI_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM,
} from "../../src/daemon/wire/constants";
import {
  parseProvisionDeviceArgs,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { createAcquisitionHandlers } from "../../src/server/deviceToolsAcquisition";
import { createStartDeviceHandlers } from "../../src/server/deviceToolsStartDevice";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { ActionableError } from "../../src/models/ActionableError";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeTimer } from "../fakes/FakeTimer";
import { asMcpConnection } from "../helpers/mcpConnection";
import { currentAutolockMcpSessionId } from "../../src/features/toolSelection/toolSelectionContext";

const metadata = Object.freeze({
  ...Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, true])),
  [INTERNAL_MCP_SESSION_PARAM]: "session",
  [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: 90_000,
  [INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM]: "reverse",
});

// Conservatively guard ALL schema parses, including non-strict schemas that may
// become strict later. Scalar appId validation and built-in parsers are exempt.
// The acquisition wrapper is backed by the full-list runtime tests below.
function unsafeSchemaParses(file: string, source: string): string[] {
  const { program, errors } = parseSync(file, source);
  expect(errors).toEqual([]);
  const scopes: Set<string>[] = [new Set()];
  const offenders: string[] = [];
  const isClean = (node: Expression): boolean => {
    if (node.type === "Identifier") {
      return scopes.some((scope) => scope.has(node.name));
    }
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") {
      return false;
    }
    if (["stripInternalToolParams", "stripInternalAcquisitionParams"].includes(node.callee.name)) {
      return true;
    }
    const first = node.arguments[0];
    return (
      node.callee.name === "stripUndeclaredSessionUuid" &&
      !!first &&
      first.type !== "SpreadElement" &&
      isClean(first)
    );
  };
  new Visitor({
    BlockStatement() {
      scopes.push(new Set());
    },
    "BlockStatement:exit"() {
      scopes.pop();
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && node.init && isClean(node.init)) {
        scopes[scopes.length - 1].add(node.id.name);
      }
    },
    CallExpression(node) {
      const first = node.arguments[0];
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "deleteInternalToolParams" &&
        first?.type === "Identifier"
      ) {
        scopes[scopes.length - 1].add(first.name);
      }
      if (
        node.callee.type !== "MemberExpression" ||
        node.callee.computed ||
        node.callee.property.type !== "Identifier" ||
        !["parse", "safeParse", "parseAsync", "safeParseAsync"].includes(node.callee.property.name)
      ) {
        return;
      }
      const receiver = node.callee.object;
      if (receiver.type === "Identifier" && ["JSON", "Date"].includes(receiver.name)) {
        return;
      }
      if (
        file === "toolSchemaHelpers.ts" &&
        receiver.type === "Identifier" &&
        receiver.name === "appIdSchema" &&
        first?.type === "Identifier" &&
        first.name === "nestedValue"
      ) {
        return;
      }
      // Device-reported prototype entries parsed from an inspect reply are not tool
      // arguments, so there is no transport metadata to strip.
      if (
        file === "prototypeTools/inspection.ts" &&
        receiver.type === "Identifier" &&
        receiver.name === "devicePrototypeEntrySchema" &&
        first?.type === "Identifier" &&
        first.name === "entry"
      ) {
        return;
      }
      // The host-built test-session report, validated as JSON for the output envelope.
      if (
        file === "prototypeTools/testSession.ts" &&
        receiver.type === "Identifier" &&
        receiver.name === "hostReportSchema"
      ) {
        return;
      }
      // The injected iOS agent's status reply, likewise not a tool argument.
      if (
        file === "prototypeTools/inspection.ts" &&
        receiver.type === "Identifier" &&
        receiver.name === "iosAgentStatusSchema" &&
        first?.type === "MemberExpression"
      ) {
        return;
      }
      // The ambiguous-device refusal is a tool RESULT the dispatcher inspects, not tool arguments.
      if (
        file === "ambiguousDeviceElicitation.ts" &&
        receiver.type === "Identifier" &&
        ["refusalResultSchema", "textBlockSchema", "refusalPayloadSchema"].includes(receiver.name)
      ) {
        return;
      }
      // MRTR state is an SDK-verified continuation payload, not tool arguments.
      if (
        receiver.type === "Identifier" &&
        ((file === "ambiguousDeviceMrtr.ts" &&
          receiver.name === "deviceChoiceRequestStateSchema") ||
          (file === "deviceChoiceRequestState.ts" &&
            ["sealedStateSchema", "deviceChoiceRequestStateSchema"].includes(receiver.name)))
      ) {
        return;
      }
      if (!first || first.type === "SpreadElement" || !isClean(first)) {
        offenders.push(`${file}:${source.slice(0, node.start).split("\n").length}`);
      }
    },
  }).visit(program);
  return offenders;
}

/** The in-band keys only ingress reads, by constant name and wire key (#15663). */
const INGRESS_ONLY_KEYS = new Map([
  ["INTERNAL_MCP_SESSION_PARAM", INTERNAL_MCP_SESSION_PARAM],
  ["INTERNAL_ONE_SHOT_CLI_PARAM", INTERNAL_ONE_SHOT_CLI_PARAM],
]);
const INGRESS_ONLY_NAMES = new Set([...INGRESS_ONLY_KEYS.keys(), ...INGRESS_ONLY_KEYS.values()]);
const INGRESS_ONLY_WIRE_KEYS = new Set<unknown>(INGRESS_ONLY_KEYS.values());

/**
 * Every place outside comments that names an ingress-only key: its constant or the literal key.
 * Handlers read the connection and the one-shot marker from the ambient call context (#15663).
 */
function inBandConnectionReads(file: string, source: string): string[] {
  const { program, errors } = parseSync(file, source);
  expect(errors).toEqual([]);
  const offenders: string[] = [];
  const line = (start: number) => `${file}:${source.slice(0, start).split("\n").length}`;
  new Visitor({
    Identifier(node) {
      if (INGRESS_ONLY_NAMES.has(node.name)) {
        offenders.push(line(node.start));
      }
    },
    Literal(node) {
      if (INGRESS_ONLY_WIRE_KEYS.has(node.value)) {
        offenders.push(line(node.start));
      }
    },
  }).visit(program);
  // A shorthand `{ __mcpSessionId }` is both a key and a binding: report its line once.
  return [...new Set(offenders)];
}

describe("the in-band connection keys stay at the ingress boundary (#15663)", () => {
  // `parseCallContext` reads the forwarded wire key once; nothing past it may.
  const ALLOWED = new Set(["server/pipeline/ingress/callContext.ts"]);

  let offenders: string[];
  beforeAll(() => {
    const src = join(import.meta.dir, "../../src");
    const files = ["server", "features"].flatMap((dir) =>
      Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: join(src, dir) }), (file) =>
        `${dir}/${file}`.replaceAll("\\", "/"),
      ),
    );
    expect(files.length).toBeGreaterThan(0);
    offenders = files
      .filter((file) => !ALLOWED.has(file))
      .flatMap((file) => inBandConnectionReads(file, readFileSync(join(src, file), "utf8")));
  });

  test("no src/server or src/features file names __mcpSessionId or __oneShotCli outside ingress", () => {
    expect(offenders).toEqual([]);
  });

  test("the scan finds the constant and the literal key, and ignores comments", () => {
    expect(
      inBandConnectionReads(
        "fixture.ts",
        `
      // a comment naming __mcpSessionId is fine
      const a = args[INTERNAL_MCP_SESSION_PARAM];
      const b = args["__mcpSessionId"];
      const { __mcpSessionId } = args;
      // nor is one naming __oneShotCli
      const c = args[INTERNAL_ONE_SHOT_CLI_PARAM];
      const d = { __oneShotCli: true };
      const e = args["__oneShotCli"];
    `,
      ),
    ).toEqual([
      "fixture.ts:3",
      "fixture.ts:4",
      "fixture.ts:5",
      "fixture.ts:7",
      "fixture.ts:8",
      "fixture.ts:9",
    ]);
  });
});

describe("handler internal metadata regression guard", () => {
  let offenders: string[];
  beforeAll(() => {
    const server = join(import.meta.dir, "../../src/server");
    const files = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: server }), (file) =>
      file.replaceAll("\\", "/"),
    );
    expect(files.length).toBeGreaterThan(0);
    offenders = files.flatMap((file) =>
      unsafeSchemaParses(file, readFileSync(join(server, file), "utf8")),
    );
  });
  afterEach(resetDeviceToolsDependencies);

  test("every server schema re-parse strips canonical internal metadata", () => {
    expect(offenders).toEqual([]);
  });

  test("guard detects raw/hand-picked parses and accepts canonical stripping", () => {
    expect(
      unsafeSchemaParses(
        "fixture.ts",
        `
      const schema = z.object({}).strict();
      function bad(args) { return schema.parse(args); }
      function partial(args) { const copy = { ...args }; delete copy.__mcpSessionId; return schema.safeParse(copy); }
      function good(args) { const copy = { ...args }; deleteInternalToolParams(copy); return schema.parse(copy); }
      function wrapped(args) { return schema.parse(stripInternalAcquisitionParams(args)); }
    `,
      ),
    ).toHaveLength(2);
  });

  test.each(["getAndroid", "getApple"] as const)(
    "%s accepts full metadata and preserves session/presentation order",
    async (name) => {
      const timer = new FakeTimer();
      const manager = new FakeDeviceUtils();
      setDeviceToolsDependencies({
        timer,
        deviceManagerFactory: () => manager,
        deviceMatcherFactory: () => new FakeDeviceMatcher(),
        lifecycleCoordinator: new InMemoryVirtualDeviceLifecycleCoordinator(timer),
      });
      const calls: unknown[] = [];
      const bootConnections: (string | undefined)[] = [];
      const handlers = createAcquisitionHandlers({
        bootAndPrepareDevice: async (args) => {
          calls.push(args);
          bootConnections.push(currentAutolockMcpSessionId());
          throw new ActionableError("fake device boundary");
        },
      });
      const args = Object.freeze({
        ...(name === "getAndroid" ? { avdName: "Fold" } : { udid: "fake-udid" }),
        ...metadata,
      });
      const acquire = name === "getAndroid" ? handlers.getAndroidHandler : handlers.getAppleHandler;
      // Ingress runs the call under the connection the in-band key names (#15663).
      await expect(asMcpConnection("session", () => acquire(args))).rejects.toThrow(
        "fake device boundary",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        platform: name === "getAndroid" ? "android" : "ios",
        presentationOrder: "reverse",
      });
      // The rebuilt boot args no longer forward the key; the boot sees the ambient connection.
      expect(calls[0]).not.toHaveProperty("__mcpSessionId");
      expect(calls[0]).not.toHaveProperty("__oneShotCli");
      expect(bootConnections).toEqual(["session"]);
      expect(args).toMatchObject(metadata);
    },
  );

  test("startDevice accepts full metadata and prepares under the ambient session", async () => {
    setDeviceToolsDependencies({ timer: new FakeTimer() });
    const acquisition = createAcquisitionHandlers({
      bootAndPrepareDevice: async () => {
        throw new Error("Unexpected boot");
      },
    });
    const calls: unknown[] = [];
    const prepareConnections: (string | undefined)[] = [];
    const handlers = createStartDeviceHandlers({
      stripInternalAcquisitionParams: (args) => {
        const external = acquisition.stripInternalAcquisitionParams(args);
        expect(external).toEqual({ platform: "android", avdName: "Fold" });
        return external;
      },
      prepareDevice: async (args) => {
        calls.push(args);
        prepareConnections.push(currentAutolockMcpSessionId());
        return createStructuredToolResponse({ message: "fake preparation" });
      },
    });
    const args = Object.freeze({ platform: "android" as const, avdName: "Fold", ...metadata });
    await asMcpConnection("session", () => handlers.startDeviceHandler(args));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      platform: "android",
      name: "Fold",
      matchExactName: true,
    });
    // The rebuilt args no longer forward the key; preparation sees the ambient connection.
    expect(calls[0]).not.toHaveProperty("__mcpSessionId");
    expect(calls[0]).not.toHaveProperty("__oneShotCli");
    expect(prepareConnections).toEqual(["session"]);
    expect(args).toMatchObject(metadata);
  });

  test("provisionDevice argument seam strips full metadata, the in-band session and CLI marker, takes the request's deadline", () => {
    const args = Object.freeze({
      device: {
        platform: "ios" as const,
        name: "Phone",
        spec: {
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        },
      },
      ...metadata,
    });
    // The deadline comes from the request, never from an in-band key in the args (#15663).
    expect(parseProvisionDeviceArgs(args, { deadlineMs: 90_000, liveDeadlineKey: "live" })).toEqual(
      {
        device: args.device,
        boot: true,
        readiness: "automation",
        // The connection identity and the one-shot CLI marker are ambient, not carried in the
        // parsed args (#15663).
        transportDeadlineMs: 90_000,
        liveDeadlineKey: "live",
      },
    );
    expect(parseProvisionDeviceArgs(args, undefined)).not.toHaveProperty("__mcpSessionId");
    expect(parseProvisionDeviceArgs(args, undefined)).not.toHaveProperty("__oneShotCli");
    expect(parseProvisionDeviceArgs(args, undefined)).not.toHaveProperty("transportDeadlineMs");
    expect(args).toMatchObject(metadata);
  });

  test("provisionDevice ignores a caller-supplied deadline in favour of the request's", () => {
    const args = {
      device: {
        platform: "android" as const,
        name: "Pixel",
        spec: { runtime: "android-35", deviceType: "pixel_8" },
      },
      transportDeadlineMs: 1,
      liveDeadlineKey: "caller",
    };
    const parsed = parseProvisionDeviceArgs(args, { deadlineMs: 90_000 });
    expect(parsed.transportDeadlineMs).toBe(90_000);
    expect(parsed).not.toHaveProperty("liveDeadlineKey");
  });
});
