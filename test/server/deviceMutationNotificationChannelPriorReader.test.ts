import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice } from "../../src/models";
import type { MutationValue } from "../../src/daemon/sessionBroker/mutations/types";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import { NotificationChannelMutationPriorReader } from "../../src/server/deviceMutationNotificationChannelPriorReader";
import { DefaultMutationPriorReader } from "../../src/server/deviceMutationPriorReader";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

const ANDROID: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
const IOS: BootedDevice = { name: "sim", platform: "ios", deviceId: "SIM-1" };
const QUERY =
  "shell am broadcast --include-stopped-packages -n 'com.example.probe/dev.jasonpearson.automobile.sdk.notifications.AutoMobileNotificationReceiver' -a dev.jasonpearson.automobile.sdk.NOTIFICATION_CHANNEL_QUERY --es channel_id 'orders-v2'";
const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../fixtures/android-notification-channel", name), "utf8");

function rig(stdout?: string, stderr = "") {
  const adb = new FakeAdbExecutor();
  if (stdout !== undefined) {
    adb.setCommandResponse(QUERY, createExecResult(stdout, stderr));
  }
  return { adb, reader: new NotificationChannelMutationPriorReader(new FakeAdbClientFactory(adb)) };
}

const rows = deviceToolMutations(
  "postNotification",
  { appId: "com.example.probe", title: "Hi", channelId: "orders-v2" },
  "android",
);

describe("NotificationChannelMutationPriorReader (#16510)", () => {
  test.each<[string, MutationValue]>([
    ["am-broadcast-query-absent.txt", { state: "absent" }],
    ["am-broadcast-query-present.txt", { state: "present", value: true }],
    ["am-broadcast-query-old-sdk.txt", { state: "unobservable" }],
  ])("asks the SDK receiver before the post: %s", async (name, prior) => {
    const { adb, reader } = rig(fixture(name));
    expect(await reader.read(ANDROID, rows)).toEqual([{ state: "unobservable" }, prior]);
    expect(adb.getExecutedCommands()).toEqual([QUERY]);
  });

  test("stderr makes the prior unobservable", async () => {
    const { reader } = rig(fixture("am-broadcast-query-absent.txt"), "Security exception");
    expect((await reader.read(ANDROID, rows))[1]).toEqual({ state: "unobservable" });
  });

  test("a failed read is unobservable", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(QUERY, createExecResult("", ""));
    adb.executeCommand = async () => {
      throw new Error("device offline");
    };
    const reader = new NotificationChannelMutationPriorReader(new FakeAdbClientFactory(adb));
    expect((await reader.read(ANDROID, rows))[1]).toEqual({ state: "unobservable" });
  });

  test("reads nothing for iOS or other rows", async () => {
    const { adb, reader } = rig(fixture("am-broadcast-query-absent.txt"));
    expect(await reader.read(IOS, rows)).toEqual([
      { state: "unobservable" },
      { state: "unobservable" },
    ]);
    expect(await reader.read(ANDROID, [{ kind: "device-setting", key: "channel:a.b:c" }])).toEqual([
      { state: "unobservable" },
    ]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("the default prior reader merges the channel prior", async () => {
    const { reader } = rig(fixture("am-broadcast-query-absent.txt"));
    const unobservable = { read: async () => rows.map(() => ({ state: "unobservable" as const })) };
    const priors = await new DefaultMutationPriorReader({
      observationReaders: {
        dataReader: unobservable,
        deviceStateReader: unobservable,
        notificationChannelReader: reader,
      },
    }).read(ANDROID, rows);
    expect(priors).toEqual([{ state: "unobservable" }, { state: "absent" }]);
  });
});
