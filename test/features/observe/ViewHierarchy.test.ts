import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { BootedDevice } from "../../../src/models/DeviceInfo";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { logger, LogLevel } from "../../../src/utils/logger";

// Note: the previous version of this file patched fs-extra's readFile to mock
// screenshot reads. That dependency has been removed from production code, so
// the mock was already ineffective and has been deleted along with the import.
const setupReadFileMock = () => {
  /* no-op: patched dependency was removed */
};
const teardownReadFileMock = () => {
  /* no-op: patched dependency was removed */
};

describe("ViewHierarchy", function () {
  describe("Unit Tests for Public Methods", function () {
    let viewHierarchy: ViewHierarchy;
    let fakeAdbFactory: FakeAdbClientFactory;
    let mockCtrlProxyClient: AndroidCtrlProxyClient;
    let mockDevice: BootedDevice;

    beforeEach(function () {
      mockDevice = {
        deviceId: "test-device",
        name: "Test Device",
        platform: "android",
      };
      // Create fakes for testing
      fakeAdbFactory = new FakeAdbClientFactory();

      mockCtrlProxyClient = {
        getLatestHierarchy: async () => null,
        convertToViewHierarchyResult: () => ({ hierarchy: {} }),
        convertAccessibilityNode: () => ({}),
        getAccessibilityHierarchy: async () => null,
      } as unknown as AndroidCtrlProxyClient;

      viewHierarchy = new ViewHierarchy(mockDevice, fakeAdbFactory, mockCtrlProxyClient);
      setupReadFileMock();
    });

    afterEach(function () {
      teardownReadFileMock();
    });

    test("should identify string filter criteria correctly", function () {
      const propsWithText = { text: "Button Text" };
      const propsWithResourceId = { "resource-id": "com.app:id/button" };
      const propsWithContentDesc = { "content-desc": "Button description" };
      const propsEmpty = { clickable: "true" };

      // Now that the method is public, we can call it directly
      expect(viewHierarchy.meetsStringFilterCriteria(propsWithText)).toBe(true);
      expect(viewHierarchy.meetsStringFilterCriteria(propsWithResourceId)).toBe(true);
      expect(viewHierarchy.meetsStringFilterCriteria(propsWithContentDesc)).toBe(true);
      expect(viewHierarchy.meetsStringFilterCriteria(propsEmpty)).toBe(false);
    });

    describe("meetsBooleanFilterCriteria", function () {
      // The matrix pins which flags are interactive and, crucially, the
      // asymmetry: every flag is matched by the string "true", but only
      // `selected` is ALSO matched as a JSON boolean `true`. CtrlProxy emits JSON
      // booleans, so if that `selected === true` branch is dropped, every
      // selected-only node is silently filtered out (issue #4172 item 13). The
      // string "TRUE" and numeric 1 must NOT match (case-sensitive, ===).
      const cases: Array<{ name: string; props: any; expected: boolean }> = [
        { name: "clickable string true", props: { clickable: "true" }, expected: true },
        { name: "focusable string true", props: { focusable: "true" }, expected: true },
        { name: "scrollable string true", props: { scrollable: "true" }, expected: true },
        { name: "focused string true", props: { focused: "true" }, expected: true },
        {
          name: "accessibility-focused string true",
          props: { "accessibility-focused": "true" },
          expected: true,
        },
        { name: "checkable string true", props: { checkable: "true" }, expected: true },
        { name: "checked string true", props: { checked: "true" }, expected: true },
        { name: "selected string true", props: { selected: "true" }, expected: true },
        { name: "selected JSON boolean true", props: { selected: true }, expected: true },
        { name: "long-clickable string true", props: { "long-clickable": "true" }, expected: true },
        { name: "non-empty actions array", props: { actions: ["tap"] }, expected: true },
        { name: "non-empty extras", props: { extras: { key: "value" } }, expected: true },
        // Asymmetry guard: only `selected` accepts a JSON boolean.
        {
          name: "clickable JSON boolean true is NOT matched",
          props: { clickable: true },
          expected: false,
        },
        {
          name: "focused JSON boolean true is NOT matched",
          props: { focused: true },
          expected: false,
        },
        {
          name: "checked JSON boolean true is NOT matched",
          props: { checked: true },
          expected: false,
        },
        // Falsy / non-matching values.
        { name: "clickable string false", props: { clickable: "false" }, expected: false },
        { name: "selected string false", props: { selected: "false" }, expected: false },
        { name: "selected JSON boolean false", props: { selected: false }, expected: false },
        {
          name: "uppercase TRUE is not matched (case-sensitive)",
          props: { clickable: "TRUE" },
          expected: false,
        },
        {
          name: "numeric 1 is not matched (strict equality)",
          props: { clickable: 1 },
          expected: false,
        },
        { name: "empty actions array", props: { actions: [] }, expected: false },
        { name: "actions not an array", props: { actions: "tap" }, expected: false },
        { name: "empty extras object", props: { extras: {} }, expected: false },
        { name: "no interactive flags", props: { text: "Button" }, expected: false },
        { name: "empty props", props: {}, expected: false },
      ];

      cases.forEach(({ name, props, expected }) => {
        test(`returns ${expected} for ${name}`, function () {
          expect(viewHierarchy.meetsBooleanFilterCriteria(props)).toBe(expected);
        });
      });
    });

    test("should check meets filter criteria correctly", function () {
      const propsWithText = { text: "Button Text" };
      const propsClickable = { clickable: "true" };
      const propsEmpty = { enabled: "true" };

      expect(viewHierarchy.meetsFilterCriteria(propsWithText)).toBe(true);
      expect(viewHierarchy.meetsFilterCriteria(propsClickable)).toBe(true);
      expect(viewHierarchy.meetsFilterCriteria(propsEmpty)).toBe(false);
    });

    test("should process node children correctly", function () {
      const node = {
        $: { text: "parent" },
        node: [
          { $: { text: "child1", clickable: "true" } },
          { $: { text: "child2", scrollable: "true" } },
          { $: { enabled: "true" } }, // Should be filtered out
        ],
      };

      const filteredChildren = viewHierarchy.processNodeChildren(node, (child) => {
        return viewHierarchy.meetsFilterCriteria(child.$) ? child : null;
      });

      expect(filteredChildren).toHaveLength(2);
      expect(filteredChildren[0].$).toHaveProperty("text", "child1");
      expect(filteredChildren[1].$).toHaveProperty("text", "child2");
    });

    test("should normalize node structure correctly", function () {
      const singleChild = [{ text: "single" }];
      const multipleChildren = [{ text: "first" }, { text: "second" }];

      const normalizedSingle = viewHierarchy.normalizeNodeStructure(singleChild);
      const normalizedMultiple = viewHierarchy.normalizeNodeStructure(multipleChildren);

      expect(typeof normalizedSingle).toBe("object");
      expect(normalizedSingle).toHaveProperty("text", "single");
      expect(Array.isArray(normalizedMultiple)).toBe(true);
      expect(normalizedMultiple).toHaveLength(2);
    });

    test("should filter single node correctly", function () {
      const nodeWithCriteria = {
        $: { text: "test", clickable: "true", enabled: "true", class: "android.widget.Button" },
        node: {
          $: { "resource-id": "button", enabled: "false" },
        },
      };

      const filteredNode = viewHierarchy.filterSingleNode(nodeWithCriteria);

      expect(filteredNode).toBeDefined();
      expect(filteredNode).toHaveProperty("text", "test");
      expect(filteredNode).toHaveProperty("clickable", "true");
      expect(filteredNode).not.toHaveProperty("enabled"); // Should be filtered out
      expect(filteredNode).not.toHaveProperty("class"); // Should be filtered out
    });

    test("should filter single root node correctly", function () {
      const rootNode = {
        $: { class: "android.widget.FrameLayout" },
        node: [
          { $: { text: "visible text" } },
          { $: { enabled: "true" } }, // Should be filtered out
        ],
      };

      const filteredRoot = viewHierarchy.filterSingleNode(rootNode, true);

      expect(filteredRoot).toBeDefined();
      expect(filteredRoot.node).toBeDefined();
      expect(filteredRoot.node).toHaveProperty("text", "visible text");
    });

    test("should return children when parent doesn't meet criteria but children do", function () {
      const nodeWithoutCriteria = {
        $: { enabled: "true" },
        node: [{ $: { text: "child1" } }, { $: { clickable: "true" } }],
      };

      const result = viewHierarchy.filterSingleNode(nodeWithoutCriteria);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });
  });

  describe("Error Handling Tests", function () {
    let viewHierarchy: ViewHierarchy;
    let fakeAdb: FakeAdbExecutor;
    let mockCtrlProxyClient: AndroidCtrlProxyClient;
    let mockDevice: BootedDevice;

    beforeEach(function () {
      mockDevice = {
        deviceId: "test-device",
        name: "Test Device",
        platform: "android",
      };
      fakeAdb = new FakeAdbExecutor();

      mockCtrlProxyClient = {
        getLatestHierarchy: async () => null,
        convertToViewHierarchyResult: () => ({ hierarchy: {} }),
        convertAccessibilityNode: () => ({}),
        getAccessibilityHierarchy: async () => null,
      } as unknown as AndroidCtrlProxyClient;

      viewHierarchy = new ViewHierarchy(
        mockDevice,
        new FakeAdbClientFactory(fakeAdb),
        mockCtrlProxyClient,
      );
      setupReadFileMock();
    });

    afterEach(function () {
      teardownReadFileMock();
    });

    test("returns an error envelope when the accessibility service returns no hierarchy", async function () {
      // The fixture's getAccessibilityHierarchy resolves to null; nothing here is
      // about an "active window". A null hierarchy must surface as an error
      // envelope, not an empty-but-valid hierarchy.
      const result = await viewHierarchy.getAndroidViewHierarchy();

      expect(result.hierarchy).toHaveProperty("error");
      expect(typeof (result.hierarchy as { error?: unknown }).error).toBe("string");
    });

    test("should handle accessibility service errors in getViewHierarchy", async function () {
      const mockCtrlProxyClientError = {
        getLatestHierarchy: async () => null,
        convertToViewHierarchyResult: () => ({ hierarchy: {} }),
        convertAccessibilityNode: () => ({}),
        getAccessibilityHierarchy: async () => {
          throw new Error("Accessibility service error");
        },
      } as unknown as AndroidCtrlProxyClient;

      const viewHierarchyWithMocks = new ViewHierarchy(
        mockDevice,
        new FakeAdbClientFactory(fakeAdb),
        mockCtrlProxyClientError,
      );

      const result = await viewHierarchyWithMocks.getAndroidViewHierarchy();

      expect(result).toBeDefined();
      expect(result.hierarchy).toBeDefined();
      expect(result.hierarchy).toHaveProperty("error");
    });

    // #4281: a fresh-boot / locked device blocks the accessibility service from
    // binding, producing the same generic hierarchy error as the #4039 transport
    // failure. When the keyguard is showing, name the real cause instead.
    test("names a secure keyguard as the cause of a null hierarchy (#4281)", async function () {
      fakeAdb.setDeviceLock({ locked: true, keyguardShowing: true, secure: true });
      const result = await viewHierarchy.getAndroidViewHierarchy();
      const error = String((result.hierarchy as any).error).toLowerCase();
      expect(error).toContain("locked");
      expect(error).toContain("unlock");
    });

    test("names a swipe keyguard as the cause of a hierarchy error (#4281)", async function () {
      fakeAdb.setDeviceLock({ locked: true, keyguardShowing: true, secure: false });
      const throwingClient = {
        getLatestHierarchy: async () => null,
        convertToViewHierarchyResult: () => ({ hierarchy: {} }),
        convertAccessibilityNode: () => ({}),
        getAccessibilityHierarchy: async () => {
          throw new Error("Accessibility service error");
        },
      } as unknown as AndroidCtrlProxyClient;
      const vh = new ViewHierarchy(mockDevice, new FakeAdbClientFactory(fakeAdb), throwingClient);

      const result = await vh.getAndroidViewHierarchy();
      const error = String((result.hierarchy as any).error).toLowerCase();
      expect(error).toContain("locked");
      expect(error).toContain("dismiss");
    });

    test("keeps the generic message when the device is not locked (#4281/#4039)", async function () {
      fakeAdb.setDeviceLock({ locked: false, keyguardShowing: false, secure: false });
      const result = await viewHierarchy.getAndroidViewHierarchy();
      const error = String((result.hierarchy as any).error);
      expect(error).toContain("Failed to retrieve view hierarchy");
      expect(error.toLowerCase()).not.toContain("keyguard");
    });

    test("keeps the generic message when a keyguard is showing but occluded (#4281)", async function () {
      // `locked` is false when a show-when-locked activity occludes the keyguard;
      // that state cannot explain an accessibility-service binding failure.
      fakeAdb.setDeviceLock({ locked: false, keyguardShowing: true, secure: true });
      const result = await viewHierarchy.getAndroidViewHierarchy();
      const error = String((result.hierarchy as any).error);
      expect(error).toContain("Failed to retrieve view hierarchy");
      expect(error.toLowerCase()).not.toContain("device is locked");
    });

    test("falls back to the generic message when the lock read fails (#4281)", async function () {
      (fakeAdb as any).getDeviceLock = async () => {
        throw new Error("dumpsys boom");
      };
      const result = await viewHierarchy.getAndroidViewHierarchy();
      expect(String((result.hierarchy as any).error)).toContain(
        "Failed to retrieve view hierarchy",
      );
    });

    test("skips the lock probe when the caller's signal is already aborted (#4281 review)", async function () {
      // Locked device, but the caller's deadline has already fired: the diagnostic
      // must not start an unbounded dumpsys just to reword the error.
      fakeAdb.setDeviceLock({ locked: true, keyguardShowing: true, secure: true });
      let probed = false;
      const originalGetDeviceLock = fakeAdb.getDeviceLock.bind(fakeAdb);
      (fakeAdb as any).getDeviceLock = async (signal?: AbortSignal) => {
        probed = true;
        return originalGetDeviceLock(signal);
      };
      const controller = new AbortController();
      controller.abort();

      const result = await viewHierarchy.getAndroidViewHierarchy(
        undefined,
        undefined,
        false,
        0,
        controller.signal,
      );

      expect(probed).toBe(false);
      expect(String((result.hierarchy as any).error)).toContain(
        "Failed to retrieve view hierarchy",
      );
    });

    test("skips the lock probe when a per-read timeoutMs budget is supplied (#4281 review)", async function () {
      // The keyboard confirmation poll bounds each read with timeoutMs and passes
      // no signal; the unbounded dumpsys probe must not run for such a caller.
      fakeAdb.setDeviceLock({ locked: true, keyguardShowing: true, secure: true });
      let probed = false;
      const originalGetDeviceLock = fakeAdb.getDeviceLock.bind(fakeAdb);
      (fakeAdb as any).getDeviceLock = async (signal?: AbortSignal) => {
        probed = true;
        return originalGetDeviceLock(signal);
      };

      // timeoutMs supplied (5th arg signal omitted, 6th arg timeoutMs=500).
      const result = await viewHierarchy.getAndroidViewHierarchy(
        undefined,
        undefined,
        false,
        0,
        undefined,
        500,
      );

      expect(probed).toBe(false);
      expect(String((result.hierarchy as any).error)).toContain(
        "Failed to retrieve view hierarchy",
      );
    });

    test("surfaces iOS CtrlProxy reconnect cooldown as retry metadata", async function () {
      const iosDevice: BootedDevice = {
        deviceId: "test-ios-device",
        name: "Test iPhone",
        platform: "ios",
      };
      const fakeIosClient = {
        getLatestHierarchy: async () => ({
          hierarchy: null,
          fresh: false,
          reconnectStatus: {
            state: "cooldown",
            retryAfterMs: 1800,
            retryAfterSeconds: 2,
            connectionAttempts: 3,
            maxConnectionAttempts: 3,
          },
          reconnectMessage: "CtrlProxy reconnecting, retry in 2s",
        }),
      };
      const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIosClient as any,
      );

      try {
        const viewHierarchyWithMocks = new ViewHierarchy(
          iosDevice,
          new FakeAdbClientFactory(fakeAdb),
          mockCtrlProxyClient,
        );

        const result = await viewHierarchyWithMocks.getiOSViewHierarchy();

        expect(result.hierarchy.error).toBe("CtrlProxy reconnecting, retry in 2s");
        expect(result.ctrlProxyReconnect).toEqual({
          state: "cooldown",
          retryAfterMs: 1800,
          retryAfterSeconds: 2,
          connectionAttempts: 3,
          maxConnectionAttempts: 3,
        });
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("preserves iOS CtrlProxy reconnect metadata on stale cached hierarchy", async function () {
      const iosDevice: BootedDevice = {
        deviceId: "test-ios-device",
        name: "Test iPhone",
        platform: "ios",
      };
      const staleHierarchy = {
        updatedAt: 1750934585218,
        packageName: "com.example.cached",
        hierarchy: { node: { $: { text: "Cached screen" } } },
      };
      const reconnectStatus = {
        state: "cooldown",
        retryAfterMs: 1800,
        retryAfterSeconds: 2,
        connectionAttempts: 3,
        maxConnectionAttempts: 3,
      };
      const fakeIosClient = {
        getLatestHierarchy: async () => ({
          hierarchy: staleHierarchy,
          fresh: false,
          updatedAt: 1750934585218,
          reconnectStatus,
          reconnectMessage: "CtrlProxy reconnecting, retry in 2s",
        }),
      };
      const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIosClient as any,
      );

      try {
        const viewHierarchyWithMocks = new ViewHierarchy(
          iosDevice,
          new FakeAdbClientFactory(fakeAdb),
          mockCtrlProxyClient,
        );

        const result = await viewHierarchyWithMocks.getiOSViewHierarchy();

        expect(result.hierarchy).toEqual(staleHierarchy.hierarchy);
        expect(result.updatedAt).toBe(1750934585218);
        expect(result.ctrlProxyReconnect).toEqual(reconnectStatus);
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("promotes iOS SDK header traits in the public observe hierarchy", async function () {
      const iosDevice: BootedDevice = {
        deviceId: "test-ios-device",
        name: "Test iPhone",
        platform: "ios",
      };
      const fakeIosClient = {
        getLatestHierarchy: async () => ({
          hierarchy: {
            updatedAt: 1750934585218,
            hierarchy: {
              role: "text",
              text: "Overview",
              extras: { "sdk.accessibilityTraits": "staticText,header" },
            },
          },
          fresh: true,
          updatedAt: 1750934585218,
        }),
      };
      const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIosClient as any,
      );

      try {
        const viewHierarchyWithMocks = new ViewHierarchy(
          iosDevice,
          new FakeAdbClientFactory(fakeAdb),
          mockCtrlProxyClient,
        );

        const result = await viewHierarchyWithMocks.getiOSViewHierarchy();

        expect(result.hierarchy).toMatchObject({ role: "heading", text: "Overview" });
      } finally {
        getInstanceSpy.mockRestore();
      }
    });
  });

  describe("FilterViewHierarchy Tests", function () {
    let viewHierarchy: ViewHierarchy;
    let fakeAdb: FakeAdbExecutor;
    let mockCtrlProxyClient: AndroidCtrlProxyClient;
    let mockDevice: BootedDevice;

    beforeEach(function () {
      mockDevice = {
        deviceId: "test-device",
        name: "Test Device",
        platform: "android",
      };
      fakeAdb = new FakeAdbExecutor();

      mockCtrlProxyClient = {
        getLatestHierarchy: async () => null,
        convertToViewHierarchyResult: () => ({ hierarchy: {} }),
        convertAccessibilityNode: () => ({}),
        getAccessibilityHierarchy: async () => null,
      } as unknown as AndroidCtrlProxyClient;

      viewHierarchy = new ViewHierarchy(
        mockDevice,
        new FakeAdbClientFactory(fakeAdb),
        mockCtrlProxyClient,
      );
    });

    test("should handle empty hierarchy", function () {
      const emptyHierarchy = null;
      const result = viewHierarchy.filterViewHierarchy(emptyHierarchy);
      expect(result).toBe(emptyHierarchy);
    });

    test("should handle hierarchy without hierarchy property", function () {
      const noHierarchy = { data: "test" };
      const result = viewHierarchy.filterViewHierarchy(noHierarchy);
      expect(result).toBe(noHierarchy);
    });

    test("keeps interactive nodes, drops non-criteria nodes, and hoists surviving grandchildren", function () {
      const testHierarchy = {
        hierarchy: {
          $: { class: "android.widget.FrameLayout" },
          node: [
            { $: { text: "Keep this", class: "android.widget.Button" } },
            { $: { clickable: "true", class: "android.widget.View" } },
            { $: { enabled: "true", class: "android.widget.View" } }, // Should be filtered out
            {
              $: { class: "android.widget.LinearLayout" },
              node: {
                $: { "resource-id": "important_button", class: "android.widget.Button" },
              },
            },
          ],
        },
      };

      const result = viewHierarchy.filterViewHierarchy(testHierarchy);

      // The enabled-only View is dropped (enabled is not an interactive flag).
      // The LinearLayout itself fails the criteria, so its surviving child
      // (resource-id="important_button") is hoisted into the root's child list.
      // cleanNodeProperties strips class/enabled and keeps only meaningful props.
      expect(result.hierarchy).toEqual({
        $: { class: "android.widget.FrameLayout" },
        node: [{ text: "Keep this" }, { clickable: "true" }, { "resource-id": "important_button" }],
      });
    });

    test("keeps semantic-link metadata while filtering hierarchy properties", function () {
      const result = viewHierarchy.filterViewHierarchy({
        hierarchy: {
          $: { class: "android.widget.TextView" },
          node: {
            $: {
              text: "Terms of Service",
              "semantic-links": [{ text: "Terms of Service", occurrence: 0, start: 0, end: 16 }],
            },
          },
        },
      });

      expect(result.hierarchy).toEqual({
        $: { class: "android.widget.TextView" },
        node: {
          text: "Terms of Service",
          "semantic-links": [{ text: "Terms of Service", occurrence: 0, start: 0, end: 16 }],
        },
      });
    });

    test("returns an empty child list at the root when every descendant is filtered out", function () {
      // Regression for issue #4172 item 4 / A3: filterSingleNode's root branch
      // must overwrite the cloned children even when NOTHING survives, otherwise
      // the raw (unfiltered) subtree leaks to the model. Here no descendant meets
      // the criteria, so the root must report an empty child list, not the raw nodes.
      const testHierarchy = {
        hierarchy: {
          $: { class: "android.widget.FrameLayout" },
          node: [
            { $: { enabled: "true", class: "android.view.View" } },
            {
              $: { class: "android.widget.LinearLayout" },
              node: { $: { enabled: "false", class: "android.view.View" } },
            },
          ],
        },
      };

      const result = viewHierarchy.filterViewHierarchy(testHierarchy);

      expect(result.hierarchy.node).toEqual([]);
      // The raw child props (enabled/class) must not survive anywhere.
      expect(JSON.stringify(result.hierarchy)).not.toContain("android.view.View");
    });
  });

  describe("Edge Cases and Additional Coverage", function () {
    let viewHierarchy: ViewHierarchy;
    let fakeAdb: FakeAdbExecutor;
    let mockCtrlProxyClient: AndroidCtrlProxyClient;
    let mockDevice: BootedDevice;

    beforeEach(function () {
      mockDevice = {
        deviceId: "test-device",
        name: "Test Device",
        platform: "android",
      };
      fakeAdb = new FakeAdbExecutor();

      mockCtrlProxyClient = {
        getLatestHierarchy: async () => null,
        convertToViewHierarchyResult: () => ({ hierarchy: {} }),
        convertAccessibilityNode: () => ({}),
        getAccessibilityHierarchy: async () => null,
      } as unknown as AndroidCtrlProxyClient;

      viewHierarchy = new ViewHierarchy(
        mockDevice,
        new FakeAdbClientFactory(fakeAdb),
        mockCtrlProxyClient,
      );
    });

    test("should handle node with empty children array", function () {
      const nodeWithEmptyChildren = {
        $: { text: "parent" },
        node: [],
      };

      const filteredChildren = viewHierarchy.processNodeChildren(
        nodeWithEmptyChildren,
        (child) => child,
      );
      expect(filteredChildren).toHaveLength(0);
    });

    test("should handle node with single child (not array)", function () {
      const nodeWithSingleChild = {
        $: { text: "parent" },
        node: { $: { text: "single child", clickable: "true" } },
      };

      const filteredChildren = viewHierarchy.processNodeChildren(nodeWithSingleChild, (child) => {
        return viewHierarchy.meetsFilterCriteria(child.$) ? child : null;
      });

      expect(filteredChildren).toHaveLength(1);
      expect(filteredChildren[0].$).toHaveProperty("text", "single child");
    });

    test("should handle filterSingleNode with null input", function () {
      const result = viewHierarchy.filterSingleNode(null);
      expect(result).toBeNull();
    });

    test("should handle node with over 64 children (should be limited)", function () {
      const manyChildren = [];
      for (let i = 0; i < 100; i++) {
        manyChildren.push({ $: { text: `child${i}`, clickable: "true" } });
      }

      const nodeWithManyChildren = {
        $: { text: "parent" },
        node: manyChildren,
      };

      const filteredChildren = viewHierarchy.processNodeChildren(
        nodeWithManyChildren,
        (child) => child,
      );
      expect(filteredChildren).toHaveLength(64); // Should be limited to 64
    });

    test("should handle string filter criteria with empty values", function () {
      const propsWithEmptyText = { text: "" };
      const propsWithEmptyResourceId = { "resource-id": "" };
      const propsWithNullText = { text: null };

      expect(viewHierarchy.meetsStringFilterCriteria(propsWithEmptyText)).toBe(false);
      expect(viewHierarchy.meetsStringFilterCriteria(propsWithEmptyResourceId)).toBe(false);
      expect(viewHierarchy.meetsStringFilterCriteria(propsWithNullText)).toBe(false);
    });

    test("should handle boolean filter criteria with string values", function () {
      const propsWithStringTrue = { clickable: "true" };
      const propsWithStringFalse = { clickable: "false" };
      const propsWithActualBoolean = { clickable: true };

      expect(viewHierarchy.meetsBooleanFilterCriteria(propsWithStringTrue)).toBe(true);
      expect(viewHierarchy.meetsBooleanFilterCriteria(propsWithStringFalse)).toBe(false);
      expect(viewHierarchy.meetsBooleanFilterCriteria(propsWithActualBoolean)).toBe(false);
    });

    test("should handle normalize structure with empty array", function () {
      const emptyArray: any[] = [];
      const result = viewHierarchy.normalizeNodeStructure(emptyArray);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    test("should handle filter criteria with mixed property formats", function () {
      const mixedProps = {
        resourceId: "button_id", // camelCase
        "content-desc": "Button description", // hyphenated
        scrollable: "true",
      };

      expect(viewHierarchy.meetsStringFilterCriteria(mixedProps)).toBe(true);
      expect(viewHierarchy.meetsBooleanFilterCriteria(mixedProps)).toBe(true);
      expect(viewHierarchy.meetsFilterCriteria(mixedProps)).toBe(true);
    });

    test("should retain long-clickable-only nodes without text or content-desc", function () {
      const longClickableImageView = {
        className: "android.widget.ImageView",
        "resource-id": "com.app:id/splash_animation",
        "long-clickable": "true",
        clickable: "false",
        bounds: { left: 192, top: 1036, right: 1088, bottom: 2364 },
      };

      expect(viewHierarchy.meetsBooleanFilterCriteria(longClickableImageView)).toBe(true);
      expect(viewHierarchy.meetsFilterCriteria(longClickableImageView)).toBe(true);

      const filtered = viewHierarchy.filterSingleNode(longClickableImageView);
      expect(filtered).toBeDefined();
      expect(filtered).toHaveProperty("long-clickable", "true");
      expect(filtered).toHaveProperty("resource-id", "com.app:id/splash_animation");
      expect(filtered).toHaveProperty("bounds", {
        left: 192,
        top: 1036,
        right: 1088,
        bottom: 2364,
      });
    });

    test("should clean node properties correctly with various edge cases", function () {
      const nodeWithVariousProps = {
        $: {
          text: "valid text",
          resourceId: "valid_id", // camelCase - should be normalized to resource-id
          contentDesc: "valid desc", // camelCase - should be normalized to content-desc
          enabled: "true", // should be filtered out
          clickable: "false", // should be filtered out
          scrollable: "true", // should be kept
          class: "android.widget.View", // not in allowed properties
          "content-desc": "", // empty string should be filtered out
          bounds: { left: 0, top: 0, right: 100, bottom: 100 }, // should be kept
        },
      };

      const filteredNode = viewHierarchy.filterSingleNode(nodeWithVariousProps);

      expect(filteredNode).toBeDefined();
      expect(filteredNode).toHaveProperty("text", "valid text");
      expect(filteredNode).toHaveProperty("resource-id", "valid_id");
      expect(filteredNode).toHaveProperty("content-desc", "valid desc");
      expect(filteredNode).toHaveProperty("scrollable", "true");
      expect(filteredNode).toHaveProperty("bounds", {
        left: 0,
        top: 0,
        right: 100,
        bottom: 100,
      });
      expect(filteredNode).not.toHaveProperty("enabled");
      expect(filteredNode).not.toHaveProperty("clickable");
      expect(filteredNode).not.toHaveProperty("class");
    });

    test("should handle node without $ properties correctly", function () {
      const nodeWithoutDollar = {
        text: "direct text",
        resourceId: "direct_id",
        enabled: "true", // should be filtered out
        scrollable: "true", // should be kept
        class: "android.widget.View", // not in allowed properties
        "content-desc": "", // empty string should be filtered out
        node: {
          text: "child text",
        },
      };

      const filteredNode = viewHierarchy.filterSingleNode(nodeWithoutDollar);

      expect(filteredNode).toBeDefined();
      expect(filteredNode).toHaveProperty("text", "direct text");
      expect(filteredNode).toHaveProperty("resourceId", "direct_id");
      expect(filteredNode).toHaveProperty("scrollable", "true");
      expect(filteredNode).not.toHaveProperty("enabled");
      expect(filteredNode).not.toHaveProperty("class");
      expect(filteredNode).not.toHaveProperty("content-desc");
    });
  });
});

describe("findFocusedElement", function () {
  let viewHierarchy: ViewHierarchy;
  let mockDevice: BootedDevice;

  beforeEach(function () {
    mockDevice = {
      deviceId: "test-device",
      name: "Test Device",
      platform: "android",
    };

    viewHierarchy = new ViewHierarchy(
      mockDevice,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      null,
    );
  });

  test("should find focused element in simple hierarchy", function () {
    const mockViewHierarchy = {
      hierarchy: {
        node: [
          {
            text: "Button 1",
            "resource-id": "com.example:id/button1",
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
            clickable: "true",
            focused: "false",
          },
          {
            text: "Input Field",
            "resource-id": "com.example:id/input",
            bounds: { left: 0, top: 60, right: 200, bottom: 100 },
            clickable: "true",
            focused: "true",
          },
        ],
      },
    };

    const focusedElement = viewHierarchy.findFocusedElement(mockViewHierarchy);

    expect(focusedElement).not.toBeNull();
    expect(focusedElement!.text).toBe("Input Field");
    expect(focusedElement!["resource-id"]).toBe("com.example:id/input");
    expect(focusedElement!.focused).toBe(true);
  });

  test("should return null when no element is focused", function () {
    const mockViewHierarchy = {
      hierarchy: {
        node: [
          {
            text: "Button 1",
            "resource-id": "com.example:id/button1",
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
            clickable: "true",
            focused: "false",
          },
          {
            text: "Button 2",
            "resource-id": "com.example:id/button2",
            bounds: { left: 0, top: 110, right: 100, bottom: 160 },
            clickable: "true",
            focused: "false",
          },
        ],
      },
    };

    const focusedElement = viewHierarchy.findFocusedElement(mockViewHierarchy);

    expect(focusedElement).toBeNull();
  });

  test("should return null for empty or null hierarchy", function () {
    expect(viewHierarchy.findFocusedElement(null)).toBeNull();
    expect(viewHierarchy.findFocusedElement({})).toBeNull();
    expect(viewHierarchy.findFocusedElement({ hierarchy: null })).toBeNull();
  });

  test("should find focused element in deeply nested hierarchy", function () {
    const mockViewHierarchy = {
      hierarchy: {
        node: {
          text: "Container",
          "resource-id": "com.example:id/container",
          bounds: { left: 0, top: 0, right: 300, bottom: 200 },
          focused: "false",
          node: {
            text: "SubContainer",
            "resource-id": "com.example:id/sub_container",
            bounds: { left: 10, top: 10, right: 290, bottom: 190 },
            focused: "false",
            node: [
              {
                text: "Deep Button",
                "resource-id": "com.example:id/deep_button",
                bounds: { left: 20, top: 20, right: 80, bottom: 50 },
                clickable: "true",
                focused: "false",
              },
              {
                text: "Deep Input",
                "resource-id": "com.example:id/deep_input",
                bounds: { left: 20, top: 60, right: 200, bottom: 90 },
                clickable: "true",
                focused: "true",
              },
            ],
          },
        },
      },
    };

    const focusedElement = viewHierarchy.findFocusedElement(mockViewHierarchy);

    expect(focusedElement).not.toBeNull();
    expect(focusedElement!.text).toBe("Deep Input");
    expect(focusedElement!["resource-id"]).toBe("com.example:id/deep_input");
    expect(focusedElement!.focused).toBe(true);
  });

  test("should handle boolean focused property", function () {
    const mockViewHierarchy = {
      hierarchy: {
        node: {
          text: "Button",
          "resource-id": "com.example:id/button",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          clickable: "true",
          focused: true, // Boolean instead of string
        },
      },
    };

    const focusedElement = viewHierarchy.findFocusedElement(mockViewHierarchy);

    expect(focusedElement).not.toBeNull();
    expect(focusedElement!.text).toBe("Button");
    expect(focusedElement!.focused).toBe(true);
  });

  test("should handle element with $ properties structure", function () {
    const mockViewHierarchy = {
      hierarchy: {
        node: {
          $: {
            text: "Button with $",
            "resource-id": "com.example:id/button_dollar",
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
            clickable: "true",
            focused: "true",
          },
        },
      },
    };

    const focusedElement = viewHierarchy.findFocusedElement(mockViewHierarchy);

    expect(focusedElement).not.toBeNull();
    expect(focusedElement!.text).toBe("Button with $");
    expect(focusedElement!["resource-id"]).toBe("com.example:id/button_dollar");
    expect(focusedElement!.focused).toBe(true);
  });

  test("should stop at first focused element found", function () {
    const mockViewHierarchy = {
      hierarchy: {
        node: [
          {
            text: "First Focused",
            "resource-id": "com.example:id/first",
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
            clickable: "true",
            focused: "true",
          },
          {
            text: "Second Focused",
            "resource-id": "com.example:id/second",
            bounds: { left: 0, top: 60, right: 100, bottom: 110 },
            clickable: "true",
            focused: "true",
          },
        ],
      },
    };

    const focusedElement = viewHierarchy.findFocusedElement(mockViewHierarchy);

    expect(focusedElement).not.toBeNull();
    expect(focusedElement!.text).toBe("First Focused");
    expect(focusedElement!["resource-id"]).toBe("com.example:id/first");
  });

  test("should handle elements without valid bounds", function () {
    const mockViewHierarchy = {
      hierarchy: {
        node: {
          text: "Invalid Bounds Element",
          "resource-id": "com.example:id/invalid",
          bounds: "invalid-bounds-format",
          focused: "true",
        },
      },
    };

    const focusedElement = viewHierarchy.findFocusedElement(mockViewHierarchy);

    // Should return null because parseNodeBounds fails for invalid bounds
    expect(focusedElement).toBeNull();
  });
});

describe("Offscreen Node Filtering", function () {
  let viewHierarchy: ViewHierarchy;
  let fakeAdb: FakeAdbExecutor;
  let mockDevice: BootedDevice;
  let originalLogLevel: LogLevel;

  beforeEach(function () {
    originalLogLevel = logger.getLogLevel();
    mockDevice = {
      deviceId: "test-device",
      name: "Test Device",
      platform: "android",
    };
    fakeAdb = new FakeAdbExecutor();
    viewHierarchy = new ViewHierarchy(mockDevice, new FakeAdbClientFactory(fakeAdb));
  });

  afterEach(function () {
    logger.setLogLevel(originalLogLevel);
  });

  test("should filter out nodes completely below the screen", function () {
    const hierarchy = {
      hierarchy: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: [
          { text: "Visible", bounds: { left: 0, top: 100, right: 500, bottom: 200 } },
          { text: "Below Screen", bounds: { left: 0, top: 2600, right: 500, bottom: 2800 } },
          { text: "Way Below", bounds: { left: 0, top: 3000, right: 500, bottom: 3200 } },
        ],
      },
    };

    const result = viewHierarchy.filterOffscreenNodes(hierarchy, 1080, 2400);

    // Flatten nodes for checking
    const flatNodes: string[] = [];
    const collectNodes = (node: any) => {
      if (node.text) {
        flatNodes.push(node.text);
      }
      if (node.node) {
        const children = Array.isArray(node.node) ? node.node : [node.node];
        children.forEach(collectNodes);
      }
    };
    collectNodes(result.hierarchy);

    expect(flatNodes).toContain("Visible");
    expect(flatNodes).not.toContain("Below Screen");
    expect(flatNodes).not.toContain("Way Below");
  });

  test("should filter out nodes completely above the screen", function () {
    const hierarchy = {
      hierarchy: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: [
          { text: "Visible", bounds: { left: 0, top: 100, right: 500, bottom: 200 } },
          { text: "Above Screen", bounds: { left: 0, top: -500, right: 500, bottom: -300 } },
        ],
      },
    };

    const result = viewHierarchy.filterOffscreenNodes(hierarchy, 1080, 2400);

    const flatNodes: string[] = [];
    const collectNodes = (node: any) => {
      if (node.text) {
        flatNodes.push(node.text);
      }
      if (node.node) {
        const children = Array.isArray(node.node) ? node.node : [node.node];
        children.forEach(collectNodes);
      }
    };
    collectNodes(result.hierarchy);

    expect(flatNodes).toContain("Visible");
    expect(flatNodes).not.toContain("Above Screen");
  });

  test("should keep nodes within margin of screen edge", function () {
    const hierarchy = {
      hierarchy: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: [
          { text: "JustBelow", bounds: { left: 0, top: 2450, right: 500, bottom: 2550 } }, // Within 100px margin
          { text: "FarBelow", bounds: { left: 0, top: 2600, right: 500, bottom: 2800 } }, // Beyond margin
        ],
      },
    };

    const result = viewHierarchy.filterOffscreenNodes(hierarchy, 1080, 2400, 100);

    const flatNodes: string[] = [];
    const collectNodes = (node: any) => {
      if (node.text) {
        flatNodes.push(node.text);
      }
      if (node.node) {
        const children = Array.isArray(node.node) ? node.node : [node.node];
        children.forEach(collectNodes);
      }
    };
    collectNodes(result.hierarchy);

    expect(flatNodes).toContain("JustBelow");
    expect(flatNodes).not.toContain("FarBelow");
  });

  test("should handle negative coordinates in bounds", function () {
    const hierarchy = {
      hierarchy: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: [
          { text: "Visible", bounds: { left: 0, top: 100, right: 500, bottom: 200 } },
          { text: "PartiallyLeft", bounds: { left: -50, top: 100, right: 100, bottom: 200 } }, // Partially visible
          { text: "CompletelyLeft", bounds: { left: -500, top: -300, right: -200, bottom: 100 } }, // Completely offscreen
        ],
      },
    };

    const result = viewHierarchy.filterOffscreenNodes(hierarchy, 1080, 2400);

    const flatNodes: string[] = [];
    const collectNodes = (node: any) => {
      if (node.text) {
        flatNodes.push(node.text);
      }
      if (node.node) {
        const children = Array.isArray(node.node) ? node.node : [node.node];
        children.forEach(collectNodes);
      }
    };
    collectNodes(result.hierarchy);

    expect(flatNodes).toContain("Visible");
    expect(flatNodes).toContain("PartiallyLeft");
    expect(flatNodes).not.toContain("CompletelyLeft");
  });

  test("should return original hierarchy if screen dimensions are invalid", function () {
    const hierarchy = {
      hierarchy: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: { text: "Test", bounds: { left: 0, top: 100, right: 500, bottom: 200 } },
      },
    };

    const result = viewHierarchy.filterOffscreenNodes(hierarchy, 0, 0);

    expect(result).toEqual(hierarchy);
  });

  test("should not serialize hierarchy size metrics when debug logging is disabled", function () {
    logger.setLogLevel(LogLevel.INFO);
    const stringifySpy = spyOn(JSON, "stringify");
    const hierarchy = {
      hierarchy: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: [
          { text: "Visible", bounds: { left: 0, top: 100, right: 500, bottom: 200 } },
          { text: "Below Screen", bounds: { left: 0, top: 3000, right: 500, bottom: 3200 } },
        ],
      },
    };

    try {
      const result = viewHierarchy.filterOffscreenNodes(hierarchy, 1080, 2400);

      expect(result.hierarchy.node.text).toBe("Visible");
      expect(stringifySpy).not.toHaveBeenCalled();
    } finally {
      stringifySpy.mockRestore();
    }
  });

  test("should keep hierarchy size metrics when debug logging is enabled", function () {
    logger.setLogLevel(LogLevel.DEBUG);
    const debugSpy = spyOn(logger, "debug");
    const hierarchy = {
      hierarchy: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: [
          { text: "Visible", bounds: { left: 0, top: 100, right: 500, bottom: 200 } },
          { text: "Below Screen", bounds: { left: 0, top: 3000, right: 500, bottom: 3200 } },
          { text: "Way Below", bounds: { left: 0, top: 3400, right: 500, bottom: 3600 } },
        ],
      },
    };

    try {
      viewHierarchy.filterOffscreenNodes(hierarchy, 1080, 2400);

      // Assert the observable outcome (the emitted debug metric), not the number
      // of internal JSON.stringify calls (issue #4172 item R6).
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("Offscreen filtering reduced hierarchy by"),
      );
    } finally {
      debugSpy.mockRestore();
    }
  });

  test("should preserve visible children of offscreen parents", function () {
    const hierarchy = {
      hierarchy: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: {
          text: "OffscreenParent",
          bounds: { left: 0, top: 3000, right: 1080, bottom: 4000 },
          node: [{ text: "VisibleChild", bounds: { left: 0, top: 100, right: 500, bottom: 200 } }],
        },
      },
    };

    const result = viewHierarchy.filterOffscreenNodes(hierarchy, 1080, 2400);

    const flatNodes: string[] = [];
    const collectNodes = (node: any) => {
      if (node.text) {
        flatNodes.push(node.text);
      }
      if (node.node) {
        const children = Array.isArray(node.node) ? node.node : [node.node];
        children.forEach(collectNodes);
      }
    };
    collectNodes(result.hierarchy);

    // Visible child should be preserved even though parent is offscreen
    expect(flatNodes).toContain("VisibleChild");
    // Offscreen parent should be removed
    expect(flatNodes).not.toContain("OffscreenParent");
  });

  describe("findAccessibilityFocusedElement", function () {
    test("should find accessibility-focused element from top-level field", function () {
      const hierarchy = {
        "accessibility-focused-element": {
          text: "Focused Button",
          "resource-id": "com.app:id/button",
          "content-desc": "Submit",
          bounds: { left: 100, top: 200, right: 300, bottom: 250 },
        },
        hierarchy: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [{ text: "Other Button", bounds: { left: 0, top: 100, right: 500, bottom: 200 } }],
        },
      };

      const result = viewHierarchy.findAccessibilityFocusedElement(hierarchy);

      expect(result).not.toBeNull();
      expect(result?.text).toBe("Focused Button");
      expect(result?.["resource-id"]).toBe("com.app:id/button");
      expect(result?.["content-desc"]).toBe("Submit");
      expect(result?.["accessibility-focused"]).toBe(true);
    });

    test("should find accessibility-focused element by traversing hierarchy", function () {
      const hierarchy = {
        hierarchy: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [
            { text: "Button 1", bounds: { left: 0, top: 100, right: 500, bottom: 200 } },
            {
              text: "Container",
              bounds: { left: 0, top: 300, right: 500, bottom: 600 },
              node: [
                {
                  text: "Button 2",
                  "accessibility-focused": "true",
                  bounds: { left: 10, top: 310, right: 490, bottom: 350 },
                },
                { text: "Button 3", bounds: { left: 10, top: 360, right: 490, bottom: 400 } },
              ],
            },
          ],
        },
      };

      const result = viewHierarchy.findAccessibilityFocusedElement(hierarchy);

      expect(result).not.toBeNull();
      expect(result?.text).toBe("Button 2");
      expect(result?.["accessibility-focused"]).toBe(true);
    });

    test("should return null when no accessibility-focused element exists", function () {
      const hierarchy = {
        hierarchy: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [
            { text: "Button 1", bounds: { left: 0, top: 100, right: 500, bottom: 200 } },
            { text: "Button 2", bounds: { left: 0, top: 300, right: 500, bottom: 400 } },
          ],
        },
      };

      const result = viewHierarchy.findAccessibilityFocusedElement(hierarchy);

      expect(result).toBeNull();
    });

    test("should return null when hierarchy is null", function () {
      const result = viewHierarchy.findAccessibilityFocusedElement(null);

      expect(result).toBeNull();
    });

    test("should prioritize top-level field over hierarchy traversal", function () {
      const hierarchy = {
        "accessibility-focused-element": {
          text: "Top-level Focused",
          bounds: { left: 100, top: 200, right: 300, bottom: 250 },
        },
        hierarchy: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [
            {
              text: "Hierarchy Focused",
              "accessibility-focused": "true",
              bounds: { left: 0, top: 100, right: 500, bottom: 200 },
            },
          ],
        },
      };

      const result = viewHierarchy.findAccessibilityFocusedElement(hierarchy);

      expect(result).not.toBeNull();
      expect(result?.text).toBe("Top-level Focused");
      expect(result?.["accessibility-focused"]).toBe(true);
    });

    test("should search across top-level root nodes for accessibility-focused element", function () {
      const hierarchy = {
        hierarchy: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [
            { text: "Main Window Button", bounds: { left: 0, top: 100, right: 500, bottom: 200 } },
            {
              bounds: { left: 0, top: 0, right: 500, bottom: 300 },
              node: [
                {
                  text: "Popup Button",
                  "accessibility-focused": "true",
                  bounds: { left: 10, top: 10, right: 490, bottom: 50 },
                },
              ],
            },
          ],
        },
      };

      const result = viewHierarchy.findAccessibilityFocusedElement(hierarchy);

      expect(result).not.toBeNull();
      expect(result?.text).toBe("Popup Button");
      expect(result?.["accessibility-focused"]).toBe(true);
    });
  });

  describe("error-result shape (#3594)", function () {
    const device: BootedDevice = {
      deviceId: "test-device",
      name: "Test Device",
      platform: "android",
    };

    test("populates updatedAt when the accessibility service returns null", async function () {
      const nullClient = {
        getAccessibilityHierarchy: async () => null,
      } as unknown as AndroidCtrlProxyClient;
      const vh = new ViewHierarchy(device, new FakeAdbClientFactory(), nullClient);

      const result = await vh.getAndroidViewHierarchy();

      expect(result.hierarchy.error).toBeDefined();
      expect(typeof result.updatedAt).toBe("number");
    });

    test("populates updatedAt when the accessibility service throws", async function () {
      const throwingClient = {
        getAccessibilityHierarchy: async () => {
          throw new Error("ctrlproxy offline");
        },
      } as unknown as AndroidCtrlProxyClient;
      const vh = new ViewHierarchy(device, new FakeAdbClientFactory(), throwingClient);

      const result = await vh.getAndroidViewHierarchy();

      expect(result.hierarchy.error).toBeDefined();
      expect(typeof result.updatedAt).toBe("number");
    });
  });
});
