import { expect, describe, test } from "bun:test";
import { Element } from "../../../src/models";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import type { ElementParser } from "../../../src/utils/interfaces/ElementParser";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";
import {
  isPermissionDialog,
  isLoginScreen,
  isRatingDialog,
  detectAndHandleBlockers,
  filterPermissionNavigationCandidates,
  handlePermissionDialog,
  isPermissionDenyElement,
} from "../../../src/features/navigation/ExploreBlockerDetection";
import type { BlockerHandlerDeps } from "../../../src/features/navigation/ExploreBlockerDetection";
import { FakeDialogTapAction } from "../../fakes/FakeDialogTapAction";
import { FakeTimer } from "../../fakes/FakeTimer";

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
    // text containing "access" ("Accessibility") was misclassified as a
    // permission dialog — same defect class as #4190. Tokenizing splits
    // "Accessibility" into the single token ["accessibility"], distinct from
    // ["access"], so "access" is safely kept as its own exact keyword (an
    // earlier revision dropped it defensively before the tokenizer existed
    // to make that distinction — see PERMISSION_KEYWORDS).
    test.each([
      // [text, expected]
      ["Accessibility", false],
      ["ACCESSIBILITY", false],
      ["Accessibility settings", false],
      ["Accessible", false],
      ["Disallow", false],
      ["Allowance", false],
      ["disallowance", false],
      ["Bookmarks", false],
      ["Home", false],
      ["Settings", false],
      // positive controls: real permission dialogs must still match
      ["Allow", true],
      ["allow", true],
      ["ALLOW", true],
      ["Allow access to your location?", true], // matches via "allow" and "access"
      ["Deny", true],
      ["This app needs permission to access your camera", true], // matches via "permission"
      ["While using the app", true],
      ["Only this time", true],
      ["Don't allow", true],
      // "access" is a real exact-token keyword again (issue #6122 follow-up
      // round 6): tokenizing keeps it distinct from "accessibility", so
      // "Camera access required" is correctly detected, and "Quick
      // access"/"Access your library" — real ambient UI, but genuinely
      // containing the standalone word "access" — now match too, which is
      // the accepted tradeoff of restoring this keyword.
      ["Camera access required", true],
      ["Quick access", true],
      ["Access your library", true],
      // machine-style accessibility ids (issue #6122 follow-up): "_"/"-"/"."
      // are separators, not word characters, so a plain `\b` boundary would
      // wrongly reject these even though the old substring check accepted
      // them.
      ["allow_button", true],
      ["permission_denied", true],
      // camelCase accessibility ids (issue #6122 follow-up round 3): a
      // lookaround excluding only [a-z0-9] treats an adjacent capital as
      // alphanumeric, so "allowButton" needs tokenizing at the camelCase
      // boundary, not just a boundary regex.
      ["allowButton", true],
      ["denyButton", true],
      // Explicit inflected forms (issue #6122 follow-up round 6): matching
      // is exact-token-only (no stemming — see `containsTokenSequence`), so
      // "permissions"/"allows" match only because they're listed explicitly
      // in PERMISSION_KEYWORDS, not derived from "permission"/"allow".
      ["Permissions required", true],
      ["Allows access", true],
      // "allow"-family machine-form negatives (issue #6293 P2): a deny-only
      // dialog whose sole content is one of these forms must still be
      // recognized as a permission dialog, or the permission fast-path never
      // runs at all and the control falls through to ordinary navigation
      // (see PERMISSION_KEYWORDS). Generic deny words unrelated to "allow"
      // are deliberately excluded from detection, so they stay `false` here.
      ["dont allow", true],
      ["dontallow", true],
      ["do not allow", true],
      ["donotallow", true],
      ["not allow", true],
      ["notallow", true],
      ["never allow", true],
      ["neverallow", true],
      ["block", false],
      ["reject", false],
      ["disallow", false],
      ["no thanks", false],
    ])("isPermissionDialog(%p) === %p", (text: string, expected: boolean) => {
      expect(isPermissionDialog([createMockElement({ text })])).toBe(expected);
    });

    // Issue #6293 P2: the exact reported scenario — a custom/OEM deny-only
    // control whose ONLY content is the fully concatenated content-desc
    // "notallow", with no separate "permission"/"access" label anywhere in
    // the dialog. Before this fix, `isPermissionDialog` didn't recognize any
    // "allow"-family deny form, so this dialog was invisible to the
    // permission fast-path entirely and its clickable deny control could be
    // tapped as ordinary navigation, silently denying the permission.
    test("detects a deny-only dialog whose sole content is content-desc 'notallow'", () => {
      const elements = [createMockElement({ text: "", "content-desc": "notallow" })];

      expect(isPermissionDialog(elements)).toBe(true);
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
    // after a tap; a FakeTimer in auto-advance mode resolves that sleep
    // immediately (and records it) so the test stays fast and deterministic.
    //
    // Injecting a FakeDialogTapAction + FakeTimer through the handler's `deps`
    // seam replaces the former `spyOn(TapOnElement.prototype, "execute")` /
    // `spyOn(defaultTimer, "sleep")` global spies (issue #6191): nothing global
    // is patched, so there is nothing to restore between tests.
    function captureTapOptions(): {
      calls: TapOnElementOptions[];
      timer: FakeTimer;
      deps: BlockerHandlerDeps;
    } {
      const tap = new FakeDialogTapAction();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      return { calls: tap.calls, timer, deps: { tapActionFactory: tap.factory, timer } };
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
      const { calls, deps } = captureTapOptions();
      const elements = [
        createMockElement({ text: "Allow camera access?", clickable: false }),
        createMockElement({
          text: "Allow",
          "resource-id": "com.android.permissioncontroller:id/permission_allow_button",
        }),
      ];

      const handled = await handlePermissionDialog(
        elements,
        hierarchyOf(elements),
        androidDevice,
        null,
        undefined,
        deps,
      );

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
      const { calls, deps } = captureTapOptions();
      const elements = [
        createMockElement({ text: "Bookmarks", "resource-id": "com.test:id/bookmarks" }),
        createMockElement({ text: "Cookies", "resource-id": "com.test:id/cookies" }),
        createMockElement({ text: "Tokens", "resource-id": "com.test:id/tokens" }),
        createMockElement({ text: "OK", "resource-id": "com.test:id/ok_button" }),
      ];

      const handled = await handlePermissionDialog(
        elements,
        hierarchyOf(elements),
        androidDevice,
        null,
        undefined,
        deps,
      );

      expect(handled).toBe(true);
      expect(calls).toEqual([{ elementId: "com.test:id/ok_button", action: "tap" }]);
    });

    test("handlePermissionDialog does not tap when only 'ok'-substring buttons are present", async () => {
      const { calls, deps } = captureTapOptions();
      const elements = [
        createMockElement({ text: "Bookmarks", "resource-id": "com.test:id/bookmarks" }),
        createMockElement({ text: "Cookies", "resource-id": "com.test:id/cookies" }),
      ];

      const handled = await handlePermissionDialog(
        elements,
        hierarchyOf(elements),
        androidDevice,
        null,
        undefined,
        deps,
      );

      expect(handled).toBe(false);
      expect(calls).toEqual([]);
    });

    // Issue #6122 follow-up: JS `\b` treats "_"/"-"/"." as word characters,
    // so a plain word-boundary pattern would wrongly reject machine-style
    // accessibility descriptions like "ok_button" even though the old
    // substring check accepted them.
    test("handlePermissionDialog taps machine-style 'ok_button'/'allow_button'/'ok.button' content-desc ids", async () => {
      for (const machineId of ["ok_button", "allow_button", "ok.button"]) {
        const { calls, deps } = captureTapOptions();
        const elements = [
          createMockElement({
            text: "",
            "content-desc": machineId,
            "resource-id": "com.test:id/ok_button",
          }),
        ];

        const handled = await handlePermissionDialog(
          elements,
          hierarchyOf(elements),
          androidDevice,
          null,
          undefined,
          deps,
        );

        expect(handled).toBe(true);
        expect(calls).toEqual([{ elementId: "com.test:id/ok_button", action: "tap" }]);
      }
    });

    // Issue #6122 follow-up round 3: a lookaround boundary treats an
    // adjacent uppercase letter as alphanumeric, so "okButton"/"allowButton"
    // regressed under the separator-boundary fix even though the old
    // substring check accepted them. "Okay" is also added as its own
    // affirmative keyword (tokenizes to ["okay"], distinct from "ok").
    test("handlePermissionDialog taps camelCase 'okButton'/'allowButton' content-desc ids and a genuine 'Okay' button", async () => {
      for (const text of ["okButton", "allowButton", "Okay"]) {
        const { calls, deps } = captureTapOptions();
        const elements = [createMockElement({ text, "resource-id": "com.test:id/ok_button" })];

        const handled = await handlePermissionDialog(
          elements,
          hierarchyOf(elements),
          androidDevice,
          null,
          undefined,
          deps,
        );

        expect(handled).toBe(true);
        expect(calls).toEqual([{ elementId: "com.test:id/ok_button", action: "tap" }]);
      }
    });

    // Issue #6122 follow-up round 4: an acronym-prefixed camelCase id like
    // "OKButton" has no lowercase-to-uppercase transition (the whole prefix
    // "OKB" is capitals), so it needs the acronym-to-titlecase split too —
    // otherwise it tokenizes as a single "okbutton" token that matches
    // nothing.
    test("handlePermissionDialog taps acronym-prefixed camelCase 'OKButton' content-desc", async () => {
      const { calls, deps } = captureTapOptions();
      const elements = [
        createMockElement({ text: "OKButton", "resource-id": "com.test:id/ok_button" }),
      ];

      const handled = await handlePermissionDialog(
        elements,
        hierarchyOf(elements),
        androidDevice,
        null,
        undefined,
        deps,
      );

      expect(handled).toBe(true);
      expect(calls).toEqual([{ elementId: "com.test:id/ok_button", action: "tap" }]);
    });

    // Issue #6241 (SAFETY): Android's deny button reads "Don't allow", which
    // tokenizes to ["don", "t", "allow"] — a genuine "allow" token — so the
    // whole-token matcher from #6190 accepted it as an Allow button. When the
    // deny button precedes the grant button in element order, the handler
    // tapped the FIRST match and silently DENIED the permission it set out to
    // grant. The deny-exclusion set must skip "Don't allow" and tap the real
    // grant button that follows it.
    test("handlePermissionDialog taps the grant button, never 'Don't allow', when deny precedes grant", async () => {
      const { calls, deps } = captureTapOptions();
      const elements = [
        createMockElement({
          text: "Don't allow",
          "resource-id": "com.android.permissioncontroller:id/permission_deny_button",
        }),
        createMockElement({
          text: "While using the app",
          "resource-id":
            "com.android.permissioncontroller:id/permission_allow_foreground_only_button",
        }),
      ];

      const handled = await handlePermissionDialog(
        elements,
        hierarchyOf(elements),
        androidDevice,
        null,
        undefined,
        deps,
      );

      expect(handled).toBe(true);
      expect(calls).toEqual([
        {
          elementId: "com.android.permissioncontroller:id/permission_allow_foreground_only_button",
          action: "tap",
        },
      ]);
    });

    // Deny-label variants must all be excluded even though each carries the
    // "allow" token (or is otherwise a negative control), while a legitimate
    // affirmative grant that follows is tapped.
    test.each([
      ["Don't allow"],
      ["Don't Allow"],
      ["DON'T ALLOW"],
      ["Don’t allow"], // curly apostrophe
      ["Never allow"],
    ])(
      "handlePermissionDialog excludes deny label %p and taps the affirmative option",
      async (denyText: string) => {
        const { calls, deps } = captureTapOptions();
        const elements = [
          createMockElement({ text: denyText, "resource-id": "com.test:id/deny" }),
          createMockElement({ text: "Only this time", "resource-id": "com.test:id/allow" }),
        ];

        const handled = await handlePermissionDialog(
          elements,
          hierarchyOf(elements),
          androidDevice,
          null,
          undefined,
          deps,
        );

        expect(handled).toBe(true);
        expect(calls).toEqual([{ elementId: "com.test:id/allow", action: "tap" }]);
      },
    );

    // No false grant: a dialog offering ONLY deny/negative controls must never
    // be tapped — the handler takes no action rather than denying the
    // permission and (previously) reporting success.
    test.each([
      ["Don't allow"],
      ["Never allow"],
      ["neverallow"],
      ["Deny"],
      ["Block"],
      // Inflected deny forms tokenize distinctly from their stems ("Blocked" ->
      // ["blocked"] != ["block"]), so each must be listed explicitly in the deny
      // set or it would slip through the token match (issue #6241 follow-up).
      ["Blocked"],
      ["Reject"],
      ["Rejected"],
      ["Disallow"],
      ["Disallowed"],
    ])(
      "handlePermissionDialog does not tap when only a deny control %p is present",
      async (denyText: string) => {
        const { calls, deps } = captureTapOptions();
        const elements = [
          createMockElement({ text: denyText, "resource-id": "com.test:id/deny_button" }),
        ];

        const handled = await handlePermissionDialog(
          elements,
          hierarchyOf(elements),
          androidDevice,
          null,
          undefined,
          deps,
        );

        expect(handled).toBe(false);
        expect(calls).toEqual([]);
      },
    );

    // A "Blocked" label in one field must veto an "allow" token carried in the
    // other, so a mixed control is never treated as an affirmative grant.
    test("handlePermissionDialog does not tap a control mixing an allow token with 'Blocked'", async () => {
      const { calls, deps } = captureTapOptions();
      const elements = [
        createMockElement({
          text: "Allow",
          "content-desc": "Blocked",
          "resource-id": "com.test:id/mixed",
        }),
      ];

      const handled = await handlePermissionDialog(
        elements,
        hierarchyOf(elements),
        androidDevice,
        null,
        undefined,
        deps,
      );

      expect(handled).toBe(false);
      expect(calls).toEqual([]);
    });

    // Machine-form negative content-desc ids ("dontAllowButton" ->
    // ["dont", "allow", "button"], "doNotAllowButton" -> ["do", "not", "allow",
    // "button"], "notAllowButton" -> ["not", "allow", "button"], and the fully
    // concatenated "notallow" -> ["notallow"]) carry an "allow" token but must
    // be recognized as deny controls, not tapped (issue #6241 follow-up). The
    // apostrophe phrase "don't allow" does not match any of these spellings,
    // so all are listed explicitly.
    test.each([
      ["dontAllowButton"],
      ["doNotAllowButton"],
      ["notAllowButton"],
      ["notallow"],
      ["dontallow"],
      ["donotallow"],
      ["Never allow"],
      ["neverallow"],
    ])(
      "handlePermissionDialog does not tap machine-form negative content-desc %p",
      async (denyContentDesc: string) => {
        const { calls, deps } = captureTapOptions();
        const elements = [
          createMockElement({
            text: "",
            "content-desc": denyContentDesc,
            "resource-id": "com.test:id/deny",
          }),
        ];

        const handled = await handlePermissionDialog(
          elements,
          hierarchyOf(elements),
          androidDevice,
          null,
          undefined,
          deps,
        );

        expect(handled).toBe(false);
        expect(calls).toEqual([]);
      },
    );

    test("classifies reported lowercase concatenated deny labels without broad substring matching", () => {
      expect(isPermissionDenyElement(createMockElement({ text: "dontallow" }))).toBe(true);
      expect(isPermissionDenyElement(createMockElement({ text: "donotallow" }))).toBe(true);
      expect(isPermissionDenyElement(createMockElement({ text: "neverallow" }))).toBe(true);
      expect(isPermissionDenyElement(createMockElement({ text: "Allow" }))).toBe(false);
      expect(isPermissionDenyElement(createMockElement({ text: "Allowance" }))).toBe(false);
    });

    test.each(["dontallow", "donotallow", "neverallow"])(
      "does not select lowercase concatenated deny label %p through ordinary navigation",
      (denyLabel: string) => {
        const deny = createMockElement({ text: denyLabel });
        expect(filterPermissionNavigationCandidates([deny], [deny])).toEqual([]);
      },
    );

    test("keeps ordinary navigation controls despite broad permission-like copy", () => {
      const accessCopy = createMockElement({ text: "Access options", clickable: false });
      const blockUser = createMockElement({ text: "Block user" });

      expect(filterPermissionNavigationCandidates([blockUser], [accessCopy, blockUser])).toEqual([
        blockUser,
      ]);
    });

    test("keeps a valid affirmative permission label selectable", () => {
      const allow = createMockElement({ text: "Allow" });
      const deny = createMockElement({ text: "dontallow" });
      expect(filterPermissionNavigationCandidates([allow, deny], [allow, deny])).toEqual([allow]);
    });

    test("removes a plain legacy package-installer denial from navigation candidates", () => {
      const allow = createMockElement({
        text: "Allow",
        "resource-id": "com.google.android.packageinstaller:id/permission_allow_button",
      });
      const deny = createMockElement({
        text: "Deny",
        "resource-id": "com.google.android.packageinstaller:id/permission_deny_button",
      });

      expect(filterPermissionNavigationCandidates([allow, deny], [allow, deny])).toEqual([allow]);
    });

    // The canonical modern layout (grant first, deny last) must keep working:
    // the grant button is tapped and the trailing "Don't allow" is ignored.
    test("handlePermissionDialog taps 'Allow' and ignores a trailing 'Don't allow'", async () => {
      const { calls, deps } = captureTapOptions();
      const elements = [
        createMockElement({
          text: "Allow",
          "resource-id": "com.android.permissioncontroller:id/permission_allow_button",
        }),
        createMockElement({
          text: "Don't allow",
          "resource-id": "com.android.permissioncontroller:id/permission_deny_button",
        }),
      ];

      const handled = await handlePermissionDialog(
        elements,
        hierarchyOf(elements),
        androidDevice,
        null,
        undefined,
        deps,
      );

      expect(handled).toBe(true);
      expect(calls).toEqual([
        {
          elementId: "com.android.permissioncontroller:id/permission_allow_button",
          action: "tap",
        },
      ]);
    });

    test("dismissDialog taps a Not now button with text and resource-id by id only", async () => {
      const { calls, deps } = captureTapOptions();
      const elements = [
        createMockElement({ text: "Enjoying the app? Rate us!", clickable: false }),
        createMockElement({ text: "Not now", "resource-id": "com.test:id/dismiss_button" }),
      ];
      const parser = {
        flattenViewHierarchy: () =>
          elements.map((element, index) => ({ element, index, depth: 0 })),
      } as unknown as ElementParser;

      const handled = await detectAndHandleBlockers(
        { viewHierarchy: hierarchyOf(elements) } as unknown as ObserveResult,
        androidDevice,
        null,
        parser,
        async () => {},
        undefined,
        deps,
      );

      expect(handled).toBe(true);
      expect(calls).toEqual([{ elementId: "com.test:id/dismiss_button", action: "tap" }]);
    });

    // Discriminating regression test: "Disclosed" contains "close" and
    // "Skipping" contains "skip" as bare substrings, so under the old
    // substring matcher these would be (wrongly) tapped as dismiss buttons.
    // Word-boundary matching must reject both while still accepting a
    // genuine "Skip" button — reverting to substring matching turns this red.
    test("dismissDialog does not tap 'close'/'skip' substrings but taps a genuine Skip button", async () => {
      const { calls, deps } = captureTapOptions();
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

      const handled = await detectAndHandleBlockers(
        { viewHierarchy: hierarchyOf(elements) } as unknown as ObserveResult,
        androidDevice,
        null,
        parser,
        async () => {},
        undefined,
        deps,
      );

      expect(handled).toBe(true);
      expect(calls).toEqual([{ elementId: "com.test:id/skip_button", action: "tap" }]);
    });

    // Issue #6122 follow-up: machine-style content-desc ids using "_"/"-"/"."
    // separators must still be tapped as dismiss buttons.
    test("dismissDialog taps machine-style 'not_now'/'skip-action'/'skip.action'/'notNow'/'skipAction' content-desc ids", async () => {
      for (const machineId of ["not_now", "skip-action", "skip.action", "notNow", "skipAction"]) {
        const { calls, deps } = captureTapOptions();
        const elements = [
          createMockElement({ text: "Enjoying the app? Rate us!", clickable: false }),
          createMockElement({
            text: "",
            "content-desc": machineId,
            "resource-id": "com.test:id/dismiss_button",
          }),
        ];
        const parser = {
          flattenViewHierarchy: () =>
            elements.map((element, index) => ({ element, index, depth: 0 })),
        } as unknown as ElementParser;

        const handled = await detectAndHandleBlockers(
          { viewHierarchy: hierarchyOf(elements) } as unknown as ObserveResult,
          androidDevice,
          null,
          parser,
          async () => {},
          undefined,
          deps,
        );

        expect(handled).toBe(true);
        expect(calls).toEqual([{ elementId: "com.test:id/dismiss_button", action: "tap" }]);
      }
    });

    test("dismissDialog does not tap when only 'close'/'skip' substrings are present", async () => {
      const { calls, deps } = captureTapOptions();
      const elements = [
        createMockElement({ text: "Enjoying the app? Rate us!", clickable: false }),
        createMockElement({ text: "Disclosed", "resource-id": "com.test:id/disclosed" }),
        createMockElement({ text: "Skipping", "resource-id": "com.test:id/skipping" }),
      ];
      const parser = {
        flattenViewHierarchy: () =>
          elements.map((element, index) => ({ element, index, depth: 0 })),
      } as unknown as ElementParser;

      const handled = await detectAndHandleBlockers(
        { viewHierarchy: hierarchyOf(elements) } as unknown as ObserveResult,
        androidDevice,
        null,
        parser,
        async () => {},
        undefined,
        deps,
      );

      expect(handled).toBe(false);
      expect(calls).toEqual([]);
    });

    // Issue #6122 follow-up round 6: an earlier inflection-tolerant matcher
    // stripped a trailing "s" before comparing tokens, so "notes" stripped
    // to "not" and falsely satisfied the dismiss phrase "not now" — a live
    // regression on any screen with a "Notes" button next to a "Now"/similar
    // label. Exact-token matching must reject this while still accepting a
    // genuine "Not now".
    test("dismissDialog does not tap a 'Notes now' false positive but taps a genuine 'Not now'", async () => {
      const { calls: notesCalls, deps: notesDeps } = captureTapOptions();
      const notesElements = [
        createMockElement({ text: "Enjoying the app? Rate us!", clickable: false }),
        createMockElement({ text: "Notes now", "resource-id": "com.test:id/notes_now" }),
      ];
      const notesParser = {
        flattenViewHierarchy: () =>
          notesElements.map((element, index) => ({ element, index, depth: 0 })),
      } as unknown as ElementParser;

      const notesHandled = await detectAndHandleBlockers(
        { viewHierarchy: hierarchyOf(notesElements) } as unknown as ObserveResult,
        androidDevice,
        null,
        notesParser,
        async () => {},
        undefined,
        notesDeps,
      );

      expect(notesHandled).toBe(false);
      expect(notesCalls).toEqual([]);

      const { calls: genuineCalls, deps: genuineDeps } = captureTapOptions();
      const genuineElements = [
        createMockElement({ text: "Enjoying the app? Rate us!", clickable: false }),
        createMockElement({ text: "Not now", "resource-id": "com.test:id/dismiss_button" }),
      ];
      const genuineParser = {
        flattenViewHierarchy: () =>
          genuineElements.map((element, index) => ({ element, index, depth: 0 })),
      } as unknown as ElementParser;

      const genuineHandled = await detectAndHandleBlockers(
        { viewHierarchy: hierarchyOf(genuineElements) } as unknown as ObserveResult,
        androidDevice,
        null,
        genuineParser,
        async () => {},
        undefined,
        genuineDeps,
      );

      expect(genuineHandled).toBe(true);
      expect(genuineCalls).toEqual([{ elementId: "com.test:id/dismiss_button", action: "tap" }]);
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
