import { beforeEach, describe, expect, test } from "bun:test";
import {
  createIosDelegateHarness,
  type IosDelegateHarness,
} from "../../../helpers/iosDelegateHarness";
import { CtrlProxyVoiceOver } from "../../../../src/features/observe/ios/CtrlProxyVoiceOver";
import { CtrlProxyNavigation } from "../../../../src/features/observe/ios/CtrlProxyNavigation";
import { CtrlProxyClipboard } from "../../../../src/features/observe/ios/CtrlProxyClipboard";
import { CtrlProxyScreenshot } from "../../../../src/features/observe/ios/CtrlProxyScreenshot";
import { CtrlProxyPermissions } from "../../../../src/features/observe/ios/CtrlProxyPermissions";

/**
 * PARAM-6 (issue #4174, item 8): read-only / non-mutating iOS commands must NOT
 * cancel the pending screenshot backoff. Each of these `sendCommand` call sites
 * passes `cancelScreenshotBackoff: false`; if any regresses to the default
 * (`true`), the live-view screenshot backoff is torn down on every VoiceOver /
 * clipboard / navigation poll and the stream visibly freezes.
 *
 * The harness counts `cancelScreenshotBackoff()` invocations. Each row drives one
 * command and asserts the count stayed 0. The table is mutation-sensitive: flip
 * any single site to `true` and exactly that row fails.
 */
describe("read-only iOS commands do not cancel the screenshot backoff", () => {
  const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

  let h: IosDelegateHarness;
  beforeEach(() => {
    h = createIosDelegateHarness();
  });

  interface Row {
    name: string;
    invoke: (harness: IosDelegateHarness) => Promise<unknown>;
  }

  const rows: Row[] = [
    {
      name: "get_voiceover_state",
      invoke: (hh) => new CtrlProxyVoiceOver(hh.context).requestVoiceOverState(),
    },
    {
      name: "request_action",
      invoke: (hh) => new CtrlProxyVoiceOver(hh.context).requestAction("scroll_forward"),
    },
    {
      name: "request_action (voiceover activate)",
      invoke: (hh) =>
        new CtrlProxyVoiceOver(hh.context).requestVoiceOverActivate("Submit", "activate"),
    },
    {
      name: "request_press_home",
      invoke: (hh) => new CtrlProxyNavigation(hh.context).requestPressHome(),
    },
    {
      name: "request_press_back",
      invoke: (hh) => new CtrlProxyNavigation(hh.context).requestPressBack(),
    },
    { name: "request_shake", invoke: (hh) => new CtrlProxyNavigation(hh.context).requestShake() },
    {
      name: "request_press_button",
      invoke: (hh) => new CtrlProxyNavigation(hh.context).requestPressButton("home"),
    },
    {
      name: "request_rotate",
      invoke: (hh) => new CtrlProxyNavigation(hh.context).requestRotate("portrait"),
    },
    {
      name: "request_recent_apps",
      invoke: (hh) => new CtrlProxyNavigation(hh.context).requestRecentApps(),
    },
    {
      name: "request_clipboard",
      invoke: (hh) => new CtrlProxyClipboard(hh.context).requestClipboard("get"),
    },
    {
      name: "request_screenshot",
      invoke: (hh) => new CtrlProxyScreenshot(hh.context).requestScreenshot(),
    },
    {
      name: "request_reset_permissions",
      invoke: (hh) =>
        new CtrlProxyPermissions(hh.context).requestResetPermissions("com.app", ["camera"]),
    },
  ];

  for (const row of rows) {
    test(`${row.name} leaves the screenshot backoff intact`, async () => {
      const promise = row.invoke(h);
      await flush();
      // The observable contract: the command reached the wire but did NOT cancel
      // the backoff.
      expect(h.cancelScreenshotBackoffCalls).toBe(0);
      expect(h.sentMessages).toHaveLength(1);
      // Settle the pending request so nothing dangles.
      h.resolveLast({ success: true, totalTimeMs: 0 });
      await promise;
    });
  }
});
