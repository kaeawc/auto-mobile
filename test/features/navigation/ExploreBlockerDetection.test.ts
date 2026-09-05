import { expect, describe, test, spyOn } from "bun:test";
import { Element } from "../../../src/models";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import type { ElementParser } from "../../../src/utils/interfaces/ElementParser";
import {
  isPermissionDialog,
  isLoginScreen,
  isRatingDialog,
  detectAndHandleBlockers,
  handlePermissionDialog,
} from "../../../src/features/navigation/ExploreBlockerDetection";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { defaultTimer } from "../../../src/utils/SystemTimer";

describe("ExploreBlockerDetection", () => {
  function createMockElement(overrides: Partial<Element> = {}): Element {
    return {
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      clickable: true,
      enabled: true,
      text: "Button",
      class: "android.widget.Button",
      "resource-id": "com.test:id/button",
      ...overrides,
    } as Element;
  }

  describe("isPermissionDialog", () => {
    test("should detect dialog with 'Allow' button", () => {
      const elements = [createMockElement({ text: "Allow" }), createMockElement({ text: "Deny" })];

      expect(isPermissionDialog(elements)).toBe(true);
    });

    test("should detect dialog with 'permission' text", () => {
      const elements = [
        createMockElement({ text: "This app needs permission to access your camera" }),
      ];

      expect(isPermissionDialog(elements)).toBe(true);
    });

    test("should detect dialog with 'While using' option", () => {
      const elements = [
        createMockElement({ text: "While using the app" }),
        createMockElement({ text: "Only this time" }),
      ];

      expect(isPermissionDialog(elements)).toBe(true);
    });

    test("should detect dialog with 'access' text", () => {
      const elements = [createMockElement({ text: "Allow access to photos?" })];

      expect(isPermissionDialog(elements)).toBe(true);
    });

    test("should detect via content-desc", () => {
      const elements = [createMockElement({ text: "", "content-desc": "Allow permission button" })];

      expect(isPermissionDialog(elements)).toBe(true);
    });

    test("should not detect regular buttons", () => {
      const elements = [
        createMockElement({ text: "Submit" }),
        createMockElement({ text: "Cancel" }),
      ];

      expect(isPermissionDialog(elements)).toBe(false);
    });

    test("should be case insensitive", () => {
      const elements = [createMockElement({ text: "ALLOW" }), createMockElement({ text: "DENY" })];

      expect(isPermissionDialog(elements)).toBe(true);
    });

    // Issue #6122: keywords were matched as bare substrings, so ordinary UI
    // text containing "access" ("Accessibility", "Quick access") was
    // misclassified as a permission dialog — same defect class as #4190.
    // "access" is dropped from the keyword list entirely (see
    // PERMISSION_KEYWORDS) rather than boundary-matched, because as a whole
    // word it still appears in ambient, non-permission UI.
    test.each([
      // [text, expected]
      ["Accessibility", false],
      ["ACCESSIBILITY", false],
      ["Accessibility settings", false],
      ["Quick access", false],
      ["Access your library", false],
      ["Accessible", false],
      ["Disallow", false],
      ["Allowance", false],
      ["Bookmarks", false],
      ["Home", false],
      ["Settings", false],
      // positive controls: real permission dialogs must still match
      ["Allow", true],
      ["allow", true],
      ["ALLOW", true],
      ["Allow access to your location?", true], // matches via "allow", not "access"
      ["Deny", true],
      ["This app needs permission to access your camera", true], // matches via "permission"
      ["While using the app", true],
      ["Only this time", true],
      ["Don't allow", true],
    ])("isPermissionDialog(%p) === %p", (text: string, expected: boolean) => {
      expect(isPermissionDialog([createMockElement({ text })])).toBe(expected);
    });

    // Issue #6122 follow-up: a multi-word keyword must not be manufactured by
    // joining `text` and `content-desc` — each field is matched on its own.
    test("does not match a multiword keyword split across text and content-desc", () => {
      const elements = [createMockElement({ text: "Only", "content-desc": "this time" })];

      expect(isPermissionDialog(elements)).toBe(false);
    });

    test("still matches a multiword keyword contained wholly in one field", () => {
      const textOnly = [createMockElement({ text: "Only this time", "content-desc": "" })];
      const contentDescOnly = [createMockElement({ text: "", "content-desc": "Only this time" })];

      expect(isPermissionDialog(textOnly)).toBe(true);
      expect(isPermissionDialog(contentDescOnly)).toBe(true);
    });
  });

  describe("isLoginScreen", () => {
    test("should detect screen with login text and EditText", () => {
      const elements = [
        createMockElement({ text: "Login", class: "android.widget.Button" }),
        createMockElement({ text: "", class: "android.widget.EditText" }),
      ];

      expect(isLoginScreen(elements)).toBe(true);
    });

    test("should detect screen with sign in text", () => {
      const elements = [
        createMockElement({ text: "Sign in", class: "android.widget.Button" }),
        createMockElement({ text: "", class: "android.widget.EditText" }),
      ];

      expect(isLoginScreen(elements)).toBe(true);
    });

    test("should detect screen with password field", () => {
      const elements = [
        createMockElement({ text: "Password", class: "android.widget.TextView" }),
        createMockElement({ text: "", class: "android.widget.EditText" }),
      ];

      expect(isLoginScreen(elements)).toBe(true);
    });

    test("should detect screen with username field", () => {
      const elements = [
        createMockElement({ text: "Username", class: "android.widget.TextView" }),
        createMockElement({ text: "", class: "android.widget.EditText" }),
      ];

      expect(isLoginScreen(elements)).toBe(true);
    });

    test("should not detect without EditText", () => {
      const elements = [
        createMockElement({ text: "Login", class: "android.widget.Button" }),
        createMockElement({ text: "Password", class: "android.widget.TextView" }),
      ];

      expect(isLoginScreen(elements)).toBe(false);
    });

    test("should not detect without login keywords", () => {
      const elements = [
        createMockElement({ text: "Search", class: "android.widget.Button" }),
        createMockElement({ text: "", class: "android.widget.EditText" }),
      ];

      expect(isLoginScreen(elements)).toBe(false);
    });

    test("should be case insensitive", () => {
      const elements = [
        createMockElement({ text: "SIGN IN", class: "android.widget.Button" }),
        createMockElement({ text: "", class: "android.widget.EditText" }),
      ];

      expect(isLoginScreen(elements)).toBe(true);
    });
  });

  describe("isRatingDialog", () => {
    test("should detect dialog with 'rate' text", () => {
      const elements = [
        createMockElement({ text: "Rate this app" }),
        createMockElement({ text: "Not now" }),
      ];

      expect(isRatingDialog(elements)).toBe(true);
    });

    test("should detect dialog with 'review' text", () => {
      const elements = [
        createMockElement({ text: "Leave a review" }),
        createMockElement({ text: "Later" }),
      ];

      expect(isRatingDialog(elements)).toBe(true);
    });

    test("should detect dialog with 'feedback' text", () => {
      const elements = [createMockElement({ text: "Give us feedback" })];

      expect(isRatingDialog(elements)).toBe(true);
    });

    test("should detect dialog with 'enjoy' text", () => {
      const elements = [createMockElement({ text: "Enjoying the app?" })];

      expect(isRatingDialog(elements)).toBe(true);
    });

    test("should detect dialog with 'star' text", () => {
      const elements = [
        createMockElement({ text: "5 stars" }),
        createMockElement({ text: "Submit" }),
      ];

      expect(isRatingDialog(elements)).toBe(true);
    });

    test("should detect via content-desc", () => {
      const elements = [createMockElement({ text: "", "content-desc": "Rate app dialog" })];

      expect(isRatingDialog(elements)).toBe(true);
    });

    test("should not detect regular screens", () => {
      const elements = [
        createMockElement({ text: "Home" }),
        createMockElement({ text: "Settings" }),
      ];

      expect(isRatingDialog(elements)).toBe(false);
    });

    test("should be case insensitive", () => {
      const elements = [createMockElement({ text: "RATE THIS APP" })];

      expect(isRatingDialog(elements)).toBe(true);
    });

    // Issue #4190: keywords were matched as bare substrings, so ordinary UI
    // text containing "star"/"rate" ("Get Started", "Restart", "accurate")
    // was misclassified as a rating dialog.
    test.each([
      // [text, expected]
      ["Get Started", false],
      ["GET STARTED", false],
      ["Restart", false],
      ["Restart app?", false],
      ["Started", false],
      ["accurate", false],
      ["Highly accurate results", false],
      ["generate", false],
      ["Generate report", false],
      ["separate", false],
      ["Separate tabs", false],
      ["Reviewer name", false],
      ["Starter pack", false],
      ["Home", false],
      ["Settings", false],
      // positive controls: real rating dialogs must still match
      ["Rate this app", true],
      ["rate this app", true],
      ["RATE THIS APP", true],
      ["Rate us — 5 stars", true],
      ["5 stars", true],
      ["star", true],
      ["Tap a star to rate!", true],
      ["Leave a review", true],
      ["Write reviews", true],
      ["Rated 4.5", true],
      ["Rating", true],
      ["Give us feedback", true],
      ["Feedback?", true],
      ["Enjoying the app?", true],
      ["Enjoy this app?", true],
      ["(rate)", true],
      ['"review"', true],
    ])("isRatingDialog(%p) === %p", (text: string, expected: boolean) => {
      expect(isRatingDialog([createMockElement({ text })])).toBe(expected);
    });

    test("does not match across the text / content-desc boundary", () => {
      const elements = [createMockElement({ text: "Get sta", "content-desc": "rted" })];

      expect(isRatingDialog(elements)).toBe(false);
    });
  });

  describe("combined blocker detection", () => {
    test("should not detect blockers on regular navigation screens", () => {
      const elements = [
        createMockElement({ text: "Home" }),
        createMockElement({ text: "Profile" }),
        createMockElement({ text: "Settings" }),
        createMockElement({ text: "Help" }),
      ];

      expect(isPermissionDialog(elements)).toBe(false);
      expect(isLoginScreen(elements)).toBe(false);
      expect(isRatingDialog(elements)).toBe(false);
    });

    test("should handle empty element list", () => {
      expect(isPermissionDialog([])).toBe(false);
      expect(isLoginScreen([])).toBe(false);
      expect(isRatingDialog([])).toBe(false);
    });

    test("should handle elements with missing text fields", () => {
      const elements = [createMockElement({ text: undefined, "content-desc": undefined })];

      expect(isPermissionDialog(elements)).toBe(false);
      expect(isLoginScreen(elements)).toBe(false);
      expect(isRatingDialog(elements)).toBe(false);
    });
  });

  describe("dialog tap selector", () => {
    // TapOnElement.validateOptions rejects a call carrying both text and
    // elementId, so an Allow / dismiss button that has both must be tapped
    // with exactly one selector (issue #6121). The handlers hard-sleep 1s
    // after a tap via defaultTimer, so that is stubbed to keep the test fast.
    function captureTapOptions(): { calls: unknown[]; restore: () => void } {
      const calls: unknown[] = [];
      const tapSpy = spyOn(TapOnElement.prototype, "execute").mockImplementation(
        async (options: unknown) => {
          calls.push(options);
          return { success: true, action: "tap" } as never;
        },
      );
      const sleepSpy = spyOn(defaultTimer, "sleep").mockResolvedValue(undefined);
      return {
        calls,
        restore: () => {
          tapSpy.mockRestore();
          sleepSpy.mockRestore();
        },
      };
    }

    const androidDevice = { deviceId: "emulator-5554", platform: "android" } as BootedDevice;

    // The selector is chosen against the real hierarchy (tapOn's own finder
    // decides uniqueness), so give the handlers one built from the elements.
    function hierarchyOf(elements: Element[]): ViewHierarchyResult {
      return {
        hierarchy: {
          node: elements.map((element) => ({
            $: {
              class: element.class,
              text: element.text,
              "resource-id": element["resource-id"],
              "content-desc": element["content-desc"],
              clickable: String(element.clickable ?? false),
              enabled: "true",
            },
            bounds: element.bounds,
          })),
        },
        packageName: "com.test",
      } as unknown as ViewHierarchyResult;
    }

    test("handlePermissionDialog taps an Allow button with text and resource-id by id only", async () => {
      const { calls, restore } = captureTapOptions();
      const elements = [
        createMockElement({ text: "Allow camera access?", clickable: false }),
        createMockElement({
          text: "Allow",
          "resource-id": "com.android.permissioncontroller:id/permission_allow_button",
        }),
      ];

      let handled: boolean;
      try {
        handled = await handlePermissionDialog(
          elements,
          hierarchyOf(elements),
          androidDevice,
          null,
        );
      } finally {
        restore();
      }

      expect(handled).toBe(true);
      expect(calls).toEqual([
        {
          elementId: "com.android.permissioncontroller:id/permission_allow_button",
          action: "tap",
        },
      ]);
    });

    // Issue #6122: the allow-button keyword "ok" was matched as a bare
    // substring, so "Bookmarks"/"Look up"/"Cookies"/"Tokens" were tapped as
    // if they were the dialog's Allow button, before a genuine "OK" was ever
    // reached.
    test("handlePermissionDialog skips 'ok'-substring buttons and taps the real OK button", async () => {
      const { calls, restore } = captureTapOptions();
      const elements = [
        createMockElement({ text: "Bookmarks", "resource-id": "com.test:id/bookmarks" }),
        createMockElement({ text: "Cookies", "resource-id": "com.test:id/cookies" }),
        createMockElement({ text: "Tokens", "resource-id": "com.test:id/tokens" }),
        createMockElement({ text: "OK", "resource-id": "com.test:id/ok_button" }),
      ];

      let handled: boolean;
      try {
        handled = await handlePermissionDialog(
          elements,
          hierarchyOf(elements),
          androidDevice,
          null,
        );
      } finally {
        restore();
      }

      expect(handled).toBe(true);
      expect(calls).toEqual([{ elementId: "com.test:id/ok_button", action: "tap" }]);
    });

    test("handlePermissionDialog does not tap when only 'ok'-substring buttons are present", async () => {
      const { calls, restore } = captureTapOptions();
      const elements = [
        createMockElement({ text: "Bookmarks", "resource-id": "com.test:id/bookmarks" }),
        createMockElement({ text: "Cookies", "resource-id": "com.test:id/cookies" }),
      ];

      let handled: boolean;
      try {
        handled = await handlePermissionDialog(
          elements,
          hierarchyOf(elements),
          androidDevice,
          null,
        );
      } finally {
        restore();
      }

      expect(handled).toBe(false);
      expect(calls).toEqual([]);
    });

    test("dismissDialog taps a Not now button with text and resource-id by id only", async () => {
      const { calls, restore } = captureTapOptions();
      const elements = [
        createMockElement({ text: "Enjoying the app? Rate us!", clickable: false }),
        createMockElement({ text: "Not now", "resource-id": "com.test:id/dismiss_button" }),
      ];
      const parser = {
        flattenViewHierarchy: () =>
          elements.map((element, index) => ({ element, index, depth: 0 })),
      } as unknown as ElementParser;

      let handled: boolean;
      try {
        handled = await detectAndHandleBlockers(
          { viewHierarchy: hierarchyOf(elements) } as unknown as ObserveResult,
          androidDevice,
          null,
          parser,
          async () => {},
        );
      } finally {
        restore();
      }

      expect(handled).toBe(true);
      expect(calls).toEqual([{ elementId: "com.test:id/dismiss_button", action: "tap" }]);
    });

    // Discriminating regression test: "Disclosed" contains "close" and
    // "Skipping" contains "skip" as bare substrings, so under the old
    // substring matcher these would be (wrongly) tapped as dismiss buttons.
    // Word-boundary matching must reject both while still accepting a
    // genuine "Skip" button — reverting to substring matching turns this red.
    test("dismissDialog does not tap 'close'/'skip' substrings but taps a genuine Skip button", async () => {
      const { calls, restore } = captureTapOptions();
      const elements = [
        createMockElement({ text: "Enjoying the app? Rate us!", clickable: false }),
        createMockElement({ text: "Disclosed", "resource-id": "com.test:id/disclosed" }),
        createMockElement({ text: "Skipping", "resource-id": "com.test:id/skipping" }),
        createMockElement({ text: "Skip", "resource-id": "com.test:id/skip_button" }),
      ];
      const parser = {
        flattenViewHierarchy: () =>
          elements.map((element, index) => ({ element, index, depth: 0 })),
      } as unknown as ElementParser;

      let handled: boolean;
      try {
        handled = await detectAndHandleBlockers(
          { viewHierarchy: hierarchyOf(elements) } as unknown as ObserveResult,
          androidDevice,
          null,
          parser,
          async () => {},
        );
      } finally {
        restore();
      }

      expect(handled).toBe(true);
      expect(calls).toEqual([{ elementId: "com.test:id/skip_button", action: "tap" }]);
    });

    test("dismissDialog does not tap when only 'close'/'skip' substrings are present", async () => {
      const { calls, restore } = captureTapOptions();
      const elements = [
        createMockElement({ text: "Enjoying the app? Rate us!", clickable: false }),
        createMockElement({ text: "Disclosed", "resource-id": "com.test:id/disclosed" }),
        createMockElement({ text: "Skipping", "resource-id": "com.test:id/skipping" }),
      ];
      const parser = {
        flattenViewHierarchy: () =>
          elements.map((element, index) => ({ element, index, depth: 0 })),
      } as unknown as ElementParser;

      let handled: boolean;
      try {
        handled = await detectAndHandleBlockers(
          { viewHierarchy: hierarchyOf(elements) } as unknown as ObserveResult,
          androidDevice,
          null,
          parser,
          async () => {},
        );
      } finally {
        restore();
      }

      expect(handled).toBe(false);
      expect(calls).toEqual([]);
    });
  });

  describe("detectAndHandleBlockers", () => {
    // A fake ElementParser whose flattenViewHierarchy returns the configured
    // elements. detectAndHandleBlockers -> extractAllElements only touches
    // flattenViewHierarchy, so this is the entire seam. Tracks call count so we
    // can prove the error/missing-hierarchy guards bail out *before* extraction.
    function makeParser(elements: Element[]): {
      parser: ElementParser;
      extractionCount: () => number;
    } {
      let calls = 0;
      const parser = {
        flattenViewHierarchy: () => {
          calls += 1;
          return elements.map((element, index) => ({ element, index, depth: 0 }));
        },
      } as unknown as ElementParser;
      return { parser, extractionCount: () => calls };
    }

    function observationWith(
      hierarchy: { error?: string },
      packageName = "com.test",
    ): ObserveResult {
      return {
        viewHierarchy: { hierarchy, packageName },
      } as unknown as ObserveResult;
    }

    const device = {} as unknown as BootedDevice;

    // A non-clickable element trips the classifier predicates but makes both
    // handlePermissionDialog and dismissDialog no-op (they skip non-clickable
    // nodes and never construct a TapOnElement), so no real device call fires.
    const permissionAndLoginElements: Element[] = [
      { text: "Allow access", clickable: false } as Element,
      { text: "password", class: "android.widget.EditText", clickable: false } as Element,
    ];
    const loginElements: Element[] = [
      { text: "Sign in", clickable: false } as Element,
      { text: "", class: "android.widget.EditText", clickable: false } as Element,
    ];

    test("handles a permission-and-login screen as a permission dialog, not a login dead-end", async () => {
      // Permission is checked before login, so handleDeadEnd (the login handler)
      // must never fire. Kills the `false && isPermissionDialog(...)` mutant,
      // which would fall through to the login branch and invoke handleDeadEnd.
      let deadEndCalls = 0;
      const { parser } = makeParser(permissionAndLoginElements);

      const result = await detectAndHandleBlockers(
        observationWith({}),
        device,
        null,
        parser,
        async () => {
          deadEndCalls += 1;
        },
      );

      expect(deadEndCalls).toBe(0);
      // No clickable permission button -> handlePermissionDialog returns false.
      expect(result).toBe(false);
    });

    test("routes a login screen to the dead-end handler and reports it handled", async () => {
      let deadEndCalls = 0;
      const { parser } = makeParser(loginElements);

      const result = await detectAndHandleBlockers(
        observationWith({}),
        device,
        null,
        parser,
        async () => {
          deadEndCalls += 1;
        },
      );

      expect(deadEndCalls).toBe(1);
      expect(result).toBe(true);
    });

    test("returns false and never handles blockers on a regular screen", async () => {
      let deadEndCalls = 0;
      const { parser } = makeParser([
        { text: "Home", clickable: true } as Element,
        { text: "Settings", clickable: true } as Element,
      ]);

      const result = await detectAndHandleBlockers(
        observationWith({}),
        device,
        null,
        parser,
        async () => {
          deadEndCalls += 1;
        },
      );

      expect(result).toBe(false);
      expect(deadEndCalls).toBe(0);
    });

    test("bails out without extracting elements when the hierarchy carries an error", async () => {
      // The errored hierarchy still resolves to login elements, so dropping the
      // `|| viewHierarchy.hierarchy.error` guard would extract them and invoke
      // handleDeadEnd. With the guard, extraction never runs.
      let deadEndCalls = 0;
      const { parser, extractionCount } = makeParser(loginElements);

      const result = await detectAndHandleBlockers(
        observationWith({ error: "accessibility service unavailable" }),
        device,
        null,
        parser,
        async () => {
          deadEndCalls += 1;
        },
      );

      expect(result).toBe(false);
      expect(deadEndCalls).toBe(0);
      expect(extractionCount()).toBe(0);
    });

    test("returns false when the observation has no view hierarchy", async () => {
      let deadEndCalls = 0;
      const { parser, extractionCount } = makeParser(loginElements);

      const result = await detectAndHandleBlockers(
        { viewHierarchy: undefined } as unknown as ObserveResult,
        device,
        null,
        parser,
        async () => {
          deadEndCalls += 1;
        },
      );

      expect(result).toBe(false);
      expect(deadEndCalls).toBe(0);
      expect(extractionCount()).toBe(0);
    });
  });
});
