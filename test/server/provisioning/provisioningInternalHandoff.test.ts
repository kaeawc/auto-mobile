import { describe, expect, test } from "bun:test";
import type { ProvisionDeviceArgs } from "../../../src/features/deviceLifecycle/deviceLifecycleCore";
import { readinessReservationOwner } from "../../../src/server/provisioning/provisioningReadiness";
import { provisionSessionArgs } from "../../../src/server/provisioning/provisioningSession";
import { asMcpConnection } from "../../helpers/mcpConnection";

// The handoff a provision passes to its session bind and readiness reservation. The connection
// identity is ambient, never an in-band arg (#15663).

const targets = [] as NonNullable<ProvisionDeviceArgs["__restartResumeTargets"]>;

function provisionArgs(extra: Partial<ProvisionDeviceArgs> = {}): ProvisionDeviceArgs {
  return {
    device: { platform: "android", name: "Pixel_9" },
    timeoutMs: 1000,
    ...extra,
  } as ProvisionDeviceArgs;
}

describe("provisionSessionArgs", () => {
  test("forwards the restart-resume handoff and one-shot marker, never an in-band connection", () => {
    expect(
      provisionSessionArgs(
        provisionArgs({
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
  test("a one-shot CLI call reserves anonymously, even under a connection", async () => {
    expect(
      await asMcpConnection("mcp-1", () => readinessReservationOwner({ __oneShotCli: true })),
    ).toEqual({ oneShotCli: true });
  });

  test("a connection call reserves for its ambient MCP connection", async () => {
    expect(await asMcpConnection("mcp-1", () => readinessReservationOwner({}))).toEqual({
      mcpSessionId: "mcp-1",
    });
  });

  test("an in-band connection id is ignored", () => {
    expect(readinessReservationOwner({ __mcpSessionId: "mcp-1" })).toBeUndefined();
  });

  test("a call with neither reserves for no one", async () => {
    expect(readinessReservationOwner({})).toBeUndefined();
    expect(await asMcpConnection("", () => readinessReservationOwner({}))).toBeUndefined();
  });
});
