import { expect, test } from "bun:test";
import { DefaultAndroidObservationCollector } from "../../../../src/features/observe/collectors/AndroidObservationCollector";
import { DeviceStateCollector } from "../../../../src/features/observe/collectors/DeviceStateCollector";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeHierarchyCollector } from "../../../fakes/FakeHierarchyCollector";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../../fakes/FakeViewHierarchy";
import { FakeWindow } from "../../../fakes/FakeWindow";
import { createObserveResultForTest } from "../flatHierarchyBuilders";

const device = { platform: "android", deviceId: "fake", name: "fake" } as const;

async function collectWithForegroundActivity(foregroundActivity: string) {
  const deviceState = new DeviceStateCollector({
    device,
    adb: new FakeAdbExecutor(),
    timer: new FakeTimer(),
    window: new FakeWindow(),
    backStack: { execute: async () => ({ depth: 0, activities: [], tasks: [] }) },
  });
  const collector = new DefaultAndroidObservationCollector({
    device: () => device,
    deviceStateCollector: () => deviceState,
    hierarchyCollector: () => new FakeHierarchyCollector(foregroundActivity),
    viewHierarchy: () => new FakeViewHierarchy(),
  });
  const result = createObserveResultForTest({ notificationPermissionDetected: true });
  await collector.collect({
    result,
    queryOptions: undefined,
    perf: new NoOpPerformanceTracker(),
    skipWaitForFresh: true,
    minTimestamp: 0,
    signal: undefined,
    readOnly: true,
    capturedHierarchy: undefined,
    readOptions: undefined,
    skipBackStack: true,
    displayId: 0,
  });
  return result;
}

// #17465: CtrlProxy paired the permission controller's root package with the
// last window-state class it heard, the Contacts activity behind the dialog.
test("a permission dialog window does not carry the activity of the app behind it", async () => {
  const result = await collectWithForegroundActivity(
    "com.google.android.permissioncontroller/com.google.android.apps.contacts.activities.PeopleActivity",
  );

  expect(result.activeWindow).toEqual({
    appId: "com.google.android.permissioncontroller",
    activityName: "",
    layoutSeqSum: 0,
    type: "notification_permission_dialog",
  });
});

test("the permission controller's own grant activity is kept", async () => {
  const result = await collectWithForegroundActivity(
    "com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
  );

  expect(result.activeWindow?.activityName).toBe(
    "com.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
  );
  expect(result.activeWindow?.type).toBe("notification_permission_dialog");
});
