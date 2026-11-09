import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  notificationChannelBroadcastCommand,
  notificationChannelBroadcastState,
  postedNotificationChannel,
  postedNotificationChannelKey,
} from "../../../src/daemon/sessionBroker/mutations/postedNotification";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-notification-channel", name), "utf8");

describe("posted notification channel keys (#16510)", () => {
  test("names the caller's channel, or the SDK default when none is given", () => {
    expect(postedNotificationChannelKey("com.example.app", "orders-v2")).toBe(
      "channel:com.example.app:orders-v2",
    );
    expect(postedNotificationChannelKey("com.example.app", undefined)).toBe(
      "channel:com.example.app:automobile_test_notifications",
    );
    // The host does not send an empty channelId, so the SDK posts to its default channel.
    expect(postedNotificationChannelKey("com.example.app", "")).toBe(
      "channel:com.example.app:automobile_test_notifications",
    );
  });

  test.each([
    ["com.example.app", "  "],
    ["com.example.app", "has space"],
    ["com.example.app", "a'b"],
    ["com.example.app", "a:b"],
    ["com.example.app", 7],
    ["com.example.app", "x".repeat(201)],
    ["not a package", "orders"],
  ])("%p / %p cannot be named", (appId, channelId) => {
    expect(postedNotificationChannelKey(appId, channelId)).toBeUndefined();
  });

  test("parses only well-formed channel keys", () => {
    expect(postedNotificationChannel("channel:com.example.app:orders-v2")).toEqual({
      appId: "com.example.app",
      channelId: "orders-v2",
    });
    expect(postedNotificationChannel("posted:com.example.app")).toBeUndefined();
    expect(postedNotificationChannel("channel:com.example.app")).toBeUndefined();
    expect(postedNotificationChannel("channel::orders")).toBeUndefined();
    expect(postedNotificationChannel("channel:com.example;reboot:orders")).toBeUndefined();
    expect(postedNotificationChannel("channel:com.example.app:a b")).toBeUndefined();
  });

  test("builds the explicit SDK receiver broadcast for each action", () => {
    const channel = { appId: "com.example.app", channelId: "orders-v2" };
    expect(notificationChannelBroadcastCommand(channel, "delete")).toBe(
      "shell am broadcast --include-stopped-packages -n 'com.example.app/dev.jasonpearson.automobile.sdk.notifications.AutoMobileNotificationReceiver' -a dev.jasonpearson.automobile.sdk.NOTIFICATION_CHANNEL_DELETE --es channel_id 'orders-v2'",
    );
    expect(notificationChannelBroadcastCommand(channel, "query")).toContain(
      "-a dev.jasonpearson.automobile.sdk.NOTIFICATION_CHANNEL_QUERY ",
    );
  });

  test.each<[string, "absent" | "present" | undefined]>([
    ["am-broadcast-query-absent.txt", "absent"],
    ["am-broadcast-delete-absent.txt", "absent"],
    ["am-broadcast-query-present.txt", "present"],
    ["am-broadcast-delete-present.txt", "present"],
    ["am-broadcast-query-old-sdk.txt", undefined],
  ])("reads %s as %p", (name, state) => {
    expect(notificationChannelBroadcastState(fixture(name))).toBe(state);
  });

  test.each([
    "",
    'Broadcast completed: result=3, data="x"',
    "Broadcast completed: result=3\nBroadcast completed: result=3",
    "Error: Bad component name\nBroadcast completed: result=3",
    "Broadcasting: Intent { act=x }\n",
  ])("%p is not an answer", (output) => {
    expect(notificationChannelBroadcastState(output)).toBeUndefined();
  });
});
