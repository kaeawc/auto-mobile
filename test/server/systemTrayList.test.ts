import { ListInstalledApps } from "../../src/features/observe/ListInstalledApps";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { ToolRegistry } from "../../src/server/toolRegistry";
import Ajv2020 from "ajv/dist/2020";
import generatedDefinitions from "../../schemas/tool-definitions.json";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  listSystemTrayNotifications,
  resolveUniqueTrayAppLabel,
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
} from "../../src/server/systemTrayHelpers";
import { registerInteractionTools, systemTraySchema } from "../../src/server/interactionTools";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import type { BootedDevice, ObserveResult } from "../../src/models";

const device: BootedDevice = {
  deviceId: "test",
  name: "test",
  platform: "android",
  source: "local",
};
const node = (id: string, text = "", children: any[] = []) => ({
  $: { "resource-id": id, text, package: "com.android.systemui", bounds: "[0,200][1000,1600]" },
  node: children,
});
const row = (title: string, app = "Messages") =>
  node("com.android.systemui:id/expandableNotificationRow", "", [
    node("android:id/app_name_text", app),
    node("android:id/title", title),
    node("android:id/text", `Body of ${title}`),
    node("android:id/actions", "", [node("android:id/action0", "Reply")]),
  ]);
const identifiedRow = (title: string, app = "Messages") => {
  const result = row(title, app);
  Object.assign(result.$, { "unique-id": title });
  return result;
};
const positionedRow = (title: string, top: number, app = "Messages") => {
  const result = row(title, app);
  result.$.bounds = `[0,${top}][1000,${top + 100}]`;
  return result;
};
const page = (...rows: any[]): ObserveResult => ({
  updatedAt: 0,
  screenSize: { width: 1080, height: 1920 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy: {
    hierarchy: { node: node("com.android.systemui:id/notification_stack_scroller", "", rows) },
  },
});
function setup(pages: ObserveResult[]) {
  const adb = new FakeAdbExecutor();
  const observer = new FakeObserveScreen();
  let index = 0;
  observer.setObserveResult(() => pages[Math.min(index++, pages.length - 1)]);
  setSystemTrayDependencies({
    adbFactory: () => adb,
    observeScreenFactory: () => observer,
    timer: new FakeTimer(),
  });
  return { adb, observer };
}
const list = () => listSystemTrayNotifications(device, "com.example.messages", "Messages", 5000);
let validateAdvertised: ReturnType<Ajv2020["compile"]>;
let validateGenerated: ReturnType<Ajv2020["compile"]>;
beforeAll(() => {
  registerInteractionTools();
  const definition = ToolRegistry.getToolDefinitions({ includeUnavailable: true }).find(
    (tool) => tool.name === "systemTray",
  )!;
  validateAdvertised = new Ajv2020({ strict: false }).compile(definition.inputSchema);
  validateGenerated = new Ajv2020({ strict: false }).compile(
    generatedDefinitions.find((tool) => tool.name === "systemTray")!.inputSchema,
  );
  ToolRegistry.clearTools();
});
afterEach(() => {
  resetSystemTrayDependencies();
  ToolRegistry.clearTools();
});

describe("systemTray list", () => {
  test("advertised schema requires appId for list without constraining open and close", () => {
    for (const validate of [validateAdvertised, validateGenerated]) {
      for (const notification of [undefined, {}, { title: "Only a title" }, { appId: "" }]) {
        expect(validate({ action: "list", notification })).toBe(false);
      }
      expect(validate({ action: "list", notification: { appId: "com.example.messages" } })).toBe(
        true,
      );
      expect(validate({ action: "open" })).toBe(true);
      expect(validate({ action: "close" })).toBe(true);
    }
  });
  test("does not resample mutable no-ID rows when the tray cannot scroll", async () => {
    const initial = page(row("Download 2/10"));
    Object.assign(initial.viewHierarchy!.hierarchy!.node.$, { scrollable: false });
    setup([initial, page(row("Download 3/10"))]);
    const { notifications, swipes } = await list();
    expect(swipes).toBe(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      title: "Download 2/10",
      body: "Body of Download 2/10",
    });
  });
  test("stops when the tray only exposes backward scrolling", async () => {
    const initial = page(row("Download 2/10"));
    Object.assign(initial.viewHierarchy!.hierarchy!.node.$, {
      scrollable: true,
      actions: ["scroll_backward"],
    });
    setup([initial, page(row("Download 3/10"))]);
    expect((await list()).swipes).toBe(0);
  });
  test("does not overwrite a new page reusing the same screen positions", async () => {
    setup([
      page(positionedRow("A", 200), positionedRow("B", 400)),
      page(positionedRow("C", 200), positionedRow("D", 400)),
    ]);
    expect((await list()).notifications.map((notification) => notification.title)).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });
  test("uses an unchanged neighbor to reconcile changing content after scrolling", async () => {
    setup([
      page(positionedRow("Download 2/10", 300), positionedRow("Neighbor", 500)),
      page(positionedRow("Download 3/10", 200), positionedRow("Neighbor", 400)),
    ]);
    expect((await list()).notifications.map((notification) => notification.title)).toEqual([
      "Download 3/10",
      "Neighbor",
    ]);
  });
  test("keeps identical no-ID rows on adjacent pages without an independent anchor", async () => {
    setup([page(positionedRow("New message", 500)), page(positionedRow("New message", 200))]);
    expect((await list()).notifications).toHaveLength(2);
  });
  test("uses another app's neighbor for alignment but only returns the target app", async () => {
    setup([
      page(positionedRow("Download 2/10", 300), positionedRow("Neighbor", 500, "Other")),
      page(positionedRow("Download 3/10", 200), positionedRow("Neighbor", 400, "Other")),
    ]);
    expect((await list()).notifications.map((notification) => notification.title)).toEqual([
      "Download 3/10",
    ]);
  });
  test("keeps distinct rows revealed at different positions without unique IDs", async () => {
    setup([page(positionedRow("First", 200)), page(positionedRow("Second", 600))]);
    expect((await list()).notifications.map((notification) => notification.title)).toEqual([
      "First",
      "Second",
    ]);
  });
  test("rejects ambiguous installed app labels before scanning", async () => {
    const { adb } = setup([page(row("private"))]);
    const client = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestPackageInfo: async () => ({ success: true, applicationLabel: "Messages" }),
    } as unknown as AndroidCtrlProxyClient);
    try {
      await expect(
        resolveUniqueTrayAppLabel(device, "com.example.messages", [
          "com.example.messages",
          "com.other.messages",
        ]),
      ).rejects.toThrow("multiple installed apps");
      expect(adb.getExecutedCommands()).toEqual([]);
    } finally {
      client.mockRestore();
    }
  });
  test("rejects missing app-label metadata instead of claiming unique ownership", async () => {
    setup([page()]);
    const client = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestPackageInfo: async (appId: string) => ({
        success: true,
        applicationLabel: appId === "com.example.messages" ? "Messages" : undefined,
      }),
    } as unknown as AndroidCtrlProxyClient);
    try {
      await expect(
        resolveUniqueTrayAppLabel(device, "com.example.messages", [
          "com.example.messages",
          "com.other.app",
        ]),
      ).rejects.toThrow("unavailable");
    } finally {
      client.mockRestore();
    }
  });
  test("accepts a unique app label after checking other installed packages", async () => {
    const client = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestPackageInfo: async (appId: string) => ({
        success: true,
        applicationLabel: appId === "com.example.messages" ? "Messages" : "Other",
      }),
    } as unknown as AndroidCtrlProxyClient);
    try {
      expect(
        await resolveUniqueTrayAppLabel(device, "com.example.messages", [
          "com.example.messages",
          "com.other.app",
        ]),
      ).toBe("Messages");
    } finally {
      client.mockRestore();
    }
  });

  test("registered handler returns notification data to the client", async () => {
    setup([page(row("read me"))]);
    const apps = spyOn(ListInstalledApps.prototype, "executeDetailedResult").mockResolvedValue({
      successful: true,
      apps: {
        profiles: {},
        system: [
          { packageName: "com.example.messages", userIds: [0], foreground: false, recent: false },
        ],
      },
    });
    const client = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestPackageInfo: async () => ({ success: true, applicationLabel: "Messages" }),
    } as unknown as AndroidCtrlProxyClient);
    try {
      registerInteractionTools();
      const result = await ToolRegistry.getTool("systemTray")!.deviceAwareHandler!(device, {
        action: "list",
        notification: { appId: "com.example.messages" },
      });
      const payload = JSON.parse(result.content[0].text);
      expect(payload.notifications[0]).toMatchObject({ title: "read me", body: "Body of read me" });
      expect(payload.success).toBe(true);
    } finally {
      apps.mockRestore();
      client.mockRestore();
    }
  });

  test("requires appId without relaxing find or destructive actions", () => {
    expect(
      systemTraySchema.safeParse({
        action: "list",
        notification: { appId: "com.example.messages" },
      }).success,
    ).toBe(true);
    for (const action of ["list", "find", "tap", "dismiss", "clearAll"]) {
      expect(systemTraySchema.safeParse({ action }).success).toBe(false);
    }
    expect(
      systemTraySchema.safeParse({ action: "list", notification: { title: "x" } }).success,
    ).toBe(false);
  });
  test("reads actual contents and actions, excludes other apps and scans three swipes", async () => {
    const { adb } = setup([
      page(identifiedRow("one"), identifiedRow("Messages", "Other")),
      page(identifiedRow("one"), identifiedRow("two")),
      page(identifiedRow("three")),
      page(identifiedRow("four")),
      page(identifiedRow("five")),
    ]);
    const result = await list();
    expect(result.notifications.map((n) => n.title)).toEqual(["one", "two", "three", "four"]);
    expect(result.notifications[0]).toMatchObject({
      appId: "com.example.messages",
      appLabel: "Messages",
      body: "Body of one",
      actions: ["Reply"],
    });
    expect(result.swipes).toBe(3);
    expect(adb.getExecutedCommands().filter((c) => c.startsWith("shell input swipe"))).toHaveLength(
      3,
    );
  });
  test("stops on an unchanged page and returns an empty list", async () => {
    setup([page(row("Other notification", "Other"))]);
    const result = await list();
    expect(result.notifications).toEqual([]);
    expect(result.swipes).toBe(1);
  });
  test("reads semantic fields nested inside notification content wrappers", async () => {
    setup([
      page(
        node("com.android.systemui:id/expandableNotificationRow", "", [
          node("android:id/app_name_text", "Messages"),
          node("android:id/notification_main_column", "", [
            node("android:id/title", "Wrapped title"),
            node("android:id/text", "Wrapped body"),
          ]),
        ]),
      ),
    ]);
    expect((await list()).notifications[0]).toMatchObject({
      title: "Wrapped title",
      body: "Wrapped body",
    });
  });
  test("reads Android MessagingStyle conversation titles and message bodies", async () => {
    setup([
      page(
        node("com.android.systemui:id/expandableNotificationRow", "", [
          node("android:id/app_name_text", "Messages"),
          node("android:id/conversation_text", "Sender"),
          node("android:id/message_text", "First message"),
          node("android:id/message_text", "Second message"),
          node("android:id/action0", "Reply"),
        ]),
      ),
    ]);
    expect((await list()).notifications[0]).toMatchObject({
      title: "Sender",
      body: "First message\nSecond message",
      actions: ["Reply"],
    });
  });
  test("uses stable row identity when notification text changes", async () => {
    const first = row("progress");
    Object.assign(first.$, { "unique-id": "notification-1" });
    const updated = row("updated progress");
    Object.assign(updated.$, { "unique-id": "notification-1" });
    setup([page(first), page(updated)]);
    expect((await list()).notifications).toHaveLength(1);
  });
  test("ignores changing chronometer text with an independent neighboring anchor", async () => {
    const first = row("timer");
    first.node.push(node("android:id/chronometer", "00:01"));
    const next = row("timer");
    next.node.push(node("android:id/chronometer", "00:02"));
    setup([page(first, row("neighbor")), page(next, row("neighbor"))]);
    expect((await list()).notifications).toHaveLength(2);
  });
  test("retains equal contents seen again after an intervening page", async () => {
    setup([
      page(positionedRow("same", 200)),
      page(positionedRow("middle", 500)),
      page(positionedRow("same", 700)),
    ]);
    expect((await list()).notifications.map((notification) => notification.title)).toEqual([
      "same",
      "middle",
      "same",
    ]);
  });
  test("reads an app header inside the group children container", async () => {
    const group = node("com.android.systemui:id/expandableNotificationRow", "", [
      node("com.android.systemui:id/notification_children_container", "", [
        node("android:id/notification_header", "", [node("android:id/app_name_text", "Messages")]),
        row("inside", ""),
      ]),
    ]);
    setup([page(group)]);
    expect((await list()).notifications).toMatchObject([{ title: "inside", inGroup: true }]);
  });
  test("retains identical notifications on the same page", async () => {
    setup([page(row("same"), row("same"))]);
    expect((await list()).notifications).toHaveLength(2);
  });
  test("reads children of collapsed groups using their parent app header", async () => {
    const child = row("grouped", "");
    const group = node("com.android.systemui:id/expandableNotificationRow", "", [
      node("android:id/app_name_text", "Messages"),
      node("com.android.systemui:id/notification_children_container", "", [child]),
    ]);
    setup([page(group)]);
    expect((await list()).notifications).toMatchObject([
      { title: "grouped", body: "Body of grouped", inGroup: true },
    ]);
  });
  test("opens the shade before listing", async () => {
    const { adb } = setup([page(row("opened"))]);
    expect((await list()).notifications[0].title).toBe("opened");
    expect(adb.getExecutedCommands().slice(0, 2)).toEqual([
      "shell cmd statusbar collapse",
      "shell cmd statusbar expand-notifications",
    ]);
  });
  test("rejects unsupported platforms before interaction", async () => {
    const { adb } = setup([page()]);
    await expect(
      listSystemTrayNotifications({ ...device, platform: "ios" }, "app", "App", 5000),
    ).rejects.toThrow("Android");
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});
