import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync, Visitor, type Expression } from "oxc-parser";
import {
  INTERNAL_TOOL_PARAM_NAMES,
  INTERNAL_MCP_SESSION_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM,
} from "../../src/daemon/constants";
import {
  parseProvisionDeviceArgs,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { createAcquisitionHandlers } from "../../src/server/deviceToolsAcquisition";
import { createStartDeviceHandlers } from "../../src/server/deviceToolsStartDevice";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeTimer } from "../fakes/FakeTimer";

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
        file === "prototypeTools.ts" &&
        receiver.type === "Identifier" &&
        receiver.name === "devicePrototypeEntrySchema" &&
        first?.type === "Identifier" &&
        first.name === "entry"
      ) {
        return;
      }
      // The injected iOS agent's status reply, likewise not a tool argument.
      if (
        file === "prototypeTools.ts" &&
        receiver.type === "Identifier" &&
        receiver.name === "iosAgentStatusSchema" &&
        first?.type === "MemberExpression"
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

describe("handler internal metadata regression guard", () => {
  let offenders: string[];
  beforeAll(() => {
    const server = join(import.meta.dir, "../../src/server");
    const files = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: server }));
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
      const handlers = createAcquisitionHandlers({
        getBootAndPrepareDevice: () => async (args) => {
          calls.push(args);
          return createStructuredToolResponse({ message: "fake device boundary" });
        },
      });
      const args = Object.freeze({
        ...(name === "getAndroid" ? { avdName: "Fold" } : { udid: "fake-udid" }),
        ...metadata,
      });
      if (name === "getAndroid") {
        await handlers.getAndroidHandler(args);
      } else {
        await handlers.getAppleHandler(args);
      }
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        platform: name === "getAndroid" ? "android" : "ios",
        __mcpSessionId: "session",
        presentationOrder: "reverse",
      });
      expect(args).toMatchObject(metadata);
    },
  );

  test("startDevice accepts full metadata and retains the session before stripping", async () => {
    setDeviceToolsDependencies({ timer: new FakeTimer() });
    const acquisition = createAcquisitionHandlers({
      getBootAndPrepareDevice: () => {
        throw new Error("Unexpected boot");
      },
    });
    const calls: unknown[] = [];
    const handlers = createStartDeviceHandlers({
      stripInternalAcquisitionParams: (args) => {
        const external = acquisition.stripInternalAcquisitionParams(args);
        expect(external).toEqual({ platform: "android", avdName: "Fold" });
        return external;
      },
      prepareDevice: async (args) => {
        calls.push(args);
        return createStructuredToolResponse({ message: "fake preparation" });
      },
    });
    const args = Object.freeze({ platform: "android" as const, avdName: "Fold", ...metadata });
    await handlers.startDeviceHandler(args);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      platform: "android",
      name: "Fold",
      matchExactName: true,
      __mcpSessionId: "session",
    });
    expect(args).toMatchObject(metadata);
  });

  test("provisionDevice argument seam strips full metadata and preserves session/CLI marker/deadline", () => {
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
    expect(parseProvisionDeviceArgs(args)).toEqual({
      device: args.device,
      boot: true,
      readiness: "automation",
      __mcpSessionId: "session",
      // The one-shot CLI marker is preserved like the connection identity (#11096).
      __oneShotCli: true,
      __mcpRequestDeadlineMs: 90_000,
    });
    expect(args).toMatchObject(metadata);
  });
});
