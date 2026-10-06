import { beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import type {
  AndroidHandledExceptionEvent,
  AndroidSdkEventIngestor,
} from "../../../../src/features/observe/android/AndroidSdkEventIngestor";
import { packageEventAndroidUserId } from "../../../../src/features/observe/android/CtrlProxyPackages";
import type { WorkProfileMonitor } from "../../../../src/utils/WorkProfileMonitor";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeInstalledAppsRepository } from "../../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../../fakes/FakeTimer";

// Byte-for-byte shapes the Kotlin side emits: `packageEventJson` inside
// `webSocketFrameJson` (PackageEventWireTest.kt) and WebSocketResponseTest.kt's handled
// exception encoding.
const NEW_PACKAGE_FRAME =
  '{"type":"package_event","timestamp":1700000000000,"event":{"action":"added","packageName":"com.example.app","userId":0,"uid":10234,"isSystem":false}}';
const NEW_WORK_PROFILE_FRAME =
  '{"type":"package_event","timestamp":1700000000000,"event":{"action":"added","packageName":"com.example.app","userId":10,"uid":1010234,"isSystem":false}}';
// An APK from before #10067: the app uid is in `userId` and there is no `uid`.
const OLD_PACKAGE_FRAME =
  '{"type":"package_event","timestamp":1700000000000,"event":{"action":"added","packageName":"com.example.app","userId":10234,"isSystem":false}}';
const OLD_WORK_PROFILE_REMOVED_FRAME =
  '{"type":"package_event","timestamp":1700000000000,"event":{"action":"removed","packageName":"com.example.work","userId":1010234}}';
const HANDLED_FRAME =
  '{"type":"handled_exception_event","timestamp":1700000001000,"event":{"exceptionClass":"java.lang.IllegalStateException","message":"cart is empty","stackTrace":"at com.example.Main.run(Main.java:42)","customMessage":null,"currentScreen":null,"packageName":"com.example.app","appVersion":null,"deviceInfo":{"model":"Pixel 7","manufacturer":"Google","osVersion":"14","sdkInt":34},"applicationId":null}}';

class RecordingProfileMonitor implements WorkProfileMonitor {
  readonly marked: number[] = [];
  start(): void {}
  stop(): void {}
  setProfileHasAccessibilityService(userId: number): void {
    this.marked.push(userId);
  }
  getProfileStates(): [] {
    return [];
  }
  async refreshProfile(): Promise<void> {}
  isRunning(): boolean {
    return false;
  }
}

class RecordingIngestor implements AndroidSdkEventIngestor {
  readonly handled: AndroidHandledExceptionEvent[] = [];
  async recordSdkEvent(): Promise<void> {}
  recordStorageEvent(): void {}
  async recordHandledException(event: AndroidHandledExceptionEvent): Promise<void> {
    this.handled.push(event);
  }
  async recordCrashAnalytics(): Promise<void> {}
  async recordAnrAnalytics(): Promise<void> {}
}

const DEVICE_ID = "device-event-wire";

describe("Android CtrlProxy device event wire (#10067, #10068)", () => {
  let repo: FakeInstalledAppsRepository;
  let monitor: RecordingProfileMonitor;
  let ingestor: RecordingIngestor;
  let client: AndroidCtrlProxyClient;

  async function dispatch(frame: string): Promise<void> {
    await client["handleWebSocketMessage"](frame);
  }

  async function installedKeys(): Promise<string[]> {
    const rows = await repo.listInstalledApps(DEVICE_ID);
    return rows.map((row) => `${row.user_id}:${row.package_name}`).sort();
  }

  beforeEach(async () => {
    const timer = new FakeTimer();
    repo = new FakeInstalledAppsRepository();
    monitor = new RecordingProfileMonitor();
    ingestor = new RecordingIngestor();
    // A snapshot already exists, so package events patch it instead of being dropped (#10041).
    await repo.seedInstalledApp(DEVICE_ID, 0, "com.example.base", false, timer.now());
    client = AndroidCtrlProxyClient.createForTesting(
      { deviceId: DEVICE_ID, platform: "android", name: "Device Event Wire" },
      new FakeAdbExecutor(),
      () => {
        throw new Error("WebSocket connection is not needed for wire dispatch tests");
      },
      timer,
      repo,
      undefined,
      undefined,
      undefined,
      ingestor,
    );
    client["workProfileMonitor"] = monitor;
  });

  describe("package_event userId", () => {
    test("a current APK's install lands under the primary user", async () => {
      await dispatch(NEW_PACKAGE_FRAME);
      expect(await installedKeys()).toEqual(["0:com.example.app", "0:com.example.base"]);
      expect(monitor.marked).toEqual([]);
    });

    test("a current APK's work-profile install lands under that profile", async () => {
      await dispatch(NEW_WORK_PROFILE_FRAME);
      expect(await installedKeys()).toEqual(["0:com.example.base", "10:com.example.app"]);
      expect(monitor.marked).toEqual([10]);
    });

    test("an old APK's app uid is mapped to its user instead of a phantom profile", async () => {
      await dispatch(OLD_PACKAGE_FRAME);
      expect(await installedKeys()).toEqual(["0:com.example.app", "0:com.example.base"]);
      expect(monitor.marked).toEqual([]);
    });

    test("an old APK's per-user uninstall removes the row of the profile it came from", async () => {
      await repo.seedInstalledApp(DEVICE_ID, 10, "com.example.work", false, 1);
      await repo.seedInstalledApp(DEVICE_ID, 0, "com.example.work", false, 1);
      await dispatch(OLD_WORK_PROFILE_REMOVED_FRAME);
      expect(await installedKeys()).toEqual(["0:com.example.base", "0:com.example.work"]);
    });

    test("never writes a row keyed by an app uid", async () => {
      for (const frame of [NEW_PACKAGE_FRAME, OLD_PACKAGE_FRAME, NEW_WORK_PROFILE_FRAME]) {
        await dispatch(frame);
      }
      const rows = await repo.listInstalledApps(DEVICE_ID);
      expect(rows.filter((row) => row.user_id >= 10_000)).toEqual([]);
    });

    test("packageEventAndroidUserId resolves current and legacy payloads", () => {
      expect(packageEventAndroidUserId({ userId: 10, uid: 1010234 })).toBe(10);
      expect(packageEventAndroidUserId({ userId: 0, uid: 10234 })).toBe(0);
      expect(packageEventAndroidUserId({ userId: 10234 })).toBe(0);
      expect(packageEventAndroidUserId({ userId: 1010234 })).toBe(10);
      expect(packageEventAndroidUserId({ userId: 10 })).toBe(10);
      expect(packageEventAndroidUserId({ userId: 0 })).toBe(0);
    });
  });

  describe("handled_exception_event message", () => {
    test("hands the ingestor the message field the device wrote", async () => {
      await dispatch(HANDLED_FRAME);
      expect(ingestor.handled).toHaveLength(1);
      expect(ingestor.handled[0].message).toBe("cart is empty");
    });
  });
});
