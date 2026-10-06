import { describe, expect, test } from "bun:test";
import {
  isNodeNotFoundReply,
  resourceIdActionError,
} from "../../../src/features/talkback/resourceIdActionError";
import { TalkBackTapStrategy } from "../../../src/features/talkback/TalkBackTapStrategy";
import { FakeTalkBackNavigationDriver } from "../../fakes/FakeTalkBackNavigationDriver";
import type { ViewHierarchyResult } from "../../../src/models";
import { StaleDisplayError } from "../../../src/models/StaleDisplayError";
import { notificationHierarchy, notificationRows } from "./capturedNotificationTargets";

const unique: ViewHierarchyResult = { hierarchy: { node: { $: { "resource-id": "app:id/row" } } } };

describe("resource-ID action guard", () => {
  test("counts the captured list's duplicate native rows", async () => {
    expect(
      await resourceIdActionError(
        "com.android.systemui:id/expandableNotificationRow",
        async () => notificationHierarchy,
      ),
    ).toContain(`shared by ${notificationRows.length} elements`);
  });

  test("full and short IDs use the existing native-ID normalization", async () => {
    expect(await resourceIdActionError("row", async () => unique)).toBeUndefined();
    const duplicate: ViewHierarchyResult = {
      hierarchy: {
        node: [{ $: { "resource-id": "app:id/row" } }, { $: { "resource-id": "other:id/row" } }],
      },
    };
    expect(await resourceIdActionError("row", async () => duplicate)).toContain(
      "shared by 2 elements",
    );
  });

  test.each([
    null,
    { hierarchy: { error: "capture failed" } },
    { ...unique, ctrlProxyIncomplete: true },
    { ...unique, truncationReasons: ["max_children"] },
    { hierarchy: { node: [] } },
  ] satisfies (ViewHierarchyResult | null)[])(
    "unverifiable hierarchy fails closed: %j",
    async (hierarchy) => {
      expect(await resourceIdActionError("app:id/row", async () => hierarchy)).toBeDefined();
    },
  );

  test("read failure skips the action but a stale display still propagates", async () => {
    expect(
      await resourceIdActionError("app:id/row", async () => {
        throw new Error("capture unavailable");
      }),
    ).toContain("Unable to verify uniqueness");
    const stale = new StaleDisplayError({
      observedGeneration: 1,
      currentGeneration: 2,
      retry: "observe",
    });
    await expect(
      resourceIdActionError("app:id/row", async () => {
        throw stale;
      }),
    ).rejects.toBe(stale);
  });

  test("a driver without full-tree observation never sends an ID action", async () => {
    const driver = new FakeTalkBackNavigationDriver();
    expect(
      await new TalkBackTapStrategy().executeDirectActivation(
        { "resource-id": "app:id/row" },
        driver,
      ),
    ).toMatchObject({ success: false, method: "accessibility-action" });
    expect(driver.actionHistory).toEqual([]);
  });
});

describe("node-not-found reply classification", () => {
  test("only CtrlProxy's lookup-miss reply counts", () => {
    expect(isNodeNotFoundReply("Element not found with resource-id: app:id/row")).toBe(true);
    expect(isNodeNotFoundReply("Element not found with NodeSelector(testTag=row)")).toBe(true);
    expect(isNodeNotFoundReply("performAction returned false")).toBe(false);
    expect(isNodeNotFoundReply("Accessibility action is unavailable: long_click")).toBe(false);
    expect(isNodeNotFoundReply(undefined)).toBe(false);
  });
});
