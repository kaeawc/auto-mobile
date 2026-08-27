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
const ENROLL_GET_COMMAND = `spawn ${SIM_UDID} notifyutil -g ${ENROLL}`;
const ENROLL_COMMAND = `spawn ${SIM_UDID} notifyutil -1 ${ENROLL} -s ${ENROLL} 1 -g ${ENROLL} -p ${ENROLL}`;
const UNENROLL_COMMAND = `spawn ${SIM_UDID} notifyutil -1 ${ENROLL} -s ${ENROLL} 0 -g ${ENROLL} -p ${ENROLL}`;

describe("BiometricAuth - iOS Simulator", () => {
  let simctl: FakeSimCtlClient;
  let timer: FakeTimer;

  const makeDevice = (deviceId: string): BootedDevice =>
    ({ deviceId, platform: "ios" }) as BootedDevice;

  const commands = (): string[] =>
    simctl.getMethodCalls("executeCommand").map((c) => String(c.command));

  beforeEach(() => {
    simctl = new FakeSimCtlClient();
    simctl.setCommandResult(ENROLL_GET_COMMAND, `${ENROLL} 1\n`);
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  test("match + fingerprint preserves enrollment then posts fingerTouch.match", async () => {
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
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

  test("enroll explicitly sets and verifies iOS Simulator enrollment", async () => {
    simctl.setCommandResult(ENROLL_COMMAND, `${ENROLL} 1\n${ENROLL}\n`);
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);

    const result = await auth.execute({ action: "enroll" });

    expect(result.success).toBe(true);
    expect(result.action).toBe("enroll");
    expect(commands()).toEqual([ENROLL_COMMAND]);
  });

  test("unenroll explicitly clears and verifies iOS Simulator enrollment", async () => {
    simctl.setCommandResult(UNENROLL_COMMAND, `${ENROLL} 0\n${ENROLL}\n`);
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);

    const result = await auth.execute({ action: "unenroll" });

    expect(result.success).toBe(true);
    expect(result.action).toBe("unenroll");
    expect(commands()).toEqual([UNENROLL_COMMAND]);
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
      "notifyutil: command not found",
    );
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
    const result = await auth.execute({ action: "match", modality: "fingerprint" });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(true);
    expect(result.error).toContain("notifyutil failed");
  });

  test("enrollment read failure surfaces before posting biometric event", async () => {
    simctl.setCommandResult(ENROLL_GET_COMMAND, "", "notifyutil: enrollment unavailable");
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
    const result = await auth.execute({ action: "match", modality: "fingerprint" });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(true);
    expect(result.error).toContain("notifyutil failed");
    expect(commands()).toEqual([ENROLL_GET_COMMAND]);
  });

  test("unenrolled state prevents match without silently enrolling", async () => {
    simctl.setCommandResult(ENROLL_GET_COMMAND, `${ENROLL} 0\n`);
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
    const result = await auth.execute({ action: "match", modality: "fingerprint" });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(true);
    expect(result.error).toContain("not enrolled");
    expect(commands()).toEqual([ENROLL_GET_COMMAND]);
  });

  test("thrown simctl error is caught and reported", async () => {
    simctl.setCommandError(ENROLL_GET_COMMAND, new Error("simctl unavailable"));
    const auth = new BiometricAuth(makeDevice(SIM_UDID), null, timer, simctl);
    const result = await auth.execute({ action: "match", modality: "fingerprint" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("simctl unavailable");
  });
});
