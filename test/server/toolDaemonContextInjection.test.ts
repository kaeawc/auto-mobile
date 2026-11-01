import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { DaemonContext } from "../../src/daemon/daemonContext";
import { BiometricAuth } from "../../src/features/action/BiometricAuth";
import { TalkBackToggle } from "../../src/features/accessibility/TalkBackToggle";
import { VoiceOverToggle } from "../../src/features/accessibility/VoiceOverToggle";
import type { BootedDevice } from "../../src/models";
import { registerAccessibilityTools } from "../../src/server/accessibilityTools";
import { registerBiometricTools } from "../../src/server/biometricTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

const ANDROID = { name: "a", deviceId: "emulator-5554", platform: "android" } as BootedDevice;
const IOS = { name: "i", deviceId: "sim-1", platform: "ios" } as BootedDevice;

function deviceAwareHandler(name: string) {
  const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find((t) => t.name === name);
  if (!tool?.deviceAwareHandler) {
    throw new Error(`${name} tool not registered`);
  }
  return tool.deviceAwareHandler;
}

/** A context with no daemon behind it that counts how often a handler asks it for sessions. */
class CountingDaemonContext implements Pick<DaemonContext, "sessionManager"> {
  reads = 0;
  sessionManager() {
    this.reads++;
    return undefined;
  }
}

isolateToolRegistry();

describe("tool registration daemon context injection (#13315)", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  let daemon: CountingDaemonContext;

  beforeEach(() => {
    ToolRegistry.clearTools();
    daemon = new CountingDaemonContext();
  });

  afterEach(() => {
    spies
      .splice(0)
      .reverse()
      .forEach((spy) => spy.mockRestore());
    ToolRegistry.clearTools();
  });

  test("accessibility reads session state from the context it was registered with", async () => {
    spies.push(
      spyOn(TalkBackToggle.prototype, "toggle").mockResolvedValue({
        supported: true,
        applied: true,
        currentState: true,
      } as Awaited<ReturnType<TalkBackToggle["toggle"]>>),
    );
    registerAccessibilityTools(daemon);

    await deviceAwareHandler("accessibility")(ANDROID, { talkback: true, sessionUuid: "s1" });

    expect(daemon.reads).toBe(1);
  });

  test("accessibility on iOS reads session state from the context it was registered with", async () => {
    spies.push(
      spyOn(VoiceOverToggle.prototype, "toggle").mockResolvedValue({
        supported: true,
        applied: true,
        currentState: true,
      } as Awaited<ReturnType<VoiceOverToggle["toggle"]>>),
    );
    registerAccessibilityTools(daemon);

    await deviceAwareHandler("accessibility")(IOS, { voiceover: true, sessionUuid: "s1" });

    expect(daemon.reads).toBe(1);
  });

  test("biometricAuth reads session state from the context it was registered with", async () => {
    spies.push(
      spyOn(BiometricAuth.prototype, "execute").mockResolvedValue({
        success: true,
        message: "ok",
      } as Awaited<ReturnType<BiometricAuth["execute"]>>),
    );
    registerBiometricTools(daemon);

    await deviceAwareHandler("biometricAuth")(IOS, { action: "enroll", sessionUuid: "s1" });

    expect(daemon.reads).toBe(1);
  });
});
