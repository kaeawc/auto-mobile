import { describe, expect, test } from "bun:test";
import type { ProvisionDeviceArgs } from "../../../src/features/deviceLifecycle/deviceLifecycleCore";
import { readinessReservationOwner } from "../../../src/server/provisioning/provisioningReadiness";
import { provisionSessionArgs } from "../../../src/server/provisioning/provisioningSession";

// The in-band handoff a provision passes to its session bind and readiness reservation (#15663).

const targets = [] as NonNullable<ProvisionDeviceArgs["__restartResumeTargets"]>;

function provisionArgs(extra: Partial<ProvisionDeviceArgs> = {}): ProvisionDeviceArgs {
  return {
    device: { platform: "android", name: "Pixel_9" },
    timeoutMs: 1000,
    ...extra,
  } as ProvisionDeviceArgs;
}

describe("provisionSessionArgs", () => {
  test("forwards the caller's connection, restart-resume handoff and one-shot marker", () => {
    expect(
      provisionSessionArgs(
        provisionArgs({
          __mcpSessionId: "mcp-1",
          __restartResumeTargets: targets,
          __restartResumeSessionUuid: "resume-1",
          __oneShotCli: true,
        }),
      ),
    ).toEqual({
      platform: "android",
      name: "Pixel_9",
      matchExactName: true,
      timeoutMs: 1000,
      __mcpSessionId: "mcp-1",
      __restartResumeTargets: targets,
      __restartResumeSessionUuid: "resume-1",
      __oneShotCli: true,
    });
  });

  test("omits the one-shot marker for a connection-owned call", () => {
    expect(provisionSessionArgs(provisionArgs())).not.toHaveProperty("__oneShotCli");
  });
});

describe("readinessReservationOwner", () => {
  test("a one-shot CLI call reserves anonymously, even with a connection id", () => {
    expect(readinessReservationOwner({ __oneShotCli: true, __mcpSessionId: "mcp-1" })).toEqual({
      oneShotCli: true,
    });
  });

  test("a connection call reserves for its MCP connection", () => {
    expect(readinessReservationOwner({ __mcpSessionId: "mcp-1" })).toEqual({
      mcpSessionId: "mcp-1",
    });
  });

  test("a call with neither reserves for no one", () => {
    expect(readinessReservationOwner({})).toBeUndefined();
    expect(readinessReservationOwner({ __mcpSessionId: "" })).toBeUndefined();
  });
});
