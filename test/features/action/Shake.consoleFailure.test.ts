import { describe, expect, test } from "bun:test";
import { Shake } from "../../../src/features/action/Shake";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("Shake emulator console failure", () => {
  test.each(["stdout", "stderr"] as const)(
    "returns failure for KO on %s and still resets acceleration",
    async (stream) => {
      const fakeAdb = new FakeAdbExecutor();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      // Output from test/features/device/AndroidHingeAngleConsole.test.ts.
      const output = "KO: unknown sensor";
      fakeAdb.setCommandResponse("emu sensor set acceleration 100:100:100", {
        stdout: stream === "stdout" ? output : "",
        stderr: stream === "stderr" ? output : "",
      });
      const shake = new Shake(
        { name: "pixel", platform: "android", deviceId: "emulator-5554" },
        fakeAdb,
        timer,
      );
      const observeScreen = new FakeObserveScreen();
      observeScreen.setObserveResult({
        observationId: "shake-test",
        display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
        updatedAt: timer.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: { hierarchy: {} },
      });
      Object.assign(shake, {
        observeScreen,
        window: new FakeWindow(),
        awaitIdle: new FakeAwaitIdle(),
      });

      const result = await shake.execute({ duration: 50, intensity: 100 });

      expect(result.success).toBe(false);
      expect(result.duration).toBe(50);
      expect(result.intensity).toBe(100);
      expect(result.error).toContain(output);
      expect(fakeAdb.getExecutedCommands().filter((cmd) => cmd.startsWith("emu sensor"))).toEqual([
        "emu sensor get acceleration",
        "emu sensor set acceleration 100:100:100",
        "emu sensor set acceleration 0:9.77622:0",
      ]);
      expect(timer.wasSleepCalled(50)).toBe(false);
    },
  );
});
