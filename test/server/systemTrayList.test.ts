import { ToolRegistry } from "../../src/server/toolRegistry";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileAjv2020 } from "../helpers/jsonSchemaCompile";
import generatedDefinitions from "../../schemas/tool-definitions.json";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  listSystemTrayNotifications,
  NotificationShadeNotOpenError,
  waitForNotificationMatch,
  resolveUniqueTrayAppLabel,
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
  type SystemTrayDependencies,
} from "../../src/server/systemTrayHelpers";
import { registerInteractionTools, systemTraySchema } from "../../src/server/interactionTools";
import {
  ListInstalledApps,
  type IosInstalledAppsDetailedResult,
} from "../../src/features/observe/ListInstalledApps";
import { getIosInstalledAppBundleId } from "../../src/utils/ios-cmdline-tools/iosInstalledApp";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";
import type { BootedDevice, ObserveResult } from "../../src/models";

const device: BootedDevice = {
  deviceId: "test",
  name: "test",
  platform: "android",
  source: "local",
};
const headerlessTwoNotificationGroups = {
  collapsed: (
    JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "../fixtures/observe/ctrlproxy-headerless-two-notification-group-collapsed.json",
        ),
        "utf8",
      ),
    ) as ObserveResult
  ).viewHierarchy,
  expanded: (
    JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "../fixtures/observe/ctrlproxy-headerless-two-notification-group-expanded.json",
        ),
        "utf8",
      ),
    ) as ObserveResult
  ).viewHierarchy,
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
// API 35 includes this explicit scroll state on the notification scroller.
const api35Page = (...rows: any[]): ObserveResult => {
  const result = page(...rows);
  Object.assign(result.viewHierarchy!.hierarchy!.node.$, { scrollable: true });
  return result;
};
// Before API 33, the extractor omits `scrollable` when the scroller cannot move.
const preApi33Page = (...rows: any[]): ObserveResult => page(...rows);
function setup(pages: ObserveResult[], markScrollBoundary = true) {
  for (const [index, page] of pages.entries()) {
    if (markScrollBoundary && page.viewHierarchy!.hierarchy!.node.$.scrollable === undefined) {
      Object.assign(page.viewHierarchy!.hierarchy!.node.$, {
        scrollable: index < pages.length - 1,
      });
    }
  }
  const adb = new FakeAdbExecutor();
  const observer = new FakeObserveScreen();
  const timer = new FakeTimer();
  // A real tray only changes when a scroll gesture moves it, so page turns are
  // driven by executed swipes rather than by observation count. That keeps
  // settle polling (which re-observes without swiping) reading one page.
  observer.setObserveResult(() => {
    const swipes = adb
      .getExecutedCommands()
      .filter((command) => command.startsWith("shell input swipe")).length;
    return pages[Math.min(swipes, pages.length - 1)];
  });
  setSystemTrayDependencies({
    adbFactory: () => adb,
    observeScreenFactory: () => observer,
    timer,
  });
  return { adb, observer, timer };
}
const list = () => listSystemTrayNotifications(device, "com.example.messages", "Messages", 5000);
class FakeTrayApps {
  labels = new Map<string, string | null>([["com.example.messages", "Messages"]]);
  calls: string[] = [];
  inventorySignals: (AbortSignal | undefined)[] = [];
  resolve: SystemTrayDependencies["appLabelResolver"] = async (_device, appId) => {
    this.calls.push(appId);
    return this.labels.get(appId) ?? null;
  };
  inventory: SystemTrayDependencies["appInventoryFactory"] = () => ({
    executeDetailedResult: async (signal?: AbortSignal) => {
      this.inventorySignals.push(signal);
      signal?.throwIfAborted();
      return {
        successful: true,
        apps: {
          profiles: {},
          system: [...this.labels.keys()].map((packageName) => ({
            packageName,
            userIds: [0],
            foreground: false,
            recent: false,
          })),
        },
      };
    },
  });
  install() {
    setSystemTrayDependencies({
      appLabelResolver: this.resolve,
      appInventoryFactory: this.inventory,
    });
  }
}
let validateAdvertised: ReturnType<typeof compileAjv2020>;
let validateGenerated: ReturnType<typeof compileAjv2020>;
beforeAll(() => {
  registerInteractionTools();
  const definition = ToolRegistry.getToolDefinitions({ includeUnavailable: true }).find(
    (tool) => tool.name === "systemTray",
  )!;
  validateAdvertised = compileAjv2020(definition.inputSchema);
  validateGenerated = compileAjv2020(
    generatedDefinitions.find((tool) => tool.name === "systemTray")!.inputSchema,
  );
  ToolRegistry.clearTools();
});
afterEach(() => {
  resetSystemTrayDependencies();
  ToolRegistry.clearTools();
});

describe("systemTray iOS app inventory", () => {
  const iosDevice: BootedDevice = { ...device, platform: "ios" };
  const appId = "com.example.messages";
  let restoreLegacyInventory: (() => void) | undefined;

  afterEach(() => {
    restoreLegacyInventory?.();
    restoreLegacyInventory = undefined;
  });

  const installInventory = (result: IosInstalledAppsDetailedResult, onRead?: () => void) => {
    const apps = new FakeTrayApps();
    const inventoryCalls: string[] = [];
    // Keep the pre-fix path local too; it collapses failed listings to [].
    const legacySpy = spyOn(ListInstalledApps.prototype, "execute").mockResolvedValue(
      result.apps.map(getIosInstalledAppBundleId).filter((id): id is string => id !== undefined),
    );
    restoreLegacyInventory = () => legacySpy.mockRestore();
    setSystemTrayDependencies({
      timer: new FakeTimer(),
      appInventoryFactory: (target) => ({
        ...apps.inventory(target),
        executeIosDetailedResult: async () => {
          inventoryCalls.push("ios");
          onRead?.();
          return result;
        },
      }),
      appLabelResolver: async (target, id, signal) => {
        await apps.resolve(target, id, signal);
        throw new Error("label resolver reached");
      },
    });
    registerInteractionTools();
    return { apps, inventoryCalls, legacySpy };
  };
  const invoke = (action: "find" | "tap", signal?: AbortSignal) =>
    ToolRegistry.getTool("systemTray")!.deviceAwareHandler!(
      iosDevice,
      { action, notification: { appId } },
      undefined,
      signal,
    );

  for (const action of ["find", "tap"] as const) {
    test(`${action} reports a failed iOS app listing with its underlying reason`, async () => {
      const { apps, inventoryCalls, legacySpy } = installInventory({
        apps: [],
        successful: false,
        error: new Error("simctl timed out"),
      });
      const failure = invoke(action);
      await expect(failure).rejects.toThrow("installed apps could not be listed");
      await expect(failure).rejects.toThrow("inventory is incomplete");
      await expect(failure).rejects.toThrow("simctl timed out");
      await expect(failure).rejects.not.toThrow("is not installed");
      expect(inventoryCalls).toEqual(["ios"]);
      expect(legacySpy).not.toHaveBeenCalled();
      expect(apps.calls).toEqual([]);
    });
  }

  test("reports an incomplete iOS inventory without an underlying error", async () => {
    installInventory({ apps: [], successful: false });
    await expect(invoke("find")).rejects.toThrow("installed-app inventory is incomplete.");
  });

  test("fails closed when an injected inventory has no iOS listing method", async () => {
    const { apps } = installInventory({ apps: [], successful: true });
    setSystemTrayDependencies({ appInventoryFactory: apps.inventory });
    await expect(invoke("find")).rejects.toThrow("installed apps could not be listed");
    expect(apps.calls).toEqual([]);
  });

  test("keeps the not-installed error after a successful empty listing", async () => {
    const { apps } = installInventory({ apps: [], successful: true });
    await expect(invoke("find")).rejects.toThrow(`App ${appId} is not installed.`);
    expect(apps.calls).toEqual([]);
  });

  for (const key of ["CFBundleIdentifier", "bundleIdentifier"] as const) {
    test(`resolves the label after a successful listing with ${key}`, async () => {
      const { apps } = installInventory({ apps: [{ [key]: appId }], successful: true });
      await expect(invoke("find")).rejects.toThrow("label resolver reached");
      expect(apps.calls).toEqual([appId]);
    });
  }

  test("cancels an already-aborted request before reading the iOS inventory", async () => {
    const { apps, inventoryCalls, legacySpy } = installInventory({
      apps: [],
      successful: false,
      error: new Error("simctl timed out"),
    });
    await expect(invoke("find", AbortSignal.abort())).rejects.toThrow("cancelled");
    expect(inventoryCalls).toEqual([]);
    expect(legacySpy).not.toHaveBeenCalled();
    expect(apps.calls).toEqual([]);
  });

  test("cancellation during a failed iOS listing takes precedence over inventory failure", async () => {
    const controller = new AbortController();
    const { apps, inventoryCalls } = installInventory(
      { apps: [], successful: false, error: new Error("simctl timed out") },
      () => controller.abort(),
    );
    await expect(invoke("find", controller.signal)).rejects.toThrow("cancelled");
    expect(inventoryCalls).toEqual(["ios"]);
    expect(apps.calls).toEqual([]);
  });

  test("cancels while waiting for an iOS listing that has not settled", async () => {
    const controller = new AbortController();
    const { apps } = installInventory({ apps: [], successful: true });
    const pendingInventory = new Promise<IosInstalledAppsDetailedResult>(() => {});
    setSystemTrayDependencies({
      appInventoryFactory: (target) => ({
        ...apps.inventory(target),
        executeIosDetailedResult: () => pendingInventory,
      }),
    });
    const operation = invoke("find", controller.signal);
    controller.abort();
    await expect(operation).rejects.toThrow("cancelled");
    expect(apps.calls).toEqual([]);
  });
});

describe("systemTray list", () => {
  test("closes the shade after scanning so follow-up actions reopen at the top", async () => {
    const { adb } = setup([page(identifiedRow("first")), page(identifiedRow("next"))]);
    await list();
    expect(adb.getExecutedCommands().at(-1)).toBe("shell cmd statusbar collapse");
  });
  test("does no device work for an already cancelled list", async () => {
    const { adb } = setup([page(row("first"))]);
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(
      listSystemTrayNotifications(
        device,
        "com.example.messages",
        "Messages",
        5000,
        undefined,
        signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(adb.getExecutedCommands()).toEqual([]);
  });
  test("stops swiping and cleanup when cancellation arrives during observation", async () => {
    const { adb, observer } = setup([page(row("first"))]);
    const controller = new AbortController();
    observer.setObserveResult(() => {
      controller.abort(new Error("cancelled"));
      return page(row("first"));
    });
    await expect(
      listSystemTrayNotifications(
        device,
        "com.example.messages",
        "Messages",
        5000,
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd statusbar collapse",
      "shell cmd statusbar expand-notifications",
    ]);
  });
  test("stops label resolution before another package batch after cancellation", async () => {
    const apps = new FakeTrayApps();
    const controller = new AbortController();
    apps.install();
    setSystemTrayDependencies({
      appLabelResolver: async (device, id, signal) => {
        const result = await apps.resolve(device, id, signal);
        if (id !== "com.example.messages") {
          controller.abort(new Error("cancelled"));
        }
        return result;
      },
    });
    await expect(
      resolveUniqueTrayAppLabel(
        device,
        "com.example.messages",
        Array.from({ length: 20 }, (_, i) => `com.other.${i}`),
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(apps.calls).toHaveLength(9);
  });
  test("advertised schema leaves list appId selection to runtime", () => {
    for (const validate of [validateAdvertised, validateGenerated]) {
      for (const notification of [undefined, {}, { title: "Only a title" }]) {
        expect(validate({ action: "list", notification })).toBe(true);
      }
      expect(validate({ action: "list", notification: { appId: "" } })).toBe(false);
      expect(validate({ action: "list", notification: { appId: "com.example.messages" } })).toBe(
        true,
      );
      expect(
        validate({ action: "list", notification: { packageName: "com.example.messages" } }),
      ).toBe(true);
      expect(validate({ action: "list", notification: { bundleId: "com.example.messages" } })).toBe(
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
    const apps = new FakeTrayApps();
    apps.labels.set("com.other.messages", "Messages");
    apps.install();
    await expect(
      resolveUniqueTrayAppLabel(device, "com.example.messages", [
        "com.example.messages",
        "com.other.messages",
      ]),
    ).rejects.toThrow("multiple installed apps");
    expect(adb.getExecutedCommands()).toEqual([]);
  });
  test("rejects missing app-label metadata instead of claiming unique ownership", async () => {
    setup([page()]);
    new FakeTrayApps().install();
    await expect(
      resolveUniqueTrayAppLabel(device, "com.example.messages", [
        "com.example.messages",
        "com.other.app",
      ]),
    ).rejects.toThrow("unavailable");
  });
  test("accepts a unique app label after checking other installed packages", async () => {
    const apps = new FakeTrayApps();
    apps.labels.set("com.other.app", "Other");
    apps.install();
    expect(
      await resolveUniqueTrayAppLabel(device, "com.example.messages", [
        "com.example.messages",
        "com.other.app",
      ]),
    ).toBe("Messages");
  });

  test("registered handler returns notification data to the client", async () => {
    setup([page(row("read me"))]);
    new FakeTrayApps().install();
    registerInteractionTools();
    const result = await ToolRegistry.getTool("systemTray")!.deviceAwareHandler!(device, {
      action: "list",
      notification: { appId: "com.example.messages" },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.notifications[0]).toMatchObject({ title: "read me", body: "Body of read me" });
    expect(payload.success).toBe(true);
  });
  test("passes the request signal into the fresh app inventory", async () => {
    setup([page(row("read me"))]);
    const apps = new FakeTrayApps();
    apps.install();
    registerInteractionTools();
    const controller = new AbortController();
    await ToolRegistry.getTool("systemTray")!.deviceAwareHandler!(
      device,
      { action: "list", notification: { appId: "com.example.messages" } },
      undefined,
      controller.signal,
    );
    expect(apps.inventorySignals).toEqual([controller.signal]);
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
  test("continues a bounded scan when an unidentifiable page repeats", async () => {
    const repeated = page(row("Other notification", "Other"));
    delete repeated.viewHierarchy!.hierarchy!.node.$.scrollable;
    setup([repeated], false);
    const result = await list();
    expect(result.notifications).toEqual([]);
    // #6904: omitted pre-API-33 metadata means the notification scroller is at its end.
    expect(result.swipes).toBe(0);
  });

  test("lists a pre-API-33 single-notification tray once without swiping", async () => {
    const legacyTray = preApi33Page(row("Only once"));
    setup([legacyTray], false);

    const result = await list();

    expect(result.swipes).toBe(0);
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]).toMatchObject({ title: "Only once" });
  });

  test("keeps scanning an API 35 tray whose scroller is explicitly scrollable", async () => {
    const currentTray = api35Page(row("First"));
    const end = page(row("Second"));
    Object.assign(end.viewHierarchy!.hierarchy!.node.$, { scrollable: false });
    setup([currentTray, end], false);

    expect((await list()).swipes).toBe(1);
  });
  test("retains identical no-ID pages because they may represent different notifications", async () => {
    setup([page(positionedRow("Generic", 200)), page(positionedRow("Generic", 200))]);
    expect((await list()).notifications).toHaveLength(2);
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
  test("preserves repeated messages within a MessagingStyle layout", async () => {
    const notification = row("Conversation");
    notification.node.push(
      node("android:id/message_text", "OK"),
      node("android:id/message_text", "OK"),
    );
    setup([page(notification)]);
    expect((await list()).notifications[0].body).toBe("OK\nOK");
  });
  test("selects the fuller MessagingStyle layout without duplicating compact contents", async () => {
    const notification = row("Conversation");
    notification.node.push(
      node("android:id/messaging_linear_layout", "", [node("android:id/message_text", "OK")]),
      node("android:id/messaging_linear_layout", "", [
        node("android:id/message_text", "OK"),
        node("android:id/message_text", "OK"),
      ]),
    );
    setup([page(notification)]);
    expect((await list()).notifications[0].body).toBe("OK\nOK");
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
  test("lists both real headerless children and retains the neighboring row as unattributed", async () => {
    const fixture = headerlessTwoNotificationGroups.expanded!;
    setup([{ ...page(), viewHierarchy: fixture }], false);
    const result = await listSystemTrayNotifications(device, "com.android.shell", "Shell", 5000);
    expect(result.notifications).toMatchObject([
      { title: "Delta", inGroup: true },
      { title: "Gamma", inGroup: true },
    ]);
    expect(result.unattributedRows).toBe(1);
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
  test("keeps hierarchy text candidates that differ from the rendered text", async () => {
    const notification = row("Photo");
    notification.node.push({
      $: {
        "resource-id": "android:id/big_picture",
        text: "1 new photo",
        "content-desc": "Sunset over the bay",
        package: "com.android.systemui",
        bounds: "[0,200][1000,1600]",
      },
      node: [],
    });
    setup([page(notification)]);
    expect((await list()).notifications[0].texts).toEqual(
      expect.arrayContaining(["1 new photo", "Sunset over the bay"]),
    );
  });
  test("reconciles a scrolled page only after the tray stops moving", async () => {
    const adb = new FakeAdbExecutor();
    const observer = new FakeObserveScreen();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const initial = page(positionedRow("A", 500), positionedRow("B", 700));
    Object.assign(initial.viewHierarchy!.hierarchy!.node.$, { scrollable: true });
    // Mid-fling rows have not translated by a single consistent offset yet, so
    // reconciling against them appends the same notifications a second time.
    const midFling = page(positionedRow("A", 440), positionedRow("B", 630));
    Object.assign(midFling.viewHierarchy!.hierarchy!.node.$, { scrollable: true });
    const settled = page(positionedRow("A", 400), positionedRow("B", 600));
    Object.assign(settled.viewHierarchy!.hierarchy!.node.$, { scrollable: false });
    observer.setObserveSequence([initial, midFling, settled, settled, settled]);
    setSystemTrayDependencies({
      adbFactory: () => adb,
      observeScreenFactory: () => observer,
      timer,
    });
    const result = await list();
    expect(result.notifications.map((notification) => notification.title)).toEqual(["A", "B"]);
    expect(result.swipes).toBe(1);
  });
  test("rejects unsupported platforms before interaction", async () => {
    const { adb } = setup([page()]);
    await expect(
      listSystemTrayNotifications({ ...device, platform: "ios" }, "app", "App", 5000),
    ).rejects.toThrow("Android");
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});

// The Silent (low-importance) section renders rows without the per-row app-name
// header, so the shade alone cannot say who posted them (#6875).
describe("systemTray list silent-section ownership", () => {
  const WELLBEING = "com.google.android.apps.wellbeing";
  const MESSAGING = "com.google.android.apps.messaging";
  const SLEEP_TITLE = "Need better sleep?";
  const SLEEP_BODY = "Use Bedtime mode to silence your phone and keep the screen dark at bedtime";
  const execResult = (stdout: string) => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  });
  // Exactly the two rows observed in #6875: the messaging row carries its app
  // name, the wellbeing row carries no app name anywhere in the row.
  const silentRow = (title: string, body: string) =>
    node("com.android.systemui:id/expandableNotificationRow", "", [
      node("android:id/title", title),
      node("android:id/text", body),
    ]);
  const shade = () => page(row("(555) 123-4567"), silentRow(SLEEP_TITLE, SLEEP_BODY));
  const dumpsys = (...records: string[]) =>
    ["Current Notification Manager state:", "  Notification List:", ...records].join("\n");
  const record = (pkg: string, title: string, text: string) =>
    [
      `    NotificationRecord(0x1: pkg=${pkg} user=UserHandle{0} id=0 tag=null key=0|${pkg}|0|null|10164)`,
      "      extras={",
      `        android.title=String (${title})`,
      `        android.text=String (${text})`,
      "      }",
    ].join("\n");

  test("attributes a Silent-section row to its package via dumpsys", async () => {
    const { adb } = setup([shade()]);
    adb.setCommandResponse(
      "dumpsys notification",
      execResult(dumpsys(record(WELLBEING, SLEEP_TITLE, SLEEP_BODY))),
    );
    const result = await listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000);
    expect(result.notifications).toMatchObject([
      { appId: WELLBEING, title: SLEEP_TITLE, body: SLEEP_BODY, ownership: "dumpsys" },
    ]);
    expect(result.unattributedRows).toBe(0);
    expect(adb.getExecutedCommands()).toContain("shell dumpsys notification --noredact");
  });

  test("attributes a Silent-section row when before and after dumpsys snapshots agree", async () => {
    const { adb } = setup([shade()]);
    const snapshot = execResult(dumpsys(record(WELLBEING, SLEEP_TITLE, SLEEP_BODY)));
    adb.setCommandResponseSequence("dumpsys notification", [snapshot, snapshot]);

    const result = await listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000);

    expect(result.notifications).toMatchObject([{ appId: WELLBEING, ownership: "dumpsys" }]);
    expect(adb.getExecutedCommands().filter((command) => command.includes("dumpsys"))).toHaveLength(
      2,
    );
  });

  test("keeps header evidence for rows SystemUI does label", async () => {
    const { adb } = setup([shade()]);
    adb.setCommandResponse(
      "dumpsys notification",
      execResult(dumpsys(record(WELLBEING, SLEEP_TITLE, SLEEP_BODY))),
    );
    const result = await listSystemTrayNotifications(device, MESSAGING, "Messages", 5000);
    expect(result.notifications).toMatchObject([
      { appId: MESSAGING, title: "(555) 123-4567", ownership: "header" },
    ]);
    expect(result.unattributedRows).toBe(0);
  });

  test("reports unattributed rows instead of a confident empty list", async () => {
    setup([shade()]);
    const result = await listSystemTrayNotifications(device, "com.other.app", "Other", 5000);
    expect(result.notifications).toEqual([]);
    expect(result.unattributedRows).toBe(1);
  });

  test("does not claim a header-less row two packages could have posted", async () => {
    const { adb } = setup([shade()]);
    adb.setCommandResponse(
      "dumpsys notification",
      execResult(
        dumpsys(
          record(WELLBEING, SLEEP_TITLE, SLEEP_BODY),
          record("com.other.clone", SLEEP_TITLE, SLEEP_BODY),
        ),
      ),
    );
    // #6875: records for this package exist, so an ambiguous shade row is not a confident empty list.
    await expect(
      listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000),
    ).rejects.toThrow(/com\.google\.android\.apps\.wellbeing.*could not be correlated/i);
  });

  test("does not claim a row when a competing before-snapshot record was dismissed", async () => {
    const { adb } = setup([shade()]);
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(
        dumpsys(
          record(WELLBEING, SLEEP_TITLE, SLEEP_BODY),
          record("com.other.dismissed", SLEEP_TITLE, SLEEP_BODY),
        ),
      ),
      execResult(dumpsys(record(WELLBEING, SLEEP_TITLE, SLEEP_BODY))),
    ]);

    await expect(
      listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000),
    ).rejects.toThrow(/com\.google\.android\.apps\.wellbeing.*could not be correlated/i);
  });

  test("falls back to after-only ownership when the before dumpsys read fails", async () => {
    const { adb } = setup([shade()]);
    adb.setCommandResponse(
      "dumpsys notification",
      execResult(dumpsys(record(WELLBEING, SLEEP_TITLE, SLEEP_BODY))),
    );
    const executeCommand = adb.executeCommand.bind(adb);
    let dumpsysReads = 0;
    adb.executeCommand = async (...args) => {
      if (args[0].includes("dumpsys notification") && ++dumpsysReads === 1) {
        throw new Error("dumpsys unavailable");
      }
      return executeCommand(...args);
    };

    const result = await listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000);

    expect(result.notifications).toMatchObject([{ appId: WELLBEING, ownership: "dumpsys" }]);
    expect(result.unattributedRows).toBe(0);
  });

  test("does not retry the before snapshot after a swipe once the first read fails", async () => {
    // Two header-less pages: the stale first-page row is retained while the
    // second page is scanned. The competitor's matching record disappears
    // during the swipe (its body updates), leaving a record that only shares
    // the title. Reading a "before" snapshot after that swipe would uniquely
    // match the requested package and claim the stale row; after-only
    // correlation keeps the shared title ambiguous.
    const { adb } = setup([
      page(silentRow(SLEEP_TITLE, SLEEP_BODY)),
      page(silentRow("Second page", "Second page body")),
    ]);
    adb.setCommandResponse(
      "dumpsys notification",
      execResult(
        dumpsys(
          record(WELLBEING, SLEEP_TITLE, SLEEP_BODY),
          record("com.other.clone", SLEEP_TITLE, "Updated during the swipe"),
        ),
      ),
    );
    const executeCommand = adb.executeCommand.bind(adb);
    let dumpsysReads = 0;
    adb.executeCommand = async (...args) => {
      if (args[0].includes("dumpsys notification") && ++dumpsysReads === 1) {
        throw new Error("dumpsys unavailable");
      }
      return executeCommand(...args);
    };

    const result = await listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000);

    expect(result.swipes).toBe(1);
    expect(result.notifications).toEqual([]);
    expect(result.unattributedRows).toBe(2);
    // The failed before read and the single after read; no post-swipe retry.
    expect(dumpsysReads).toBe(2);
  });

  test("throws when dumpsys proves the requested app posted but no rendered row matches", async () => {
    const { adb } = setup([page(silentRow("Rendered later", "The shade text changed"))]);
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(dumpsys(record(WELLBEING, SLEEP_TITLE, SLEEP_BODY))),
      execResult(dumpsys(record(WELLBEING, SLEEP_TITLE, SLEEP_BODY))),
    ]);

    await expect(
      listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000),
    ).rejects.toThrow(/notification records.*could not be correlated/i);
  });

  test("does not attribute a stale other-app row when only after-scan evidence remains", async () => {
    const { adb } = setup([shade()]);
    // The other app's stale row was visible when scanning started, then was dismissed.
    // The requested app only appears in the after snapshot, so its record is not stable evidence.
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(dumpsys(record("com.example.dismissed", SLEEP_TITLE, SLEEP_BODY))),
      execResult(dumpsys(record(WELLBEING, SLEEP_TITLE, SLEEP_BODY))),
    ]);

    await expect(
      listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000),
    ).rejects.toThrow(/com\.google\.android\.apps\.wellbeing.*could not be correlated/i);
  });

  test("does not read dumpsys when every row carries an app header", async () => {
    const { adb } = setup([page(row("one"))]);
    await list();
    expect(adb.getExecutedCommands().some((command) => command.includes("dumpsys"))).toBe(false);
  });

  test("surfaces unattributed rows through the registered handler message", async () => {
    setup([shade()]);
    const apps = new FakeTrayApps();
    apps.labels.set("com.example.messages", "Other");
    apps.install();
    registerInteractionTools();
    const result = await ToolRegistry.getTool("systemTray")!.deviceAwareHandler!(device, {
      action: "list",
      notification: { appId: "com.example.messages" },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.notifications).toEqual([]);
    expect(payload.unattributedRows).toBe(1);
    expect(payload.message).toContain("1 shade row");
  });
});

describe("systemTray list content-less custom layouts", () => {
  const CLOCK = "com.google.android.deskclock";
  const clockLabel = "Clock";
  const execResult = (stdout: string) => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  });
  // Clock renders its label under structural notification-header chrome, rather
  // than the app-name resource ids read as `notification.appLabel`.
  const customLayoutRow = (label: string) =>
    node("com.android.systemui:id/expandableNotificationRow", "", [
      node("com.android.systemui:id/notification_header", "", [
        node("com.android.systemui:id/custom_app_name_text", label),
      ]),
      node("android:id/chronometer", "00:09:57"),
    ]);
  const dumpsys = (...records: string[]) =>
    ["Current Notification Manager state:", "  Notification List:", ...records].join("\n");
  const customRecord = (title: string | null = null) =>
    [
      `    NotificationRecord(0x06b3f5ad: pkg=${CLOCK} user=UserHandle{0} id=2147483641 tag=null key=0|${CLOCK}|2147483641|null|10163: Notification(channel=Timers contentView=${CLOCK}/0x7f0e0042))`,
      `      contentView=${CLOCK}/0x7f0e0042 (0 bytes): android.widget.RemoteViews@224e730`,
      "      extras={",
      `        android.title=${title === null ? "null" : `String (${title})`}`,
      "        android.template=String (android.app.Notification$DecoratedCustomViewStyle)",
      "        android.text=null",
      "      }",
    ].join("\n");

  test("uses a generic rendered app label for an all-content-less custom layout", async () => {
    const { adb } = setup([page(customLayoutRow(clockLabel))]);
    const snapshot = execResult(dumpsys(customRecord()));
    adb.setCommandResponseSequence("dumpsys notification", [snapshot, snapshot]);

    const result = await listSystemTrayNotifications(device, CLOCK, clockLabel, 5000);

    expect(result.notifications).toMatchObject([{ appId: CLOCK, ownership: "header" }]);
    expect(result.unattributedRows).toBe(0);
  });

  test("keeps a content-less custom row when the package also has an ordinary record", async () => {
    const { adb } = setup([page(customLayoutRow(clockLabel), row("Ordinary", clockLabel))]);
    const snapshot = execResult(dumpsys(customRecord(), customRecord("Ordinary")));
    adb.setCommandResponseSequence("dumpsys notification", [snapshot, snapshot]);

    const result = await listSystemTrayNotifications(device, CLOCK, clockLabel, 5000);

    expect(result.notifications).toHaveLength(2);
    expect(result.notifications.map((notification) => notification.ownership)).toEqual([
      "header",
      "header",
    ]);
    expect(result.unattributedRows).toBe(0);
  });

  test("fails closed when a content-less custom layout lacks rendered app-label evidence", async () => {
    const { adb } = setup([page(customLayoutRow("Timer"))]);
    const snapshot = execResult(dumpsys(customRecord()));
    adb.setCommandResponseSequence("dumpsys notification", [snapshot, snapshot]);

    await expect(listSystemTrayNotifications(device, CLOCK, clockLabel, 5000)).rejects.toThrow(
      `Notification records for ${CLOCK} have no title/text extras to correlate with shade rows (custom layout).`,
    );
  });

  test("does not attribute a header-less row to Clock just because its title text says Clock", async () => {
    // Under the old correlationTexts.includes(appLabel) fallback, this title
    // would have matched Clock despite belonging to an unspecified other app.
    const headerlessImpostor = node("com.android.systemui:id/expandableNotificationRow", "", [
      node("android:id/title", "Clock"),
      node("android:id/text", "Alarm reminder"),
    ]);
    const { adb } = setup([page(headerlessImpostor)]);
    const snapshot = execResult(dumpsys(customRecord()));
    adb.setCommandResponseSequence("dumpsys notification", [snapshot, snapshot]);

    await expect(listSystemTrayNotifications(device, CLOCK, clockLabel, 5000)).rejects.toThrow(
      `Notification records for ${CLOCK} have no title/text extras to correlate with shade rows (custom layout).`,
    );
  });

  test("does not use generic app-label evidence when a custom layout has title extras", async () => {
    const { adb } = setup([page(customLayoutRow(clockLabel))]);
    const snapshot = execResult(dumpsys(customRecord("Hidden default")));
    adb.setCommandResponseSequence("dumpsys notification", [snapshot, snapshot]);

    await expect(listSystemTrayNotifications(device, CLOCK, clockLabel, 5000)).rejects.toThrow(
      `Notification records for ${CLOCK} could not be correlated with shade rows.`,
    );
  });
});

describe("systemTray clearAll dumpsys ownership", () => {
  const SHELL = "com.android.shell";
  const shellLabel = "Shell";
  const execResult = (stdout: string) => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  });
  const silentRow = (title: string, body: string) =>
    node("com.android.systemui:id/expandableNotificationRow", "", [
      node("android:id/title", title),
      node("android:id/text", body),
    ]);
  const dumpsys = (...records: string[]) =>
    ["Current Notification Manager state:", "  Notification List:", ...records].join("\n");
  const api36EmptyDumpsys = () =>
    [
      "Current Notification Manager state:",
      "  Notification attention state:",
      "      mSoundNotificationKey=null",
      "  mArchive=Archive (0 notifications)",
      "  Snoozed notifications:",
      " Pending snoozed notifications",
      "  Ranking Config:",
    ].join("\n");
  const record = (id: number, title: string, text: string, flags: number | string = 0) =>
    [
      `    NotificationRecord(0x${id}: pkg=${SHELL} user=UserHandle{0} id=${id} tag=null key=0|${SHELL}|${id}|null|10164)`,
      `      flags=${flags}`,
      "      extras={",
      `        android.title=String (${title})`,
      `        android.text=String (${text})`,
      "      }",
    ].join("\n");
  const customLayoutRow = (label: string) =>
    node("com.android.systemui:id/expandableNotificationRow", "", [
      node("com.android.systemui:id/notification_header", "", [
        node("com.android.systemui:id/custom_app_name_text", label),
      ]),
      node("android:id/chronometer", "00:09:57"),
    ]);
  const customRecord = () =>
    [
      `    NotificationRecord(0x06b3f5ad: pkg=${SHELL} user=UserHandle{0} id=2147483641 tag=null key=0|${SHELL}|2147483641|null|10164: Notification(channel=Timers contentView=${SHELL}/0x7f0e0042))`,
      `      contentView=${SHELL}/0x7f0e0042 (0 bytes): android.widget.RemoteViews@224e730`,
      "      extras={",
      "        android.title=null",
      "        android.template=String (android.app.Notification$DecoratedCustomViewStyle)",
      "        android.text=null",
      "      }",
    ].join("\n");
  const groupedRows = (notifications: readonly (readonly [string, string])[]) =>
    node("com.android.systemui:id/expandableNotificationRow", "", [
      node("android:id/app_name_text", shellLabel),
      node(
        "com.android.systemui:id/notification_children_container",
        "",
        notifications.map(([title]) => row(title, "")),
      ),
    ]);
  const handler = () => ToolRegistry.getTool("systemTray")!.deviceAwareHandler!;
  const clearAll = () =>
    handler()(device, {
      action: "clearAll",
      notification: { appId: SHELL },
    });
  const mockInstalledApps = (packageNames: string[], successful = true) =>
    spyOn(ListInstalledApps.prototype, "executeDetailedResult").mockResolvedValue({
      successful,
      apps: {
        profiles: {},
        system: packageNames.map((packageName) => ({
          packageName,
          userIds: [0],
          foreground: false,
          recent: false,
        })),
      },
    });
  const installClearAllDependencies = (timer: FakeTimer, adb: FakeAdbExecutor) => {
    timer.enableAutoAdvance();
    setSystemTrayDependencies({
      adbFactory: () => adb,
      appLabelResolver: async () => shellLabel,
      timer,
    });
    registerInteractionTools();
  };

  test("fails closed for a shared label on a header-less content-less custom layout", async () => {
    const OTHER_APP = "com.example.other";
    const { adb, timer } = setup([page(customLayoutRow(shellLabel))], false);
    adb.setCommandResponse("dumpsys notification", execResult(dumpsys(customRecord())));
    const installedAppsSpy = mockInstalledApps([SHELL, OTHER_APP]);
    timer.enableAutoAdvance();
    setSystemTrayDependencies({
      adbFactory: () => adb,
      appLabelResolver: async (_device, appId) =>
        appId === SHELL || appId === OTHER_APP ? shellLabel : null,
      timer,
    });
    registerInteractionTools();

    try {
      await expect(clearAll()).rejects.toThrow(
        `Notification records for ${SHELL} have no title/text extras to correlate with shade rows (custom layout).`,
      );
    } finally {
      installedAppsSpy.mockRestore();
    }

    expect(
      adb.getExecutedCommands().filter((command) => command.includes("input swipe")),
    ).toHaveLength(0);
  });

  test("clearAll rejects partial per-profile inventory before attributing or swiping", async () => {
    const { adb, timer } = setup([page(customLayoutRow(shellLabel))], false);
    const installedAppsSpy = mockInstalledApps([SHELL], false);
    installClearAllDependencies(timer, adb);

    try {
      await expect(clearAll()).rejects.toThrow("installed-app inventory is incomplete");
    } finally {
      installedAppsSpy.mockRestore();
    }
    expect(adb.getExecutedCommands().filter((command) => command.includes("input swipe"))).toEqual(
      [],
    );
  });

  test("clears a header-less content-less custom layout when its label is unique", async () => {
    const { adb, timer } = setup([page(customLayoutRow(shellLabel)), page()], false);
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(dumpsys(customRecord())),
      execResult(dumpsys(customRecord())),
      execResult(dumpsys(customRecord())),
      execResult(api36EmptyDumpsys()),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    installClearAllDependencies(timer, adb);

    try {
      const payload = JSON.parse((await clearAll()).content[0].text);
      expect(payload).toMatchObject({
        dismissedCount: 1,
        expectedCount: 1,
        remainingCount: 0,
        success: true,
      });
    } finally {
      installedAppsSpy.mockRestore();
    }

    expect(
      adb.getExecutedCommands().filter((command) => command.includes("input swipe")),
    ).toHaveLength(1);
  });

  test("clears header-less rows attributed to the app by dumpsys", async () => {
    const notifications = [
      ["First shell notification", "First body"],
      ["Second shell notification", "Second body"],
      ["Third shell notification", "Third body"],
    ] as const;
    const { adb, timer } = setup(
      [
        page(...notifications.map(([title, body]) => silentRow(title, body))),
        page(...notifications.slice(1).map(([title, body]) => silentRow(title, body))),
        page(...notifications.slice(2).map(([title, body]) => silentRow(title, body))),
        page(),
      ],
      false,
    );
    const initialDump = execResult(
      dumpsys(...notifications.map(([title, body], id) => record(id + 1, title, body))),
    );
    adb.setCommandResponseSequence("dumpsys notification", [
      initialDump,
      initialDump,
      initialDump,
      execResult(dumpsys()),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    installClearAllDependencies(timer, adb);

    try {
      const payload = JSON.parse((await clearAll()).content[0].text);
      expect(payload).toMatchObject({
        dismissedCount: 3,
        expectedCount: 3,
        remainingCount: 0,
        success: true,
      });
      expect(payload.message).toBe(`Cleared 3 notification(s) for ${SHELL}`);
    } finally {
      installedAppsSpy.mockRestore();
    }

    expect(
      adb.getExecutedCommands().filter((command) => command.includes("input swipe")),
    ).toHaveLength(3);
  });

  test("clears header-owned rows attributed to the app", async () => {
    const notifications = [
      ["First shell notification", "First body"],
      ["Second shell notification", "Second body"],
    ] as const;
    const { adb, timer } = setup(
      [
        page(...notifications.map(([title]) => row(title, shellLabel))),
        page(...notifications.slice(1).map(([title]) => row(title, shellLabel))),
        page(),
      ],
      false,
    );
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(dumpsys(...notifications.map(([title, body], id) => record(id + 1, title, body)))),
      execResult(dumpsys()),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    installClearAllDependencies(timer, adb);

    try {
      const payload = JSON.parse((await clearAll()).content[0].text);
      expect(payload).toMatchObject({
        dismissedCount: 2,
        expectedCount: 2,
        remainingCount: 0,
        success: true,
      });
      expect(payload.message).toBe(`Cleared 2 notification(s) for ${SHELL}`);
    } finally {
      installedAppsSpy.mockRestore();
    }

    expect(
      adb.getExecutedCommands().filter((command) => command.includes("input swipe")),
    ).toHaveLength(2);
  });

  test("accepts the API 36 no-list dump after clearing the last notification", async () => {
    const { adb, timer } = setup([page(row("Shell notification", shellLabel)), page()], false);
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(dumpsys(record(1, "Shell notification", "Body"))),
      execResult(api36EmptyDumpsys()),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    installClearAllDependencies(timer, adb);

    try {
      const payload = JSON.parse((await clearAll()).content[0].text);
      expect(payload).toMatchObject({
        dismissedCount: 1,
        expectedCount: 1,
        remainingCount: 0,
        success: true,
      });
      expect(payload.message).toBe(`Cleared 1 notification(s) for ${SHELL}`);
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("clearAll counts both real headerless children beside an unrelated row", async () => {
    const fixture = headerlessTwoNotificationGroups.expanded!;
    const { adb, timer } = setup([{ ...page(), viewHierarchy: fixture }, page()], false);
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(dumpsys(record(1, "Delta", "delta body"), record(2, "Gamma", "gamma body"))),
      execResult(dumpsys(record(1, "Delta", "delta body"), record(2, "Gamma", "gamma body"))),
      execResult(dumpsys(record(1, "Delta", "delta body"), record(2, "Gamma", "gamma body"))),
      execResult(api36EmptyDumpsys()),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    installClearAllDependencies(timer, adb);

    try {
      const payload = JSON.parse((await clearAll()).content[0].text);
      expect(payload).toMatchObject({
        dismissedCount: 2,
        expectedCount: 2,
        remainingCount: 0,
        success: true,
      });
      expect(
        adb.getExecutedCommands().filter((command) => command.includes("input swipe")),
      ).toEqual([expect.stringMatching(/^shell input swipe 938 (835|1054) 141 \1 300$/)]);
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("refuses to swipe a collapsed group without an expand control", async () => {
    const notifications = [
      ["First shell notification", "First body"],
      ["Second shell notification", "Second body"],
      ["Third shell notification", "Third body"],
    ] as const;
    const { adb, timer } = setup([page(groupedRows(notifications)), page()], false);
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(
        dumpsys(
          ...notifications.map(([title, body], id) => record(id + 1, title, body)),
          record(99, "3 new notifications", "", "LOCAL_ONLY|GROUP_SUMMARY|AUTOGROUP_SUMMARY"),
        ),
      ),
      execResult(dumpsys()),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    installClearAllDependencies(timer, adb);

    try {
      await expect(clearAll()).rejects.toThrow("no expand button found");
    } finally {
      installedAppsSpy.mockRestore();
    }

    expect(
      adb.getExecutedCommands().filter((command) => command.includes("input swipe")),
    ).toHaveLength(0);
  });

  // Shade state follows statusbar commands, not observation counts.
  const setupClearAllShade = (
    initiallyOpen: boolean,
    unreadable?: "missing" | "closed",
    failDuringList = false,
    clearsOnSwipe = false,
    listFailure?: NotificationShadeNotOpenError,
  ) => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const observer = new FakeObserveScreen();
    const commands = () => adb.getExecutedCommands();
    observer.setObserveResult(() => {
      const shadeCommands = commands().filter((command) => command.includes("shell cmd statusbar"));
      const open =
        shadeCommands.length === 0
          ? initiallyOpen
          : shadeCommands.at(-1)!.endsWith("expand-notifications");
      const expands = shadeCommands.filter((command) =>
        command.endsWith("expand-notifications"),
      ).length;
      if (open && listFailure && expands >= 1) {
        throw listFailure;
      }
      if (open && unreadable && expands >= (failDuringList ? 1 : 2)) {
        return unreadable === "missing" ? { ...page(), viewHierarchy: undefined } : closed;
      }
      const cleared =
        clearsOnSwipe && commands().some((command) => command.startsWith("shell input swipe"));
      return open ? (cleared ? page() : page(row("Shell notification", shellLabel))) : closed;
    });
    const closed: ObserveResult = {
      ...page(),
      viewHierarchy: {
        hierarchy: {
          node: { $: { package: "com.example.launcher", bounds: "[0,0][1080,1920]" }, node: [] },
        },
      },
    };
    const unchangedDump = execResult(dumpsys(record(1, "Shell notification", "Body")));
    adb.setCommandResponse("dumpsys notification", unchangedDump);
    setSystemTrayDependencies({ observeScreenFactory: () => observer });
    installClearAllDependencies(timer, adb);
    return { adb, commands, timer };
  };

  for (const initiallyOpen of [false, true]) {
    test(`failed clearAll restores shade found ${initiallyOpen ? "open" : "closed"}`, async () => {
      const { commands } = setupClearAllShade(initiallyOpen);
      const installedAppsSpy = mockInstalledApps([SHELL]);
      try {
        const response = await clearAll();
        expect(JSON.parse(response.content[0].text).success).toBe(false);
        expect(
          commands()
            .filter((command) => command.includes("shell cmd statusbar"))
            .at(-1),
        ).toBe(
          initiallyOpen
            ? "shell cmd statusbar expand-notifications"
            : "shell cmd statusbar collapse",
        );
        expect(response.isError).toBe(true);
        expect(
          commands().filter((command) => command.startsWith("shell input swipe")),
        ).toHaveLength(1);
      } finally {
        installedAppsSpy.mockRestore();
      }
    });
  }

  test("a text-filtered clearAll reports no confirmed dismissals when its row snaps back", async () => {
    const { commands } = setupClearAllShade(false);
    const response = await handler()(device, {
      action: "clearAll",
      notification: { title: "Shell notification" },
    });
    const payload = JSON.parse(response.content[0].text);
    expect(payload).toMatchObject({ success: false, dismissedCount: 0 });
    expect(payload.message).toContain("matching notification remains");
    expect(payload.message).not.toContain("No notifications found");
    expect(commands().filter((command) => command.startsWith("shell input swipe"))).toHaveLength(1);
    expect(commands().at(-1)).toBe("shell cmd statusbar collapse");
  });

  for (const restoreThrows of [false, true]) {
    test(`failed clearAll restores exactly once when restore ${restoreThrows ? "throws" : "succeeds"}`, async () => {
      const { adb, commands, timer } = setupClearAllShade(true);
      const restoreError = new Error("statusbar restore failed");
      if (restoreThrows) {
        adb.setCommandError("shell cmd statusbar expand-notifications", restoreError);
      }
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const response = await handler()(device, {
          action: "clearAll",
          notification: { title: "Shell notification" },
          awaitTimeout: 625,
        });
        expect(JSON.parse(response.content[0].text)).toMatchObject({
          success: false,
          dismissedCount: 0,
        });
        expect(response.isError).toBe(true);
        expect(commands().filter((command) => command.includes("shell cmd statusbar"))).toEqual([
          "shell cmd statusbar expand-notifications",
        ]);
        expect(timer.getSleepHistory()).toEqual([250, 250, 125]);
        if (restoreThrows) {
          expect(warnSpy).toHaveBeenCalledWith(
            "Failed to restore notification shade: Failed to expand system tray: statusbar restore failed",
            expect.objectContaining({ cause: restoreError }),
          );
        } else {
          expect(warnSpy).not.toHaveBeenCalled();
        }
      } finally {
        warnSpy.mockRestore();
      }
    });
  }

  test("empty app inventory succeeds despite a leftover text-fallback match", async () => {
    const { adb, commands, timer } = setupClearAllShade(true);
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(dumpsys(record(1, "Shell notification", "Body"))),
      execResult(dumpsys()),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    try {
      const response = await clearAll();
      const payload = JSON.parse(response.content[0].text);
      expect(payload).toMatchObject({ success: true, remainingCount: 0, dismissedCount: 1 });
      expect(payload.message).toContain("Warning: a matching notification remains");
      expect(response.isError).not.toBe(true);
      expect(commands().filter((command) => command.startsWith("shell input swipe"))).toHaveLength(
        1,
      );
      // The list pass closes and reopens the tray; success adds no restore.
      expect(commands().filter((command) => command.includes("shell cmd statusbar"))).toEqual([
        "shell cmd statusbar collapse",
        "shell cmd statusbar expand-notifications",
        "shell cmd statusbar collapse",
        "shell cmd statusbar expand-notifications",
      ]);
      expect(timer.getSleepHistory()).toEqual(Array(20).fill(250));
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  for (const unreadable of ["missing", "closed"] as const) {
    test(`clearAll names unreadable shade (${unreadable}) instead of remaining-count failure`, async () => {
      const { commands } = setupClearAllShade(false, unreadable);
      const installedAppsSpy = mockInstalledApps([SHELL]);
      try {
        await expect(clearAll()).rejects.toThrow("shade not readable");
        expect(commands().at(-1)).toBe("shell cmd statusbar collapse");
      } finally {
        installedAppsSpy.mockRestore();
      }
    });
  }

  test("clearAll restores shade and names unreadable list-pass failure", async () => {
    const { commands } = setupClearAllShade(false, "missing", true);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    try {
      await expect(clearAll()).rejects.toThrow("shade not readable");
      expect(commands().at(-1)).toBe("shell cmd statusbar collapse");
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("list reports an unreadable shade with a typed error", async () => {
    const { timer } = setup([{ ...page(), viewHierarchy: undefined }], false);
    timer.enableAutoAdvance();
    const result = list();
    await expect(result).rejects.toBeInstanceOf(NotificationShadeNotOpenError);
    await expect(result).rejects.toThrow(
      "Notification shade is not open; cannot list notifications.",
    );
  });

  test("clearAll rewraps a typed list-pass failure regardless of its message", async () => {
    const failure = new NotificationShadeNotOpenError("The shade disappeared during the scan.");
    const { commands } = setupClearAllShade(false, undefined, false, false, failure);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    try {
      await expect(clearAll()).rejects.toMatchObject({
        message:
          "Could not clear notifications: shade not readable (shade not detected open during list).",
        cause: failure,
      });
      expect(commands().at(-1)).toBe("shell cmd statusbar collapse");
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("failed post-clear accounting restores the shade without masking the error", async () => {
    const { adb, commands } = setupClearAllShade(false, undefined, false, true);
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(dumpsys(record(1, "Shell notification", "Body"))),
      execResult("unrecognized output"),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    try {
      await expect(clearAll()).rejects.toThrow(
        `Could not verify how many notifications remain for ${SHELL}`,
      );
      expect(commands().at(-1)).toBe("shell cmd statusbar collapse");
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("successful clearAll preserves accounting and leaves the readable shade open", async () => {
    const { adb, commands } = setupClearAllShade(false, undefined, false, true);
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(dumpsys(record(1, "Shell notification", "Body"))),
      execResult(dumpsys()),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    try {
      const response = await clearAll();
      expect(JSON.parse(response.content[0].text)).toMatchObject({
        dismissedCount: 1,
        remainingCount: 0,
        success: true,
      });
      expect(response.isError).not.toBe(true);
      expect(commands().filter((command) => command.startsWith("shell input swipe"))).toHaveLength(
        1,
      );
      expect(
        commands()
          .filter((command) => command.includes("shell cmd statusbar"))
          .at(-1),
      ).toBe("shell cmd statusbar expand-notifications");
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  const setupDelayedClear = (
    readyAfterMs: number,
    staleAfterSwipeMs = 0,
    staleHierarchy = false,
  ) => {
    const { adb, timer } = setupClearAllShade(false);
    const observer = new FakeObserveScreen();
    let reopenedAt: number | undefined;
    let lastSwipeAt = 0;
    let previousSwipes = 0;
    const swipes = () =>
      adb.getExecutedCommands().filter((command) => command.startsWith("shell input swipe"));
    observer.setObserveResult(() => {
      const lastShadeCommand = adb
        .getExecutedCommands()
        .filter((command) => command.includes("shell cmd statusbar"))
        .at(-1);
      if (!lastShadeCommand || lastShadeCommand.endsWith("collapse")) {
        return { ...page(), viewHierarchy: undefined };
      }
      const expands = adb
        .getExecutedCommands()
        .filter((command) => command.endsWith("expand-notifications")).length;
      if (expands >= 2 && reopenedAt === undefined) {
        reopenedAt = timer.now();
      }
      if (reopenedAt !== undefined && timer.now() - reopenedAt < readyAfterMs) {
        return staleHierarchy
          ? {
              ...page(row("Alpha", shellLabel), row("Beta", shellLabel)),
              freshness: { isFresh: false, verified: false },
            }
          : { ...page(), viewHierarchy: undefined };
      }
      const count = swipes().length;
      if (count !== previousSwipes) {
        previousSwipes = count;
        lastSwipeAt = timer.now();
      }
      const removed =
        count > 0 && timer.now() - lastSwipeAt < staleAfterSwipeMs ? count - 1 : count;
      return page(...["Alpha", "Beta"].slice(removed).map((title) => row(title, shellLabel)));
    });
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(dumpsys(record(1, "Alpha", "Body of Alpha"), record(2, "Beta", "Body of Beta"))),
      execResult(dumpsys()),
    ]);
    setSystemTrayDependencies({ observeScreenFactory: () => observer });
    return { adb, timer, swipes, observer };
  };

  for (const [readyAfterMs, staleHierarchy] of [
    [0, false],
    [1000, false],
    [1000, true],
  ] as const) {
    test(`app-filtered clearAll retries the reopened shade until readable at ${readyAfterMs}ms (stale hierarchy: ${staleHierarchy})`, async () => {
      const { timer, swipes } = setupDelayedClear(readyAfterMs, 0, staleHierarchy);
      const installedAppsSpy = mockInstalledApps([SHELL]);
      try {
        expect(JSON.parse((await clearAll()).content[0].text)).toMatchObject({
          success: true,
          dismissedCount: 2,
        });
        expect(swipes()).toHaveLength(2);
        expect(timer.getSleepHistory()).toEqual(readyAfterMs === 0 ? [] : [250, 250, 250, 250]);
        expect(timer.now()).toBe(readyAfterMs);
      } finally {
        installedAppsSpy.mockRestore();
      }
    });
  }

  test("clearAll polls stale post-swipe frames instead of swiping the same row again", async () => {
    const { timer, swipes } = setupDelayedClear(0, 1000);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    try {
      expect(JSON.parse((await clearAll()).content[0].text)).toMatchObject({
        success: true,
        dismissedCount: 2,
      });
      expect(swipes()).toHaveLength(2);
      expect(timer.getSleepHistory()).toEqual(Array(8).fill(250));
      expect(timer.now()).toBe(2000);
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("the initial app inventory allows offscreen matches to move into view", async () => {
    const { adb, observer, swipes } = setupDelayedClear(0);
    observer.setObserveResult(() => {
      const commands = adb.getExecutedCommands();
      if (
        !commands
          .filter((command) => command.includes("shell cmd statusbar"))
          .at(-1)
          ?.endsWith("expand-notifications")
      ) {
        return { ...page(), viewHierarchy: undefined };
      }
      return page(
        ...["Alpha", "Beta", "Gamma"]
          .slice(swipes().length, swipes().length + 2)
          .map((title) => row(title, shellLabel)),
      );
    });
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(
        dumpsys(
          record(1, "Alpha", "Body of Alpha"),
          record(2, "Beta", "Body of Beta"),
          record(3, "Gamma", "Body of Gamma"),
        ),
      ),
      execResult(dumpsys()),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    try {
      expect(JSON.parse((await clearAll()).content[0].text)).toMatchObject({
        success: true,
        dismissedCount: 3,
      });
      expect(swipes()).toHaveLength(3);
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("text-filtered clearAll drains offscreen matches without an app inventory", async () => {
    const { adb, timer } = setup(
      [
        page(identifiedRow("Match Alpha"), identifiedRow("Match Beta")),
        page(identifiedRow("Match Beta"), identifiedRow("Match Gamma")),
        page(identifiedRow("Match Gamma")),
        page(),
      ],
      false,
    );
    installClearAllDependencies(timer, adb);
    const response = await handler()(device, {
      action: "clearAll",
      notification: { title: "Match" },
    });
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      success: true,
      dismissedCount: 3,
    });
    expect(response.isError).not.toBe(true);
    expect(
      adb.getExecutedCommands().filter((command) => command.startsWith("shell input swipe")),
    ).toHaveLength(3);
    expect(
      adb.getExecutedCommands().some((command) => command.includes("dumpsys notification")),
    ).toBe(false);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("text-filtered clearAll retains the 25-swipe safety cap", async () => {
    const { adb, timer } = setup(
      Array.from({ length: 26 }, (_, index) => page(identifiedRow(`Match ${index}`))),
      false,
    );
    installClearAllDependencies(timer, adb);
    const response = await handler()(device, {
      action: "clearAll",
      notification: { title: "Match" },
    });
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      success: false,
      dismissedCount: 25,
    });
    expect(response.isError).toBe(true);
    expect(
      adb.getExecutedCommands().filter((command) => command.startsWith("shell input swipe")),
    ).toHaveLength(25);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("text-filtered clearAll shares its deadline across confirmed dismissals", async () => {
    const { timer, swipes } = setupDelayedClear(0, 250);
    const response = await handler()(device, {
      action: "clearAll",
      notification: { body: "Body of" },
      awaitTimeout: 375,
    });
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      success: false,
      dismissedCount: 1,
    });
    expect(response.isError).toBe(true);
    expect(swipes()).toHaveLength(2);
    expect(timer.getSleepHistory()).toEqual([250, 125]);
    expect(timer.now()).toBe(375);
  });

  test("new matching arrivals cannot raise the initial dismissal budget", async () => {
    const { adb, observer, swipes } = setupDelayedClear(0);
    observer.setObserveResult(() => {
      const commands = adb.getExecutedCommands();
      if (
        !commands
          .filter((command) => command.includes("shell cmd statusbar"))
          .at(-1)
          ?.endsWith("expand-notifications")
      ) {
        return { ...page(), viewHierarchy: undefined };
      }
      const count = swipes().length;
      const titles =
        count === 0 ? ["Alpha", "Beta"] : count === 1 ? ["Beta", "Gamma"] : ["Gamma", "Delta"];
      return page(...titles.map((title) => row(title, shellLabel)));
    });
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(dumpsys(record(1, "Alpha", "Body of Alpha"), record(2, "Beta", "Body of Beta"))),
      execResult(dumpsys(record(3, "Gamma", "Body of Gamma"), record(4, "Delta", "Body of Delta"))),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    try {
      const response = await clearAll();
      expect(JSON.parse(response.content[0].text)).toMatchObject({
        success: false,
        dismissedCount: 2,
        remainingCount: 2,
      });
      expect(swipes()).toHaveLength(2);
      expect(adb.getExecutedCommands().at(-1)).toBe("shell cmd statusbar collapse");
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("clearAll caps readiness polls at the caller deadline and closes the shade", async () => {
    const { adb, timer, swipes } = setupDelayedClear(1000);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    try {
      await expect(
        handler()(device, {
          action: "clearAll",
          notification: { appId: SHELL },
          awaitTimeout: 625,
        }),
      ).rejects.toThrow("shade not readable");
      expect(swipes()).toHaveLength(0);
      expect(timer.now()).toBe(625);
      expect(timer.getSleepHistory()).toEqual([250, 250, 125]);
      expect(adb.getExecutedCommands().at(-1)).toBe("shell cmd statusbar collapse");
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("a hung shade read hits the deadline and still restores the shade", async () => {
    const { adb, timer, observer, swipes } = setupDelayedClear(0);
    const execute = observer.execute.bind(observer);
    const executeSpy = spyOn(observer, "execute").mockImplementation((options) => {
      const expands = adb
        .getExecutedCommands()
        .filter((command) => command.endsWith("expand-notifications")).length;
      return expands >= 2 ? new Promise<ObserveResult>(() => {}) : execute(options);
    });
    const installedAppsSpy = mockInstalledApps([SHELL]);
    try {
      await expect(
        handler()(device, {
          action: "clearAll",
          notification: { appId: SHELL },
          awaitTimeout: 625,
        }),
      ).rejects.toThrow("shade not readable");
      expect(swipes()).toHaveLength(0);
      expect(timer.now()).toBe(625);
      expect(adb.getExecutedCommands().at(-1)).toBe("shell cmd statusbar collapse");
    } finally {
      installedAppsSpy.mockRestore();
      executeSpy.mockRestore();
    }
  });

  test("an unreadable post-dismissal shade fails with its cause and is closed", async () => {
    const { adb, timer, observer, swipes } = setupDelayedClear(0);
    const execute = observer.execute.bind(observer);
    const executeSpy = spyOn(observer, "execute").mockImplementation((options) =>
      swipes().length > 0
        ? Promise.resolve({ ...page(), viewHierarchy: undefined })
        : execute(options),
    );
    const installedAppsSpy = mockInstalledApps([SHELL]);
    try {
      await expect(
        handler()(device, {
          action: "clearAll",
          notification: { appId: SHELL },
          awaitTimeout: 625,
        }),
      ).rejects.toThrow("shade not readable after dismissal");
      expect(swipes()).toHaveLength(1);
      expect(timer.now()).toBe(625);
      expect(adb.getExecutedCommands().at(-1)).toBe("shell cmd statusbar collapse");
    } finally {
      installedAppsSpy.mockRestore();
      executeSpy.mockRestore();
    }
  });

  test("clearAll expands a real collapsed group before dismissing a child", async () => {
    const { adb, timer } = setup(
      [{ ...page(), viewHierarchy: headerlessTwoNotificationGroups.collapsed }],
      false,
    );
    const observer = new FakeObserveScreen();
    observer.setObserveResult(() => {
      const commands = adb.getExecutedCommands();
      if (commands.some((command) => command.startsWith("shell input swipe"))) {
        return page();
      }
      return {
        ...page(),
        viewHierarchy: commands.some((command) => command.startsWith("shell input tap"))
          ? headerlessTwoNotificationGroups.expanded
          : headerlessTwoNotificationGroups.collapsed,
      };
    });
    const initialDump = execResult(
      dumpsys(record(1, "Delta", "delta body"), record(2, "Gamma", "gamma body")),
    );
    adb.setCommandResponseSequence("dumpsys notification", [
      initialDump,
      initialDump,
      initialDump,
      execResult(dumpsys()),
    ]);
    setSystemTrayDependencies({ observeScreenFactory: () => observer });
    installClearAllDependencies(timer, adb);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    try {
      expect(JSON.parse((await clearAll()).content[0].text).success).toBe(true);
      const actions = adb
        .getExecutedCommands()
        .filter((command) => /shell input (tap|swipe)/.test(command));
      expect(actions).toHaveLength(2);
      expect(actions[0]).toStartWith("shell input tap");
      expect(actions[1]).toStartWith("shell input swipe");
      expect(timer.getSleepHistory()).toEqual([500]);
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("cancellation while reading the reopened shade still closes it", async () => {
    const { adb, commands } = setupClearAllShade(false);
    const controller = new AbortController();
    const observer = new FakeObserveScreen();
    observer.setObserveResult(() => {
      const lastShadeCommand = commands()
        .filter((command) => command.includes("shell cmd statusbar"))
        .at(-1);
      if (!lastShadeCommand || lastShadeCommand.endsWith("collapse")) {
        return { ...page(), viewHierarchy: undefined };
      }
      if (commands().filter((command) => command.endsWith("expand-notifications")).length >= 2) {
        controller.abort(new Error("cancel clear"));
      }
      return page(row("Shell notification", shellLabel));
    });
    setSystemTrayDependencies({ observeScreenFactory: () => observer });
    const installedAppsSpy = mockInstalledApps([SHELL]);
    try {
      await expect(
        handler()(
          device,
          { action: "clearAll", notification: { appId: SHELL } },
          undefined,
          controller.signal,
        ),
      ).rejects.toThrow("Operation cancelled");
      expect(commands().at(-1)).toBe("shell cmd statusbar collapse");
      expect(
        adb.getExecutedCommands().filter((command) => command.startsWith("shell input swipe")),
      ).toHaveLength(0);
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("cancellation bounds a hung restore and attempts it only once", async () => {
    const { adb, observer, timer, swipes } = setupDelayedClear(0);
    const controller = new AbortController();
    const observe = observer.execute.bind(observer);
    const execute = adb.executeCommand.bind(adb);
    let restoreCalls = 0;
    const executeSpy = spyOn(adb, "executeCommand").mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (args[0] === "shell cmd statusbar collapse" && controller.signal.aborted) {
        restoreCalls++;
        return new Promise<never>(() => {});
      }
      return result;
    });
    const observeSpy = spyOn(observer, "execute").mockImplementation((options) => {
      if (
        adb.getExecutedCommands().filter((command) => command.endsWith("expand-notifications"))
          .length >= 2
      ) {
        controller.abort(new Error("cancel clear"));
      }
      return observe(options);
    });
    const installedAppsSpy = mockInstalledApps([SHELL]);
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(
        handler()(
          device,
          {
            action: "clearAll",
            notification: { appId: SHELL },
            awaitTimeout: 625,
          },
          undefined,
          controller.signal,
        ),
      ).rejects.toThrow("Operation cancelled");
      expect(restoreCalls).toBe(1);
      expect(timer.now()).toBe(625);
      expect(timer.getSleepHistory()).toEqual([]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        "Failed to restore notification shade: Notification shade restoration timed out after 625ms",
        expect.any(Error),
      );
      expect(swipes()).toHaveLength(0);
    } finally {
      installedAppsSpy.mockRestore();
      warnSpy.mockRestore();
      observeSpy.mockRestore();
      executeSpy.mockRestore();
    }
  });

  test("reports no progress when every notification remains after swiping", async () => {
    const notifications = [
      ["First shell notification", "First body"],
      ["Second shell notification", "Second body"],
    ] as const;
    const { adb, timer } = setup(
      [page(...notifications.map(([title]) => row(title, shellLabel))), page()],
      false,
    );
    const unchangedDump = execResult(
      dumpsys(...notifications.map(([title, body], id) => record(id + 1, title, body))),
    );
    adb.setCommandResponseSequence("dumpsys notification", [unchangedDump, unchangedDump]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    installClearAllDependencies(timer, adb);

    try {
      const payload = JSON.parse((await clearAll()).content[0].text);
      expect(payload).toMatchObject({
        dismissedCount: 0,
        expectedCount: 2,
        remainingCount: 2,
        success: false,
      });
      expect(payload.message).toContain("2 remain after clearing");
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("reports arrivals without hiding which original notifications were cleared", async () => {
    const notifications = [
      ["First shell notification", "First body"],
      ["Second shell notification", "Second body"],
    ] as const;
    const { adb, timer } = setup(
      [page(...notifications.map(([title]) => row(title, shellLabel))), page()],
      false,
    );
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(dumpsys(...notifications.map(([title, body], id) => record(id + 1, title, body)))),
      execResult(dumpsys(record(3, "New shell notification", "New body"))),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    installClearAllDependencies(timer, adb);

    try {
      const payload = JSON.parse((await clearAll()).content[0].text);
      expect(payload).toMatchObject({
        arrivedCount: 1,
        dismissedCount: 2,
        expectedCount: 2,
        remainingCount: 1,
        success: false,
      });
      expect(payload.message).toContain("1 notification(s) arrived during the operation");
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("fails explicitly when the post-clear dump is unrecognized", async () => {
    const { adb, timer } = setup([page(row("Shell notification", shellLabel)), page()], false);
    adb.setCommandResponseSequence("dumpsys notification", [
      execResult(dumpsys(record(1, "Shell notification", "Body"))),
      execResult("unrecognized but successful output"),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    installClearAllDependencies(timer, adb);

    try {
      await expect(clearAll()).rejects.toThrow(
        `Could not verify how many notifications remain for ${SHELL}`,
      );
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("reports an honest failure when dumpsys-owned rows cannot all be cleared", async () => {
    const notifications = [
      ["First shell notification", "First body"],
      ["Second shell notification", "Second body"],
    ] as const;
    const { adb, timer } = setup(
      [page(...notifications.map(([title, body]) => silentRow(title, body))), page()],
      false,
    );
    const initialDump = execResult(
      dumpsys(...notifications.map(([title, body], id) => record(id + 1, title, body))),
    );
    adb.setCommandResponseSequence("dumpsys notification", [
      initialDump,
      initialDump,
      initialDump,
      execResult(dumpsys(record(2, ...notifications[1]))),
    ]);
    const installedAppsSpy = mockInstalledApps([SHELL]);
    installClearAllDependencies(timer, adb);

    try {
      const payload = JSON.parse((await clearAll()).content[0].text);
      expect(payload).toMatchObject({
        dismissedCount: 1,
        expectedCount: 2,
        remainingCount: 1,
        success: false,
      });
      expect(payload.message).not.toBe(`No notifications found for ${SHELL}`);
      expect(payload.message).toContain("Cleared 1 of 2 notification(s)");
    } finally {
      installedAppsSpy.mockRestore();
    }
  });

  test("reports a dumpsys-verified empty tray as successful", async () => {
    const { adb, timer } = setup([page(silentRow("Other app", "Other body"))], false);
    adb.setCommandResponse("dumpsys notification", execResult(dumpsys()));
    const installedAppsSpy = mockInstalledApps([SHELL]);
    installClearAllDependencies(timer, adb);

    try {
      const payload = JSON.parse((await clearAll()).content[0].text);
      expect(payload).toMatchObject({ dismissedCount: 0, expectedCount: 0, success: true });
      expect(payload.message).toBe(`No notifications found for ${SHELL}`);
    } finally {
      installedAppsSpy.mockRestore();
    }
  });
});

// A row's action buttons are chrome SystemUI renders, not content the posting
// app supplied, so they must not make another app's notification a plausible
// owner of the row (#6875).
describe("systemTray list silent-section correlation content", () => {
  const WELLBEING = "com.google.android.apps.wellbeing";
  const SLEEP_TITLE = "Need better sleep?";
  const SLEEP_BODY = "Use Bedtime mode to silence your phone";
  const execResult = (stdout: string) => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  });
  const silentRowWithAction = (title: string, body: string, action: string) =>
    node("com.android.systemui:id/expandableNotificationRow", "", [
      node("android:id/title", title),
      node("android:id/text", body),
      node("android:id/actions", "", [node("android:id/action0", action)]),
      node("com.android.systemui:id/expand_button", "Expand"),
    ]);
  const dumpsys = (...records: string[]) =>
    ["Current Notification Manager state:", "  Notification List:", ...records].join("\n");
  const record = (pkg: string, title: string, text: string) =>
    [
      `    NotificationRecord(0x1: pkg=${pkg} user=UserHandle{0} id=0 tag=null key=0|${pkg}|0|null|10164)`,
      "      extras={",
      `        android.title=String (${title})`,
      `        android.text=String (${text})`,
      "      }",
    ].join("\n");

  test("ignores action labels when deciding which packages could own a row", async () => {
    const { adb } = setup([page(silentRowWithAction(SLEEP_TITLE, SLEEP_BODY, "Reply"))]);
    adb.setCommandResponse(
      "dumpsys notification",
      execResult(
        dumpsys(
          record(WELLBEING, SLEEP_TITLE, SLEEP_BODY),
          record("com.example.chat", "Reply", "Tap to reply"),
        ),
      ),
    );
    const result = await listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000);
    expect(result.notifications).toMatchObject([
      { appId: WELLBEING, title: SLEEP_TITLE, body: SLEEP_BODY, ownership: "dumpsys" },
    ]);
    expect(result.unattributedRows).toBe(0);
  });

  test("still reports the action labels the row rendered", async () => {
    const { adb } = setup([page(silentRowWithAction(SLEEP_TITLE, SLEEP_BODY, "Reply"))]);
    adb.setCommandResponse(
      "dumpsys notification",
      execResult(dumpsys(record(WELLBEING, SLEEP_TITLE, SLEEP_BODY))),
    );
    const result = await listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000);
    expect(result.notifications[0].actions).toEqual(["Reply"]);
    expect(result.notifications[0].texts).toContain("Reply");
  });

  test("does not let a system control label decide ownership", async () => {
    const { adb } = setup([page(silentRowWithAction(SLEEP_TITLE, SLEEP_BODY, "Reply"))]);
    adb.setCommandResponse(
      "dumpsys notification",
      execResult(
        dumpsys(
          record(WELLBEING, SLEEP_TITLE, SLEEP_BODY),
          record("com.example.launcher", "Expand", "Expand the view"),
        ),
      ),
    );
    const result = await listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000);
    expect(result.notifications).toMatchObject([{ appId: WELLBEING, ownership: "dumpsys" }]);
  });
});

// SystemUI renders the timer chrome of a chronometer notification itself, and
// the running value it shows is in no record's extras, so counting it as
// correlation content only lets an unrelated app whose title reads "00:01"
// hide an otherwise exact match (#6875).
describe("systemTray list silent-section chronometer chrome", () => {
  const WELLBEING = "com.google.android.apps.wellbeing";
  const SLEEP_TITLE = "Need better sleep?";
  const SLEEP_BODY = "Use Bedtime mode to silence your phone";
  const execResult = (stdout: string) => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  });
  const timerRow = (title: string, body: string, elapsed: string) =>
    node("com.android.systemui:id/expandableNotificationRow", "", [
      node("android:id/title", title),
      node("android:id/text", body),
      node("android:id/chronometer", elapsed),
      node("android:id/time", "now"),
    ]);
  const dumpsys = (...records: string[]) =>
    ["Current Notification Manager state:", "  Notification List:", ...records].join("\n");
  const record = (pkg: string, title: string, text: string) =>
    [
      `    NotificationRecord(0x1: pkg=${pkg} user=UserHandle{0} id=0 tag=null key=0|${pkg}|0|null|10164)`,
      "      extras={",
      `        android.title=String (${title})`,
      `        android.text=String (${text})`,
      "      }",
    ].join("\n");

  test("ignores chronometer and timestamp chrome when deciding plausible owners", async () => {
    const { adb } = setup([page(timerRow(SLEEP_TITLE, SLEEP_BODY, "00:01"))]);
    adb.setCommandResponse(
      "dumpsys notification",
      execResult(
        dumpsys(
          record(WELLBEING, SLEEP_TITLE, SLEEP_BODY),
          record("com.example.clock", "00:01", "Timer running"),
        ),
      ),
    );
    const result = await listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000);
    expect(result.notifications).toMatchObject([
      { appId: WELLBEING, title: SLEEP_TITLE, body: SLEEP_BODY, ownership: "dumpsys" },
    ]);
    expect(result.unattributedRows).toBe(0);
  });

  test("still reports the chronometer text the row rendered", async () => {
    const { adb } = setup([page(timerRow(SLEEP_TITLE, SLEEP_BODY, "00:01"))]);
    adb.setCommandResponse(
      "dumpsys notification",
      execResult(dumpsys(record(WELLBEING, SLEEP_TITLE, SLEEP_BODY))),
    );
    const result = await listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000);
    expect(result.notifications[0].texts).toContain("00:01");
  });

  test("reads the notification dump with an explicit output buffer", async () => {
    const { adb } = setup([page(timerRow(SLEEP_TITLE, SLEEP_BODY, "00:01"))]);
    adb.setCommandResponse(
      "dumpsys notification",
      execResult(dumpsys(record(WELLBEING, SLEEP_TITLE, SLEEP_BODY))),
    );
    await listSystemTrayNotifications(device, WELLBEING, "Digital Wellbeing", 5000);
    const call = adb
      .getCommandCalls()
      .find((entry) => entry.command.includes("dumpsys notification"))!;
    // The default child-process buffer is 1 MiB; an unredacted aggregate dump
    // exceeds it on notification-heavy devices and would reject outright.
    expect(call.maxBuffer).toBeGreaterThan(1024 * 1024);
  });
});

test("lists topmost window rows once when also nested in the primary hierarchy", async () => {
  const sharedTop = identifiedRow("top-window");
  const observation = page(identifiedRow("primary"), sharedTop);
  observation.viewHierarchy!.windows = [
    { windowLayer: 10, hierarchy: page(sharedTop).viewHierarchy!.hierarchy },
  ] as any;
  setup([observation]);
  const result = await list();
  expect(result.notifications.map((entry) => entry.title)).toEqual(["top-window", "primary"]);
});

test("matching identical notification titles prefers the topmost window before screen Y", async () => {
  const primary = positionedRow("Same", 200);
  const upper = positionedRow("Same", 900);
  const observation = page(primary);
  observation.viewHierarchy!.windows = [
    { windowLayer: 10, hierarchy: page(upper).viewHierarchy!.hierarchy },
  ] as any;
  setup([observation]);
  const result = await waitForNotificationMatch(device, { title: "Same" }, [], 1000);
  expect(result.match?.candidate.element?.bounds.top).toBe(900);
});
