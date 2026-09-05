import { expect, describe, test, beforeEach, spyOn } from "bun:test";
import { Rotate } from "../../../src/features/action/Rotate";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { ExecResult, BootedDevice, ObserveResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("Rotate", () => {
  let rotate: Rotate;
  let fakeAdb: FakeAdbExecutor;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeWindow: FakeWindow;
  let fakeTimer: FakeTimer;
  let mockDevice: BootedDevice;

  // Helper function to create mock ExecResult
  const createExecResult = (stdout: string = ""): ExecResult => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (searchString: string) => stdout.includes(searchString),
  });

  // Helper function to create mock ObserveResult
  const createObserveResult = (): ObserveResult => ({
    timestamp: Date.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { node: {} },
  });

  beforeEach(() => {
    // Create mock BootedDevice
    mockDevice = {
      name: "Test Device",
      platform: "android",
      deviceId: "test-device",
      source: "local",
    };

    // Create fakes for testing
    fakeAdb = new FakeAdbExecutor();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeObserveScreen = new FakeObserveScreen();
    fakeObserveScreen.enableAutoVaryHierarchy();
    fakeWindow = new FakeWindow();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Configure default responses
    fakeWindow.configureCachedActiveWindow(null);
    fakeWindow.configureActiveWindow({
      appId: "com.test.app",
      activityName: "MainActivity",
      layoutSeqSum: 123,
    });

    // Set up default observe screen responses with valid viewHierarchy
    // Use a factory to create different objects on each call (avoids BaseVisualChange
    // comparing same object references and overriding success to false)
    fakeObserveScreen.setObserveResult(() => createObserveResult());

    // Set default responses for common ADB commands
    fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
    fakeAdb.setCommandResponse(
      "shell settings get system accelerometer_rotation",
      createExecResult("1"),
    );

    // Instantiate Rotate with fake ADB
    rotate = new Rotate(mockDevice, fakeAdb, fakeTimer);

    // Inject all fakes to avoid real device operations
    (rotate as any).awaitIdle = fakeAwaitIdle;
    (rotate as any).observeScreen = fakeObserveScreen;
    (rotate as any).window = fakeWindow;
  });

  describe("getCurrentOrientation", () => {
    test("should return portrait for user_rotation 0", async () => {
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("portrait");
      expect(fakeAdb.wasCommandExecuted("shell settings get system user_rotation")).toBe(true);
    });

    test("should return landscape for user_rotation 1", async () => {
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("1"));

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("landscape");
    });

    test("should return portrait for user_rotation 2", async () => {
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("2"));

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("portrait");
    });

    test("should return landscape for user_rotation 3", async () => {
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("3"));

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("landscape");
    });

    test("should prefer live mRotation over stale user_rotation (#6129)", async () => {
      // Auto-rotate has physically rotated the device to landscape, but the
      // `user_rotation` setting (only meaningful while auto-rotate is off)
      // is still stuck at its old portrait value.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        'shell dumpsys window | grep -i "mRotation="',
        createExecResult("mRotation=1"),
      );

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("landscape");
    });

    test("should fall back to user_rotation when dumpsys window has no mRotation", async () => {
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("2"));
      fakeAdb.setCommandResponse(
        'shell dumpsys window | grep -i "mRotation="',
        createExecResult(""),
      );

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("portrait");
    });

    test("should return portrait as default when ADB command fails", async () => {
      fakeAdb.setDefaultResponse({
        stdout: "",
        stderr: "Error",
        toString() {
          return this.stderr;
        },
        trim() {
          return this.stderr.trim();
        },
        includes(s: string) {
          return this.stderr.includes(s);
        },
      });

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("portrait");
    });
  });

  describe("isOrientationLocked", () => {
    test("should return true when accelerometer_rotation is 0", async () => {
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("0"),
      );

      const isLocked = await rotate.isOrientationLocked();

      expect(isLocked).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings get system accelerometer_rotation")).toBe(
        true,
      );
    });

    test("should return false when accelerometer_rotation is 1", async () => {
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );

      const isLocked = await rotate.isOrientationLocked();

      expect(isLocked).toBe(false);
    });

    test("should return false as default when ADB command fails", async () => {
      fakeAdb.setDefaultResponse({
        stdout: "",
        stderr: "Error",
        toString() {
          return this.stderr;
        },
        trim() {
          return this.stderr.trim();
        },
        includes(s: string) {
          return this.stderr.includes(s);
        },
      });

      const isLocked = await rotate.isOrientationLocked();

      expect(isLocked).toBe(false);
    });
  });

  describe("execute", () => {
    test("should skip rotation when already in desired orientation", async () => {
      // Setup: device is already in portrait orientation
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.orientation).toBe("portrait");
      expect(result.rotationPerformed).toBe(false);
      expect(result.message || "").toContain("already in portrait orientation");

      // Verify that we got the current orientation
      expect(fakeAdb.wasCommandExecuted("shell settings get system user_rotation")).toBe(true);
      // Should not have tried to set rotation since already in desired orientation
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 0")).toBe(false);
    });

    test("should rotate a physically-landscape auto-rotated device instead of no-oping (#6129)", async () => {
      // Auto-rotate is on; the device is physically landscape (mRotation=1)
      // but `user_rotation` is stale at 0 (portrait). A prior bug trusted
      // `user_rotation` here and reported "already in portrait", never rotating.
      // The sensor settles on portrait once auto-rotate is restored (no override).
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"),
        createExecResult("mRotation=0"),
      ]);

      const result = await rotate.execute("portrait");

      expect(result.rotationPerformed).toBe(true);
      expect(result.previousOrientation).toBe("landscape");
      expect(result.currentOrientation).toBe("portrait");
      expect(result.warning).toBeUndefined();
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 0")).toBe(true);
    });

    test("should select the LIVE display mRotation over a stale TaskSnapshot mRotation in realistic dumpsys output (#6199)", async () => {
      // Realistic `dumpsys window | grep -i "mRotation="` output: a cached
      // SnapshotCache entry embeds a historical (stale) TaskSnapshot rotation
      // BEFORE the authoritative WindowManagerService rotation line. A naive
      // "first match anywhere" parse picks the stale value and defeats #6129.
      const dumpsysWindowGrepOutput = [
        "     snapshot=TaskSnapshot{ mId=1749551414267 mCaptureTime=1748344877515 mTopActivityComponent=com.android.settings/.SubSettings mSnapshot=android.hardware.HardwareBuffer@d8e7fad (864x1920) mColorSpace=sRGB IEC61966-2.1 (id=0, model=RGB) mOrientation=1 mRotation=0 mTaskSize=Point(1080, 2400) mContentInsets=[0,74][0,63] mLetterboxInsets=[0,0][0,0] mIsLowResolution=false mIsRealSnapshot=true mWindowingMode=1 mAppearance=24 mIsTranslucent=false mHasImeSurface=false mInternalReferences=2",
        "  mRotation=1",
      ].join("\n");
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponse(
        'shell dumpsys window | grep -i "mRotation="',
        createExecResult(dumpsysWindowGrepOutput),
      );

      const orientation = await rotate.getCurrentOrientation();

      // The authoritative live rotation (1 = landscape) must win over the
      // stale TaskSnapshot rotation (0 = portrait).
      expect(orientation).toBe("landscape");
    });

    test("should honestly report the sensor-held orientation when auto-rotate overrides the forced rotation (#6199)", async () => {
      // Auto-rotate is on and the physical sensor stays landscape throughout
      // (e.g. the device is physically held sideways) — restoring auto-rotate
      // after forcing portrait immediately snaps it back to landscape. The
      // result must report the ACHIEVED orientation and warn, not falsely
      // claim portrait succeeded.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      // mRotation reads landscape both before AND after the forced rotation +
      // restore — the sensor never let go of landscape.
      fakeAdb.setCommandResponse(
        'shell dumpsys window | grep -i "mRotation="',
        createExecResult("mRotation=1"),
      );

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.previousOrientation).toBe("landscape");
      // Must report what is ACTUALLY held, not a false "portrait" success.
      expect(result.currentOrientation).toBe("landscape");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/auto-rotate/i);
      expect(result.warning ?? "").toContain("landscape");
    });

    test("should report achieved orientation as currentOrientation for landscape->portrait (#6057)", async () => {
      // Device starts in landscape (user_rotation 1), rotates to portrait and
      // the sensor settles on portrait once auto-rotate is restored.
      fakeAdb.setCommandResponseSequence("shell settings get system user_rotation", [
        createExecResult("1"),
        createExecResult("0"),
      ]);
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      // currentOrientation must be the ACHIEVED orientation, not the stale prior value.
      expect(result.currentOrientation).toBe("portrait");
      // previousOrientation is legitimately the prior value.
      expect(result.previousOrientation).toBe("landscape");
      // The two fields must not duplicate on a performed rotation.
      expect(result.currentOrientation).not.toBe(result.previousOrientation);
      expect(result.message || "").toContain("Successfully rotated from landscape to portrait");
    });

    test("should report achieved orientation as currentOrientation for portrait->landscape (#6057)", async () => {
      // Device starts in portrait (user_rotation 0), rotates to landscape and
      // the sensor settles on landscape once auto-rotate is restored.
      fakeAdb.setCommandResponseSequence("shell settings get system user_rotation", [
        createExecResult("0"),
        createExecResult("1"),
      ]);
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );

      const result = await rotate.execute("landscape");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.currentOrientation).toBe("landscape");
      expect(result.previousOrientation).toBe("portrait");
      expect(result.currentOrientation).not.toBe(result.previousOrientation);
      expect(result.message || "").toContain("Successfully rotated from portrait to landscape");
    });

    test("should coincide currentOrientation and previousOrientation when already in orientation (#6057)", async () => {
      // Device already in portrait: no rotation performed, fields legitimately coincide.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));

      const result = await rotate.execute("portrait");

      expect(result.rotationPerformed).toBe(false);
      expect(result.currentOrientation).toBe("portrait");
      expect(result.previousOrientation).toBe("portrait");
      expect(result.currentOrientation).toBe(result.previousOrientation);
    });

    test("should get current orientation and lock status before rotation", async () => {
      // Setup: device starts in portrait, needs to rotate to landscape
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponse(
        'shell "settings put system accelerometer_rotation 0; settings put system user_rotation 1"',
        createExecResult(),
      );

      await rotate.execute("landscape");

      // Verify ADB calls were made to check orientation state
      expect(fakeAdb.wasCommandExecuted("shell settings get system user_rotation")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings get system accelerometer_rotation")).toBe(
        true,
      );
    });

    test("should attempt rotation command when orientation differs", async () => {
      // Setup: device is in portrait, rotating to landscape
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponse(
        "shell settings put system accelerometer_rotation 0",
        createExecResult(),
      );
      fakeAdb.setCommandResponse("shell settings put system user_rotation 1", createExecResult());

      await rotate.execute("landscape");

      // Verify both rotation commands were executed
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 0")).toBe(
        true,
      );
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 1")).toBe(true);
    });

    test("should rotate directly (without unlocking) when orientation is already locked", async () => {
      // Setup: device is landscape with orientation locked
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("1"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("0"),
      ); // Locked
      fakeAdb.setCommandResponse(
        "shell settings put system accelerometer_rotation 0",
        createExecResult(),
      );
      fakeAdb.setCommandResponse("shell settings put system user_rotation 0", createExecResult());

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      // Verify the rotation commands were executed
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 0")).toBe(
        true,
      );
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 0")).toBe(true);
      // Locked devices stay locked (to the newly-requested orientation) rather
      // than being unlocked then immediately re-locked, which was a no-op.
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 1")).toBe(
        false,
      );
      expect(result.orientationLockHandled).toBe(false);
    });

    test("should restore auto-rotate after forcing a rotation while it was enabled (#6129)", async () => {
      // Device starts landscape with auto-rotate ON (unlocked); the sensor
      // settles on portrait once auto-rotate is restored (no override).
      fakeAdb.setCommandResponseSequence("shell settings get system user_rotation", [
        createExecResult("1"),
        createExecResult("0"),
      ]);
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.orientationLockHandled).toBe(true);
      expect(result.warning).toBeUndefined();
      // Auto-rotate must be forced off to apply user_rotation, then restored.
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 0")).toBe(
        true,
      );
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 1")).toBe(
        true,
      );
      // The restore ("1") must be the LAST accelerometer_rotation write, not left at 0.
      const accelWrites = fakeAdb
        .getExecutedCommands()
        .filter((cmd) => cmd.includes("settings put system accelerometer_rotation"));
      expect(accelWrites.at(-1)).toContain("accelerometer_rotation 1");
    });

    test("should not mutate accelerometer_rotation at all when it is unreadable (#6199)", async () => {
      // accelerometer_rotation is malformed/unreadable — this must be treated
      // as "unknown". We must not force it off (no confirmed prior value to
      // restore afterward), so user_rotation is written on its own and
      // whatever the real device does with it is reported honestly by
      // waitForRotation rather than covered up with a guessed restore.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("1"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("not-a-number"),
      );

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.orientationLockHandled).toBe(false);
      // user_rotation is still written...
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 0")).toBe(true);
      // ...but accelerometer_rotation is never mutated in either direction:
      // no disable, and (necessarily) no unconfirmed "restore" either.
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 0")).toBe(
        false,
      );
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 1")).toBe(
        false,
      );
    });

    test("serializes concurrent rotations on the same device so auto-rotate restore is not corrupted (#6199)", async () => {
      // Device starts portrait with auto-rotate ON.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );

      // Gate the FIRST rotation's waitForRotation call so it parks mid-flight
      // — after reading state and writing accelerometer_rotation=0, but
      // before restoring it — giving a concurrent second rotation on the same
      // device a window to race it if the critical section is not serialized.
      let releaseFirstWait: (() => void) | undefined;
      const firstWaitGate = new Promise<void>((resolve) => {
        releaseFirstWait = resolve;
      });
      let waitForRotationCalls = 0;
      const gatedAwaitIdle = {
        waitForRotation: async () => {
          waitForRotationCalls++;
          if (waitForRotationCalls === 1) {
            await firstWaitGate;
          }
        },
      };
      (rotate as any).awaitIdle = gatedAwaitIdle;

      const secondRotate = new Rotate(mockDevice, fakeAdb, fakeTimer);
      (secondRotate as any).awaitIdle = gatedAwaitIdle;
      (secondRotate as any).observeScreen = fakeObserveScreen;
      (secondRotate as any).window = fakeWindow;

      const lock = (rotate as any).getRotationLock();
      // Same deviceId -> the second instance must resolve to the SAME lock.
      expect((secondRotate as any).getRotationLock()).toBe(lock);

      const firstCall = rotate.execute("landscape");

      // Let the first call's microtasks run until it holds the lock and is
      // parked at the gate.
      for (let i = 0; i < 50 && !lock.isLocked(); i++) {
        await Promise.resolve();
      }
      expect(lock.isLocked()).toBe(true);

      // Same requested orientation as the first call: `user_rotation` is
      // stubbed at a constant stale "0" (portrait) regardless of what either
      // call writes, so both calls see "not yet landscape" and must go
      // through the full write/restore flow rather than short-circuiting.
      const secondCall = secondRotate.execute("landscape");

      // Give the second call every chance to run if it were (incorrectly)
      // unserialized; it must still be blocked on the lock, so it must not
      // have read device state yet.
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      const accelGetsWhileFirstHoldsLock = fakeAdb
        .getExecutedCommands()
        .filter((cmd) => cmd.includes("settings get system accelerometer_rotation")).length;
      expect(accelGetsWhileFirstHoldsLock).toBe(1);

      releaseFirstWait!();
      const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(firstResult.orientationLockHandled).toBe(true);
      expect(secondResult.orientationLockHandled).toBe(true);

      // The second rotation must observe the FIRST rotation's fully-restored
      // state, not its transient accelerometer_rotation=0 — and must end up
      // restoring auto-rotate itself, not stuck at 0.
      const accelWrites = fakeAdb
        .getExecutedCommands()
        .filter((cmd) => cmd.includes("settings put system accelerometer_rotation"));
      expect(accelWrites.at(-1)).toContain("accelerometer_rotation 1");
      expect(lock.isLocked()).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("should handle whitespace in ADB output", async () => {
      fakeAdb.setCommandResponse(
        "shell settings get system user_rotation",
        createExecResult("  1  \n"),
      );

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("landscape");
    });

    test("should handle non-numeric ADB output", async () => {
      fakeAdb.setCommandResponse(
        "shell settings get system user_rotation",
        createExecResult("not-a-number"),
      );

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("portrait"); // Should default to portrait
    });

    test("should handle empty ADB output", async () => {
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult(""));

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("portrait"); // Should default to portrait
    });
  });

  describe("iOS platform", () => {
    let iosDevice: BootedDevice;
    let fakeIOSCtrlProxy: FakeIOSCtrlProxy;
    let getInstanceSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      iosDevice = {
        name: "iPhone 15",
        platform: "ios",
        deviceId: "ios-device",
        source: "local",
      };

      fakeIOSCtrlProxy = new FakeIOSCtrlProxy();
      getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIOSCtrlProxy as any,
      );
    });

    test("should use CtrlProxy to rotate to landscape on iOS", async () => {
      const iosRotate = new Rotate(iosDevice, fakeAdb, fakeTimer);
      (iosRotate as any).observeScreen = fakeObserveScreen;
      (iosRotate as any).window = fakeWindow;
      (iosRotate as any).awaitIdle = fakeAwaitIdle;

      try {
        const result = await iosRotate.execute("landscape");
        expect(result.success).toBe(true);
        expect(result.orientation).toBe("landscape");
        expect(result.rotationPerformed).toBe(true);
        expect(fakeIOSCtrlProxy.getRotateHistory()).toHaveLength(1);
        expect(fakeIOSCtrlProxy.getRotateHistory()[0].orientation).toBe("landscape");
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("should use CtrlProxy to rotate to portrait on iOS", async () => {
      const iosRotate = new Rotate(iosDevice, fakeAdb, fakeTimer);
      (iosRotate as any).observeScreen = fakeObserveScreen;
      (iosRotate as any).window = fakeWindow;
      (iosRotate as any).awaitIdle = fakeAwaitIdle;

      try {
        const result = await iosRotate.execute("portrait");
        expect(result.success).toBe(true);
        expect(result.orientation).toBe("portrait");
        expect(fakeIOSCtrlProxy.getRotateHistory()).toHaveLength(1);
        expect(fakeIOSCtrlProxy.getRotateHistory()[0].orientation).toBe("portrait");
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("should throw when iOS rotate fails", async () => {
      fakeIOSCtrlProxy.setFailureMode("rotate", new Error("Rotation not supported"));
      const iosRotate = new Rotate(iosDevice, fakeAdb, fakeTimer);
      (iosRotate as any).observeScreen = fakeObserveScreen;
      (iosRotate as any).window = fakeWindow;
      (iosRotate as any).awaitIdle = fakeAwaitIdle;

      try {
        await expect(iosRotate.execute("landscape")).rejects.toThrow("Rotation not supported");
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("should not call ADB for iOS rotation", async () => {
      const iosRotate = new Rotate(iosDevice, fakeAdb, fakeTimer);
      (iosRotate as any).observeScreen = fakeObserveScreen;
      (iosRotate as any).window = fakeWindow;
      (iosRotate as any).awaitIdle = fakeAwaitIdle;

      try {
        await iosRotate.execute("landscape");
        expect(fakeAdb.wasCommandExecuted("shell settings get system user_rotation")).toBe(false);
        expect(fakeAdb.wasCommandExecuted("shell settings get system accelerometer_rotation")).toBe(
          false,
        );
      } finally {
        getInstanceSpy.mockRestore();
      }
    });
  });
});
