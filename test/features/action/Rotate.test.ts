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

    test("should report the achieved orientation as unconfirmed when the post-restore live read is unparseable, never falling back to user_rotation (#6199)", async () => {
      // Auto-rotate is on; the device is physically landscape. The FIRST
      // dumpsys read (pre-rotation state check) succeeds and reports
      // landscape. After forcing portrait and restoring auto-rotate, the
      // confirmation dumpsys read is transiently unparseable (e.g. a
      // momentary empty/garbled `dumpsys window` response) — the code must
      // NOT fall back to the just-written `user_rotation` (which would
      // dishonestly echo "portrait" as if the sensor had held it) and must
      // NOT silently report the requested orientation as achieved.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"),
        createExecResult(""),
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.previousOrientation).toBe("landscape");
      // Must NOT falsely report the requested orientation as achieved/held.
      expect(result.currentOrientation).not.toBe("portrait");
      expect(result.currentOrientation).toBe("unknown");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/could not be confirmed/i);
    });

    test("should report achieved orientation as currentOrientation for landscape->portrait (#6057)", async () => {
      // Device starts in landscape (live mRotation=1), rotates to portrait
      // and the sensor settles on portrait (live mRotation=0) once
      // auto-rotate is restored. The post-restore confirmation read is LIVE
      // (mRotation), never a fallback to user_rotation (#6199 review).
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"),
        createExecResult("mRotation=0"),
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
      // Device starts in portrait (live mRotation=0), rotates to landscape
      // and the sensor settles on landscape (live mRotation=1) once
      // auto-rotate is restored. The post-restore confirmation read is LIVE
      // (mRotation), never a fallback to user_rotation (#6199 review).
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=0"),
        createExecResult("mRotation=1"),
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
      // settles on portrait (live mRotation=0) once auto-rotate is restored
      // (no override). The post-restore confirmation read is LIVE
      // (mRotation), never a fallback to user_rotation (#6199 review).
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"),
        createExecResult("mRotation=0"),
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

    test("settle-waits (retries via the injected Timer) before accepting a transient post-restore read, instead of confirming immediately (#6211)", async () => {
      // Auto-rotate is on; the device starts landscape. After forcing
      // portrait and restoring auto-rotate, the FIRST confirmation read
      // catches a transient not-yet-settled WindowManager still reporting
      // landscape; the SECOND read (after the settle-wait sleep) shows the
      // sensor has settled on portrait. The settle-wait must retry via
      // `this.timer.sleep` rather than confirming off the stale first read.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=1"), // post-restore confirm attempt 1: transient/unsettled
        createExecResult("mRotation=0"), // post-restore confirm attempt 2: settled
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      // Settled on the requested orientation, not the transient stale read.
      expect(result.currentOrientation).toBe("portrait");
      expect(result.warning).toBeUndefined();
      // The settle-wait must have slept (i.e. actually retried) via the
      // injected Timer before accepting the second read as final.
      expect(fakeTimer.getSleepCallCount()).toBeGreaterThan(0);
    });

    test("does not accept a first post-restore sample matching the requested orientation without confirming it is stable (#6211)", async () => {
      // Auto-rotate is on; the device starts landscape. After forcing
      // portrait and restoring auto-rotate, the FIRST confirmation read
      // already matches the requested "portrait" — but the physical sensor
      // swings it back to landscape moments later. A fix that returns on the
      // first matching sample without confirming stability would falsely
      // report "portrait" held; the settle-wait must confirm the match holds
      // across a second read before accepting it.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=0"), // post-restore confirm attempt 1: matches requested portrait...
        createExecResult("mRotation=1"), // ...but attempt 2 reveals it swung back to landscape
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      // Must report the ACTUAL orientation (landscape), not the transient
      // first-sample match that was never confirmed stable.
      expect(result.currentOrientation).toBe("landscape");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/reverted/i);
      // The settle-wait must have kept sampling past the first match.
      expect(fakeTimer.getSleepCallCount()).toBeGreaterThan(0);
    });

    test("does not accept a lone match on the FINAL settle-wait attempt, since there is no later sample to confirm it (#6211)", async () => {
      // Auto-rotate is on; the device starts landscape. After forcing
      // portrait and restoring auto-rotate, the settle-wait budget
      // (SETTLE_WAIT_MAX_ATTEMPTS=3) is exhausted with landscape, landscape,
      // then the requested portrait on the very last attempt — a single,
      // unconfirmed match with no opportunity for a later stability read.
      // Unconditionally returning that final value would falsely report
      // "portrait" held; it must instead be reported as unconfirmed.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=1"), // post-restore confirm attempt 1: landscape
        createExecResult("mRotation=1"), // post-restore confirm attempt 2: landscape
        createExecResult("mRotation=0"), // post-restore confirm attempt 3 (final): lone portrait match
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      // Must NOT report the requested orientation as confirmed off a single,
      // unconfirmable final-attempt sample.
      expect(result.currentOrientation).toBe("unknown");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/could not be confirmed/i);
      // The settle-wait must have exhausted its full retry budget (slept
      // between every attempt) rather than stopping early on the lone match.
      expect(fakeTimer.getSleepCallCount()).toBe(2);
    });

    test("does not report a lone final opposite-orientation sample as a confirmed reversion (#6211)", async () => {
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult(""), // settle attempt 1: unreadable
        createExecResult(""), // settle attempt 2: unreadable
        createExecResult("mRotation=1"), // settle attempt 3: lone landscape sample
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.currentOrientation).toBe("unknown");
      expect(result.warning ?? "").toMatch(/could not be confirmed/i);
      expect(fakeTimer.getSleepCallCount()).toBe(2);
    });

    test("does not accept a lone match on the FINAL settle-wait attempt after an earlier non-adjacent match resets the streak (#6211)", async () => {
      // Alternate sequence from the review finding: portrait, landscape,
      // portrait. The first attempt matches but is immediately broken by the
      // second (non-matching) attempt, resetting the consecutive-match
      // streak; the third (final) attempt matches again but, being the last
      // attempt, has no later sample to confirm it either.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=0"), // post-restore confirm attempt 1: portrait (lone, then broken)
        createExecResult("mRotation=1"), // post-restore confirm attempt 2: landscape (breaks the streak)
        createExecResult("mRotation=0"), // post-restore confirm attempt 3 (final): lone portrait match again
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.currentOrientation).toBe("unknown");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/could not be confirmed/i);
    });

    test("gives up after the settle-wait budget and honestly reports unconfirmed when the read never settles (#6211)", async () => {
      // The confirmation read stays unparseable across every settle-wait
      // attempt (persistent, not transient) — must still end up "unknown"
      // rather than retrying forever or fabricating a result.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult(""), // every confirm attempt thereafter is unparseable
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.currentOrientation).toBe("unknown");
      expect(result.warning ?? "").toMatch(/could not be confirmed/i);
    });

    test("confirms the true live orientation (rather than assuming it held) when the auto-rotate restore write fails, and preserves it when it does hold (#6211)", async () => {
      // waitForRotation has already CONFIRMED the requested rotation while
      // auto-rotate was forced off. The subsequent accelerometer_rotation=1
      // restore write then throws — but a REJECTED write does not prove
      // auto-rotate stayed disabled (the underlying put can time out AFTER
      // CtrlProxy already applied it), so the code must re-read the live
      // orientation rather than assume it held. Here the re-read confirms
      // portrait genuinely still holds, so the confirmed rotation is
      // preserved with a warning noting the ambiguous restore, not
      // discarded as an overall failure.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=0"), // post-write-failure confirm reads: portrait genuinely holds
      ]);
      fakeAdb.setCommandError(
        "shell settings put system accelerometer_rotation 1",
        new Error("device offline"),
      );

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.currentOrientation).toBe("portrait");
      expect(result.previousOrientation).toBe("landscape");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/ambiguous outcome/i);
      // The restore-write failure must NOT skip re-confirming the live
      // orientation — it must be re-queried, not assumed (#6211 review).
      const dumpsysCalls = fakeAdb
        .getExecutedCommands()
        .filter((cmd) => cmd.includes('shell dumpsys window | grep -i "mRotation="')).length;
      expect(dumpsysCalls).toBeGreaterThan(1);
    });

    test("reflects the true reverted orientation, not the requested one, when an ambiguous restore-write failure turns out to have actually re-enabled auto-rotate (#6211)", async () => {
      // The accelerometer_rotation=1 restore write throws (ambiguous outcome:
      // it may have been applied by CtrlProxy before the failure was
      // reported), and the physical sensor genuinely reverts the device once
      // auto-rotate is back on. The code must report the ACTUAL confirmed
      // orientation, not blindly assume the forced rotation still holds just
      // because the restore write appeared to fail.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"), // pre-rotation state check (landscape before)
        createExecResult("mRotation=1"), // post-write-failure confirm reads: reverted to landscape
      ]);
      fakeAdb.setCommandError(
        "shell settings put system accelerometer_rotation 1",
        new Error("device offline"),
      );

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      // Must report the TRUE confirmed orientation, not the requested one.
      expect(result.currentOrientation).toBe("landscape");
      expect(result.previousOrientation).toBe("landscape");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/reverted/i);
      // The live read confirms landscape, but the rejected restore write does
      // not prove auto-rotate caused it. Keep the evidence without inventing
      // that causal outcome in the public message.
      expect(result.message).toContain("attempting to restore auto-rotate");
      expect(result.message).toContain("confirmed landscape");
      expect(result.message).not.toMatch(/auto-rotate reverted/i);
    });

    test("retains a confirmed stable opposite orientation when the FINAL settle-wait sample fails to read (#6211)", async () => {
      // Auto-rotate is on; the device starts landscape. After forcing
      // portrait and restoring auto-rotate, the first two post-restore
      // samples both read landscape (two consecutive matching samples — a
      // confirmed reversion), but the third (final) settle-wait attempt
      // fails to parse at all. That read FAILURE must not discard the
      // already-confirmed landscape reversion in favor of "unknown".
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=1"), // post-restore confirm attempt 1: landscape
        createExecResult("mRotation=1"), // post-restore confirm attempt 2: landscape (confirmed stable)
        createExecResult(""), // post-restore confirm attempt 3 (final): unparseable
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      // Must report the confirmed landscape reversion, not "unknown".
      expect(result.currentOrientation).toBe("landscape");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/reverted/i);
    });

    test("retries the auto-rotate restore write once before treating a transient failure as ambiguous (#6211)", async () => {
      // Auto-rotate is on; the device starts landscape. The FIRST
      // accelerometer_rotation=1 restore write attempt fails transiently
      // (e.g. a momentary CtrlProxy/ADB hiccup), but a retry of the same
      // idempotent write succeeds. This must not be reported as an ambiguous
      // outcome — the retry recovers it cleanly.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=0"), // post-restore confirm attempt 1: portrait
        createExecResult("mRotation=0"), // post-restore confirm attempt 2: portrait (confirmed stable)
      ]);

      let restoreWriteAttempts = 0;
      const originalExecuteCommand = fakeAdb.executeCommand.bind(fakeAdb);
      fakeAdb.executeCommand = (async (command: string, ...rest: unknown[]) => {
        if (command.includes("settings put system accelerometer_rotation 1")) {
          restoreWriteAttempts++;
          if (restoreWriteAttempts === 1) {
            throw new Error("transient device offline");
          }
        }
        return (originalExecuteCommand as (...args: unknown[]) => Promise<ExecResult>)(
          command,
          ...rest,
        );
      }) as typeof fakeAdb.executeCommand;

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.currentOrientation).toBe("portrait");
      // No ambiguity: the retry recovered the restore write cleanly.
      expect(result.warning).toBeUndefined();
      // The restore write must have been attempted twice: once, then a retry.
      expect(restoreWriteAttempts).toBe(2);
    });

    test("keeps the ambiguous-restore warning state-neutral instead of asserting auto-rotate is enabled (#6211)", async () => {
      // The accelerometer_rotation=1 restore write fails on both the first
      // attempt and the retry (persistent, not transient), and the live
      // confirmation read never settles either. The composed warning must
      // not claim "auto-rotate is enabled" — that state was never actually
      // confirmed — while still explaining the ambiguous outcome.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence('shell dumpsys window | grep -i "mRotation="', [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult(""), // every post-restore confirm attempt is unparseable
      ]);
      fakeAdb.setCommandError(
        "shell settings put system accelerometer_rotation 1",
        new Error("device offline"),
      );

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.currentOrientation).toBe("unknown");
      expect(result.warning).toBeDefined();
      const warning = result.warning ?? "";
      expect(warning).toMatch(/ambiguous outcome/i);
      expect(warning).toMatch(/could not be confirmed/i);
      // State-neutral: must not assert a state that was never confirmed.
      expect(warning).not.toMatch(/auto-rotate is enabled/i);
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
