import { expect, describe, test, beforeEach } from "bun:test";
import { BiometricAuth } from "../../../src/features/action/BiometricAuth";
import { BootedDevice } from "../../../src/models";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const SIM_UDID = "11111111-2222-3333-4444-555555555555";
const PHYSICAL_UDID = "00008030001A2B3C4D5E6F7089ABCDEF01234567";

const ENROLL = "com.apple.BiometricKit.enrollmentChanged";
const TOUCH_MATCH = "com.apple.BiometricKit_Sim.fingerTouch.match";
const TOUCH_NOMATCH = "com.apple.BiometricKit_Sim.fingerTouch.nomatch";
const PEARL_MATCH = "com.apple.BiometricKit_Sim.pearl.match";
const PEARL_NOMATCH = "com.apple.BiometricKit_Sim.pearl.nomatch";

describe("BiometricAuth - iOS Simulator", () => {
  let simctl: FakeSimCtlClient;
  let timer: FakeTimer;

  const makeDevice = (deviceId: string): BootedDevice =>
    ({ deviceId, platform: "ios" } as BootedDevice);

  const commands = (): string[] =>
    simctl.getMethodCalls("executeCommand").map(c => String(c.command));

  beforeEach(() => {
    simctl = new FakeSimCtlClient();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  test("match + fingerprint posts enrollment then fingerTouch.match", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
    const result = await auth.execute({ action: "match", modality: "fingerprint" });

    expect(result.success).toBe(true);
    expect(result.supported).toBe(true);
    expect(commands()).toEqual([
      `spawn ${SIM_UDID} notifyutil -s ${ENROLL} 1`,
      `spawn ${SIM_UDID} notifyutil -p ${ENROLL}`,
      `spawn ${SIM_UDID} notifyutil -p ${TOUCH_MATCH}`,
    ]);
  });

  test("match + face posts pearl.match", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
    const result = await auth.execute({ action: "match", modality: "face" });

    expect(result.success).toBe(true);
    expect(commands()).toContain(`spawn ${SIM_UDID} notifyutil -p ${PEARL_MATCH}`);
    expect(commands()).not.toContain(`spawn ${SIM_UDID} notifyutil -p ${TOUCH_MATCH}`);
  });

  test("match + any posts BOTH fingerTouch and pearl match (works on either biometry)", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
    const result = await auth.execute({ action: "match" });

    expect(result.success).toBe(true);
    expect(result.modality).toBe("any");
    expect(commands()).toContain(`spawn ${SIM_UDID} notifyutil -p ${TOUCH_MATCH}`);
    expect(commands()).toContain(`spawn ${SIM_UDID} notifyutil -p ${PEARL_MATCH}`);
  });

  test("fail + fingerprint posts fingerTouch.nomatch", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
    const result = await auth.execute({ action: "fail", modality: "fingerprint" });

    expect(result.success).toBe(true);
    expect(commands()).toContain(`spawn ${SIM_UDID} notifyutil -p ${TOUCH_NOMATCH}`);
  });

  test("fail + face posts pearl.nomatch", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
    await auth.execute({ action: "fail", modality: "face" });
    expect(commands()).toContain(`spawn ${SIM_UDID} notifyutil -p ${PEARL_NOMATCH}`);
  });

  test("physical iOS device is unsupported (no public injection API)", async () => {
    const auth = new BiometricAuth(makeDevice(PHYSICAL_UDID), null, timer, simctl);
    const result = await auth.execute({ action: "match", modality: "face" });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.error).toContain("physical iOS device");
    expect(commands()).toHaveLength(0);
  });

  test("cancel is partial on iOS (no simctl equivalent)", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
    const result = await auth.execute({ action: "cancel" });

    expect(result.success).toBe(false);
    expect(result.supported).toBe("partial");
    expect(commands()).toHaveLength(0);
  });

  test("error is partial on iOS (no simctl equivalent)", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
    const result = await auth.execute({ action: "error", errorCode: 7 });

    expect(result.success).toBe(false);
    expect(result.supported).toBe("partial");
  });

  test("notifyutil stderr surfaces as failure", async () => {
    simctl.setCommandResult(
      `spawn ${SIM_UDID} notifyutil -p ${TOUCH_MATCH}`,
      "",
      "notifyutil: command not found"
    );
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
    const result = await auth.execute({ action: "match", modality: "fingerprint" });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(true);
    expect(result.error).toContain("notifyutil failed");
  });

  test("thrown simctl error is caught and reported", async () => {
    simctl.setCommandError(
      `spawn ${SIM_UDID} notifyutil -s ${ENROLL} 1`,
      new Error("simctl unavailable")
    );
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
    const result = await auth.execute({ action: "match", modality: "fingerprint" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to post iOS biometric notification");
  });
});
