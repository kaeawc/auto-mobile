import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../../../src/server/toolRegistry";
import {
  APPLE_PLATFORM_SUPPORTED_TOOLS,
  platformCallableToolNames,
} from "../../../../src/server/applePlatformToolSupport";
import {
  enrichAcquiredSession,
  enrichProvisionDeviceResult,
} from "../../../../src/server/pipeline/ingress/acquisition";
import { getAnyDevicePlatformFromResult } from "../../../../src/daemon/deviceSessionResult";
import { isolateEmptyToolRegistry } from "../../../helpers/withTemporaryTool";

isolateEmptyToolRegistry();

// Verbatim `enabledTools` provisionDevice returned for a visionOS 26.5 session (#18013).
const ADVERTISED_ON_VISIONOS = [
  "appLifecycle",
  "crashApp",
  "homeScreen",
  "installApp",
  "keyboard",
  "killDevice",
  "launchApp",
  "listApps",
  "listDeviceImages",
  "listDevices",
  "observe",
  "pressButton",
  "provisionDevice",
  "putAppFile",
  "recentApps",
  "sendKeys",
  "setActiveDevice",
  "swipeOn",
  "tapAny",
  "tapAt",
  "tapOn",
  "terminateApp",
  "uninstallApp",
  "wakeAndUnlock",
];

// The plain tools in that list look up their own target; every other one is device-aware.
const PLAIN = new Set([
  "killDevice",
  "listDeviceImages",
  "listDevices",
  "provisionDevice",
  "setActiveDevice",
]);

// Each refused the same session with "<tool> does not support visionOS yet" in the issue.
const REFUSED_ON_VISIONOS = [
  "appLifecycle",
  "crashApp",
  "homeScreen",
  "keyboard",
  "pressButton",
  "putAppFile",
  "recentApps",
  "swipeOn",
  "tapAny",
  "tapAt",
  "wakeAndUnlock",
];

const CALLABLE_ON_VISIONOS = ADVERTISED_ON_VISIONOS.filter(
  (name) => !REFUSED_ON_VISIONOS.includes(name),
);

function registerAdvertisedTools(): void {
  ToolRegistry.clearTools();
  for (const name of ADVERTISED_ON_VISIONOS) {
    if (PLAIN.has(name)) {
      ToolRegistry.register(name, name, z.object({}), {
        handler: async () => ({ content: [] }),
        defaultEnabled: true,
      });
    } else {
      ToolRegistry.registerDeviceAware(name, name, z.object({}), {
        handler: async () => ({ content: [] }),
        defaultEnabled: true,
      });
    }
  }
}

const isDeviceAware = (name: string) => !PLAIN.has(name);

function provisionResult(platform: string) {
  const payload = {
    message: `${platform} 'vision-test' provisioned (booted)`,
    sessionId: "vision-session",
    device: { name: "vision-test", platform },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

const enabledEverywhere = { isEnabled: async () => true };

describe("acquisitions advertise only tools the device's platform admits (#18013)", () => {
  test("drops the device-aware tools visionOS refuses and keeps plain tools", () => {
    expect(
      platformCallableToolNames(ADVERTISED_ON_VISIONOS, "visionos", isDeviceAware).sort(),
    ).toEqual(CALLABLE_ON_VISIONOS);
    for (const name of CALLABLE_ON_VISIONOS) {
      expect(PLAIN.has(name) || APPLE_PLATFORM_SUPPORTED_TOOLS.visionos.has(name)).toBe(true);
    }
  });

  test("leaves Android and iOS lists untouched", () => {
    for (const platform of ["android", "ios"] as const) {
      expect(platformCallableToolNames(ADVERTISED_ON_VISIONOS, platform, isDeviceAware)).toEqual(
        ADVERTISED_ON_VISIONOS,
      );
    }
  });

  test("reads the platform a provisionDevice or startDevice result describes", () => {
    expect(getAnyDevicePlatformFromResult(provisionResult("visionos"))).toBe("visionos");
    expect(getAnyDevicePlatformFromResult(provisionResult("tvos"))).toBe("tvos");
    expect(getAnyDevicePlatformFromResult(provisionResult("symbian"))).toBeUndefined();
  });

  test("provisionDevice on visionOS reports only callable enabledTools", async () => {
    registerAdvertisedTools();
    const result = await enrichProvisionDeviceResult(
      "provisionDevice",
      provisionResult("visionos"),
      "vision-session",
      { service: enabledEverywhere, enableTools: [], connectionProfileUuid: undefined },
    );
    expect(result.structuredContent).toMatchObject({ enabledTools: CALLABLE_ON_VISIONOS });
    expect(JSON.parse(result.content[0]!.text!).enabledTools).toEqual(CALLABLE_ON_VISIONOS);
  });

  test("provisionDevice on iOS still reports every enabled tool", async () => {
    registerAdvertisedTools();
    const result = await enrichProvisionDeviceResult(
      "provisionDevice",
      provisionResult("ios"),
      "ios-session",
      { service: enabledEverywhere, enableTools: [], connectionProfileUuid: undefined },
    );
    expect(result.structuredContent).toMatchObject({ enabledTools: ADVERTISED_ON_VISIONOS });
  });

  test("startDevice on visionOS keeps refused tools out of enabledTools and gatedTools", async () => {
    registerAdvertisedTools();
    const payload = {
      platform: "visionos",
      runtime: { session: { sessionUuid: "vision-session" } },
    };
    const result = await enrichAcquiredSession({
      toolName: "startDevice",
      result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      acquiredSessionUuid: "vision-session",
      requestedEnableTools: [],
      sessionToolSelectionService: enabledEverywhere,
      listSessionTools: async () => ({
        tools: ADVERTISED_ON_VISIONOS.filter((name) => name !== "tapOn").map((name) => ({ name })),
      }),
      requestSignal: undefined,
    });
    const enriched = JSON.parse(result.content[0]!.text!);
    expect(enriched.enabledTools).toEqual(CALLABLE_ON_VISIONOS.filter((name) => name !== "tapOn"));
    expect(enriched.gatedTools).toEqual(["tapOn"]);
  });
});
