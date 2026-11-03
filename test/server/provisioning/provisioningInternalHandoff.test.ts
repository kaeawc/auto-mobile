import { describe, expect, test } from "bun:test";
import type { ProvisionDeviceArgs } from "../../../src/features/deviceLifecycle/deviceLifecycleCore";
import { readinessReservationOwner } from "../../../src/server/provisioning/provisioningReadiness";
import { provisionSessionArgs } from "../../../src/server/provisioning/provisioningSession";
import { asMcpConnection, asOneShotCli } from "../../helpers/mcpConnection";

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
  test("forwards the restart-resume handoff, never an in-band connection or one-shot marker", async () => {
    // A one-shot call's marker is ambient (#15663), so the session args never carry it.
    expect(
      await asOneShotCli(() =>
        provisionSessionArgs(
          provisionArgs({
            __restartResumeTargets: targets,
            __restartResumeSessionUuid: "resume-1",
          }),
        ),
      ),
    ).toEqual({
      platform: "android",
      name: "Pixel_9",
      matchExactName: true,
      timeoutMs: 1000,
      __restartResumeTargets: targets,
      __restartResumeSessionUuid: "resume-1",
    });
  });
});

describe("readinessReservationOwner", () => {
  test("a one-shot CLI call reserves anonymously, even under a connection", async () => {
    expect(await asOneShotCli(() => readinessReservationOwner({}), "mcp-1")).toEqual({
      oneShotCli: true,
    });
  });

  test("an in-band one-shot marker is ignored", async () => {
    expect(
      await asMcpConnection("mcp-1", () => readinessReservationOwner({ __oneShotCli: true })),
    ).toEqual({ mcpSessionId: "mcp-1" });
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
