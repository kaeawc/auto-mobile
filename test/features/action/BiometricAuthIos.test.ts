import { expect, describe, test, beforeEach, spyOn } from "bun:test";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import { BiometricAuth } from "../../../src/features/action/BiometricAuth";
import { BootedDevice } from "../../../src/models";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIosSdkTriggerSender } from "../../fakes/FakeIosSdkTriggerSender";

const SIM_UDID = "11111111-2222-3333-4444-555555555555";
const PHYSICAL_UDID = "00008030001A2B3C4D5E6F7089ABCDEF01234567";

const ENROLL = "com.apple.BiometricKit.enrollmentChanged";
const TOUCH_MATCH = "com.apple.BiometricKit_Sim.fingerTouch.match";
const TOUCH_NOMATCH = "com.apple.BiometricKit_Sim.fingerTouch.nomatch";
const PEARL_MATCH = "com.apple.BiometricKit_Sim.pearl.match";
const PEARL_NOMATCH = "com.apple.BiometricKit_Sim.pearl.nomatch";
const ENROLL_GET_COMMAND = `spawn ${SIM_UDID} notifyutil -g ${ENROLL}`;
const ENROLL_COMMAND = `spawn ${SIM_UDID} notifyutil -1 ${ENROLL} -s ${ENROLL} 1 -g ${ENROLL} -p ${ENROLL}`;
const UNENROLL_COMMAND = `spawn ${SIM_UDID} notifyutil -1 ${ENROLL} -s ${ENROLL} 0 -g ${ENROLL} -p ${ENROLL}`;

describe("BiometricAuth - iOS Simulator", () => {
  let simctl: FakeSimCtlClient;
  let timer: FakeTimer;
  // The app under test does not embed the AutoMobile SDK, so every call falls back to simctl.
  let noSdk: FakeIosSdkTriggerSender;

  const makeDevice = (deviceId: string): BootedDevice =>
    ({ deviceId, platform: "ios" }) as BootedDevice;

  const commands = (): string[] =>
    simctl.getMethodCalls("executeCommand").map((c) => String(c.command));

  beforeEach(() => {
    simctl = new FakeSimCtlClient();
    simctl.setCommandResult(ENROLL_GET_COMMAND, `${ENROLL} 1\n`);
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    noSdk = new FakeIosSdkTriggerSender();
    noSdk.result = { success: false, available: false, totalTimeMs: 0, error: "no SDK" };
  });

  test("match + fingerprint preserves enrollment then posts fingerTouch.match", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);
    const result = await auth.execute({ action: "match", modality: "fingerprint" });

    expect(result.success).toBe(true);
    expect(result.supported).toBe(true);
    expect(commands()).toEqual([
      ENROLL_GET_COMMAND,
      `spawn ${SIM_UDID} notifyutil -p ${TOUCH_MATCH}`,
    ]);
    expect(simctl.getMethodCalls("executeCommand")[0]?.timeoutMs).toBeUndefined();
  });

  test("match + face posts pearl.match", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);
    const result = await auth.execute({ action: "match", modality: "face" });

    expect(result.success).toBe(true);
    expect(commands()).toContain(`spawn ${SIM_UDID} notifyutil -p ${PEARL_MATCH}`);
    expect(commands()).not.toContain(`spawn ${SIM_UDID} notifyutil -p ${TOUCH_MATCH}`);
  });

  test("match + any posts BOTH fingerTouch and pearl match (works on either biometry)", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);
    const result = await auth.execute({ action: "match" });

    expect(result.success).toBe(true);
    expect(result.modality).toBe("any");
    expect(commands()).toContain(`spawn ${SIM_UDID} notifyutil -p ${TOUCH_MATCH}`);
    expect(commands()).toContain(`spawn ${SIM_UDID} notifyutil -p ${PEARL_MATCH}`);
  });

  test("fail + fingerprint posts fingerTouch.nomatch", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);
    const result = await auth.execute({ action: "fail", modality: "fingerprint" });

    expect(result.success).toBe(true);
    expect(commands()).toContain(`spawn ${SIM_UDID} notifyutil -p ${TOUCH_NOMATCH}`);
  });

  test("fail + face posts pearl.nomatch", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);
    await auth.execute({ action: "fail", modality: "face" });
    expect(commands()).toContain(`spawn ${SIM_UDID} notifyutil -p ${PEARL_NOMATCH}`);
  });

  test("enroll explicitly sets and verifies iOS Simulator enrollment", async () => {
    simctl.setCommandResult(ENROLL_COMMAND, `${ENROLL} 1\n${ENROLL}\n`);
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);

    const result = await auth.execute({ action: "enroll" });

    expect(result.success).toBe(true);
    expect(result.action).toBe("enroll");
    expect(commands()).toEqual([ENROLL_COMMAND]);
  });

  test("unenroll explicitly clears and verifies iOS Simulator enrollment", async () => {
    simctl.setCommandResult(UNENROLL_COMMAND, `${ENROLL} 0\n${ENROLL}\n`);
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);

    const result = await auth.execute({ action: "unenroll" });

    expect(result.success).toBe(true);
    expect(result.action).toBe("unenroll");
    expect(commands()).toEqual([UNENROLL_COMMAND]);
  });

  test.each([
    { supported: false, error: "enrollment unsupported" },
    { supported: true, error: "enrollment failed" },
    { supported: true, enrollment: "not_enrolled" as const, verified: false },
  ])("reports unsuccessful enrollment state: %j", async (state) => {
    const setter = spyOn(DeviceState.prototype, "setBiometricEnrollmentState").mockResolvedValue(
      state,
    );
    try {
      const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);
      const result = await auth.execute({
        action: "enroll",
        modality: "face",
        fingerprintId: 3,
        errorCode: 7,
      });
      expect(result).toMatchObject({
        success: false,
        supported: state.supported,
        action: "enroll",
        modality: "face",
        fingerprintId: 3,
        errorCode: 7,
      });
      expect(result.error).toBe(state.error);
      expect(result.message).toBe(
        state.error ? undefined : "Biometric enrollment set to not_enrolled.",
      );
      expect(setter.mock.calls).toEqual([["enrolled"]]);
      expect(commands()).toEqual([]);
    } finally {
      setter.mockRestore();
    }
  });

  test("physical iOS device is unsupported (no public injection API)", async () => {
    const auth = new BiometricAuth(makeDevice(PHYSICAL_UDID), null, timer, simctl, () => noSdk);
    const result = await auth.execute({ action: "match", modality: "face" });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.error).toContain("physical iOS device");
    expect(commands()).toHaveLength(0);
  });

  test("cancel is partial on iOS (no simctl equivalent)", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);
    const result = await auth.execute({ action: "cancel" });

    expect(result.success).toBe(false);
    expect(result.supported).toBe("partial");
    expect(commands()).toHaveLength(0);
  });

  test("error is partial on iOS (no simctl equivalent)", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);
    const result = await auth.execute({ action: "error", errorCode: 7 });

    expect(result.success).toBe(false);
    expect(result.supported).toBe("partial");
  });

  test("notifyutil stderr surfaces as failure", async () => {
    simctl.setCommandResult(
      `spawn ${SIM_UDID} notifyutil -p ${TOUCH_MATCH}`,
      "",
      "notifyutil: command not found",
    );
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);
    const result = await auth.execute({ action: "match", modality: "fingerprint" });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(true);
    expect(result.error).toContain("notifyutil failed");
  });

  test("enrollment read failure surfaces before posting biometric event", async () => {
    simctl.setCommandResult(ENROLL_GET_COMMAND, "", "notifyutil: enrollment unavailable");
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);
    const result = await auth.execute({ action: "match", modality: "fingerprint" });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(true);
    expect(result.error).toContain("notifyutil failed");
    expect(commands()).toEqual([ENROLL_GET_COMMAND]);
  });

  test("unenrolled state prevents match without silently enrolling", async () => {
    simctl.setCommandResult(ENROLL_GET_COMMAND, `${ENROLL} 0\n`);
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);
    const result = await auth.execute({ action: "match", modality: "fingerprint" });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(true);
    expect(result.error).toContain("not enrolled");
    expect(commands()).toEqual([ENROLL_GET_COMMAND]);
  });

  test("thrown simctl error is caught and reported", async () => {
    simctl.setCommandError(ENROLL_GET_COMMAND, new Error("simctl unavailable"));
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl, () => noSdk);
    const result = await auth.execute({ action: "match", modality: "fingerprint" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("simctl unavailable");
  });
});

describe("BiometricAuth - iOS in-app SDK trigger route (#1580)", () => {
  let simctl: FakeSimCtlClient;
  let timer: FakeTimer;
  let sdk: FakeIosSdkTriggerSender;

  const makeDevice = (deviceId: string): BootedDevice =>
    ({ deviceId, platform: "ios" }) as BootedDevice;
  const makeAuth = (deviceId: string = SIM_UDID) =>
    new BiometricAuth(makeDevice(deviceId), null, timer, simctl, () => sdk);
  const commands = (): string[] =>
    simctl.getMethodCalls("executeCommand").map((c) => String(c.command));

  beforeEach(() => {
    simctl = new FakeSimCtlClient();
    simctl.setCommandResult(ENROLL_GET_COMMAND, `${ENROLL} 1\n`);
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    sdk = new FakeIosSdkTriggerSender();
  });

  test.each([
    { action: "match" as const, result: "SUCCESS" },
    { action: "fail" as const, result: "FAILURE" },
    { action: "cancel" as const, result: "CANCEL" },
  ])("$action arms the SDK override with the Android broadcast fields", async (c) => {
    await makeAuth().execute({ action: c.action, modality: "fingerprint" });

    expect(sdk.requests).toEqual([
      { module: "biometrics", trigger: "override", payload: { result: c.result, ttlMs: 5000 } },
    ]);
  });

  test("error forwards errorCode and ttlMs without a simctl event", async () => {
    const result = await makeAuth().execute({ action: "error", errorCode: 7, ttlMs: 9000 });

    expect(sdk.requests[0]?.payload).toEqual({ result: "ERROR", ttlMs: 9000, errorCode: 7 });
    expect(result).toMatchObject({ success: true, supported: true, action: "error" });
    expect(result.message).toContain("consumeOverride()");
    expect(commands()).toEqual([]);
  });

  test("cancel succeeds through the SDK on the Simulator without a simctl event", async () => {
    const result = await makeAuth().execute({ action: "cancel" });

    expect(result).toMatchObject({ success: true, supported: true });
    expect(commands()).toEqual([]);
  });

  test("match with the SDK also posts the BiometricKit event to complete a system prompt", async () => {
    const result = await makeAuth().execute({ action: "match", modality: "fingerprint" });

    expect(result).toMatchObject({ success: true, supported: true });
    expect(commands()).toEqual([
      ENROLL_GET_COMMAND,
      `spawn ${SIM_UDID} notifyutil -p ${TOUCH_MATCH}`,
    ]);
    expect(result.message).toContain("override armed");
    expect(result.message).toContain(TOUCH_MATCH);
  });

  test("an armed override still succeeds when the simulator event cannot be posted", async () => {
    simctl.setCommandResult(ENROLL_GET_COMMAND, `${ENROLL} 0\n`);
    const result = await makeAuth().execute({ action: "fail", modality: "face" });

    expect(result).toMatchObject({ success: true, supported: true });
    expect(result.message).toContain("BiometricKit event was not posted");
    expect(result.message).toContain("not enrolled");
  });

  test("a physical iOS device is supported through the SDK, with no simctl", async () => {
    const result = await makeAuth(PHYSICAL_UDID).execute({ action: "match", modality: "face" });

    expect(result).toMatchObject({ success: true, supported: true });
    expect(sdk.requests).toHaveLength(1);
    expect(commands()).toEqual([]);
  });

  test.each([
    { name: "no SDK in the app", result: { available: false } },
    { name: "runner predates the command", result: { available: false, unsupported: true } },
    {
      name: "SDK without the biometrics module",
      result: { available: true, sdkError: "module_not_registered" },
    },
    {
      name: "SDK without the override trigger",
      result: { available: true, sdkError: "unknown_trigger" },
    },
  ])("falls back to simctl when $name", async (c) => {
    sdk.result = { success: false, totalTimeMs: 0, ...c.result };
    const result = await makeAuth().execute({ action: "match", modality: "fingerprint" });

    expect(result).toMatchObject({ success: true, supported: true });
    expect(commands()).toEqual([
      ENROLL_GET_COMMAND,
      `spawn ${SIM_UDID} notifyutil -p ${TOUCH_MATCH}`,
    ]);
    expect(result.message).not.toContain("override armed");
  });

  test("a thrown runner error falls back to simctl", async () => {
    sdk.error = new Error("socket closed");
    const result = await makeAuth().execute({ action: "fail", modality: "fingerprint" });

    expect(result.success).toBe(true);
    expect(commands()).toContain(`spawn ${SIM_UDID} notifyutil -p ${TOUCH_NOMATCH}`);
  });

  test("without the SDK, cancel stays partial and explains the missing SDK route", async () => {
    sdk.result = { success: false, available: false, totalTimeMs: 0 };
    const result = await makeAuth().execute({ action: "cancel" });

    expect(result).toMatchObject({ success: false, supported: "partial" });
    expect(result.error).toContain("requires the app under test to embed the AutoMobile iOS SDK");
  });

  test("without the SDK, a physical device stays unsupported", async () => {
    sdk.result = { success: false, available: false, totalTimeMs: 0 };
    const result = await makeAuth(PHYSICAL_UDID).execute({ action: "match" });

    expect(result).toMatchObject({ success: false, supported: false });
    expect(result.error).toContain("physical iOS device");
    expect(commands()).toEqual([]);
  });

  test.each([
    {
      name: "rejected payload",
      result: { sdkError: "invalid_payload", reason: "invalid_ttl_ms" },
      text: "invalid_ttl_ms",
    },
    {
      name: "timeout after delivery",
      result: { error: "Timeout waiting for sdk_trigger_result" },
      text: "Timeout",
    },
  ])("an SDK $name fails without double-applying through simctl", async (c) => {
    sdk.result = { success: false, available: true, totalTimeMs: 0, ...c.result };
    const result = await makeAuth().execute({ action: "match", ttlMs: 1 });

    expect(result).toMatchObject({ success: false, supported: true });
    expect(result.error).toStartWith("biometricAuth on iOS");
    expect(result.error).toContain(c.text);
    expect(commands()).toEqual([]);
  });

  test("enroll never consults the SDK", async () => {
    simctl.setCommandResult(ENROLL_COMMAND, `${ENROLL} 1\n${ENROLL}\n`);
    await makeAuth().execute({ action: "enroll" });

    expect(sdk.requests).toEqual([]);
    expect(commands()).toEqual([ENROLL_COMMAND]);
  });
});
