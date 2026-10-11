import { describe, expect, test } from "bun:test";
import { admitInputOnHolderSession } from "../../src/daemon/inputDeviceOwnership";
import { mcpRequestFailureDetails, strokeAdmissionEndedError } from "../../src/daemon/socketServer";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import { shapedRefusalResult } from "../helpers/refusalWireFixtures";

const SESSION = "11111111-2222-4333-8444-555555555555";
const DEVICE = "emulator-5554";

/**
 * An input refused because the session it was admitted for left the device is an ownership
 * refusal, so it carries the existing typed codes on every ingress it reaches (#11351): the
 * control socket failure frame (`input/*`, `ide/*`) and an MCP tool result.
 */
describe("an input whose holder changed is a typed refusal", () => {
  async function holderLeftDuringAdmission(): Promise<unknown> {
    const sessionManager = {
      admitIssuedSessionForAutomation: async () => ({ assignedDevice: "emulator-5556" }),
    };
    return admitInputOnHolderSession({
      deviceId: DEVICE,
      holderSessionUuid: SESSION,
      sessionManager,
      execution: { executionId: "input-1", startTime: 0 },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  test("admission that finds the holder on another device answers session_no_longer_owns_device", async () => {
    const error = await holderLeftDuringAdmission();

    expect((error as Error).message).toBe(
      `Session ${SESSION} no longer holds device '${DEVICE}'; the input was not sent.`,
    );
    expect(mcpRequestFailureDetails(error, undefined)).toEqual({
      code: "session_no_longer_owns_device",
      retryable: false,
    });
    expect(JSON.parse(shapedRefusalResult(error).content[0].text)).toMatchObject({
      success: false,
      code: "session_no_longer_owns_device",
      sessionUuid: SESSION,
      deviceId: DEVICE,
      retryable: false,
    });
  });

  test("a lifted gestureStart whose holder left answers session_no_longer_owns_device", () => {
    const error = strokeAdmissionEndedError("input/gestureStart", {
      deviceId: DEVICE,
      holderSessionId: SESSION,
    });

    expect((error as Error).message).toBe(
      `input/gestureStart on device '${DEVICE}' was lifted: session ${SESSION} no longer holds ` +
        "the device before the stroke's start was acknowledged.",
    );
    expect(mcpRequestFailureDetails(error, undefined)).toEqual({
      code: "session_no_longer_owns_device",
      retryable: false,
    });
  });

  test("a lifted sessionless gestureStart answers device_owned_by_other_session, like the frames after it", () => {
    const error = strokeAdmissionEndedError("input/gestureStart", { deviceId: DEVICE });

    expect((error as Error).message).toBe(
      `input/gestureStart on device '${DEVICE}' was lifted: a session acquired the device ` +
        "before the stroke's start was acknowledged.",
    );
    expect(mcpRequestFailureDetails(error, undefined)).toEqual({
      code: "device_owned_by_other_session",
      retryable: false,
      details: { deviceId: DEVICE },
    });
  });

  test("a release that aborted the frame still answers its own refusal", () => {
    const controller = new AbortController();
    const release = new SessionReleasedDuringCallError(SESSION, "explicit-release");
    controller.abort(release);

    expect(
      strokeAdmissionEndedError("input/gestureStart", {
        deviceId: DEVICE,
        holderSessionId: SESSION,
        signal: controller.signal,
      }),
    ).toBe(release);
  });
});
