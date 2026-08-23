import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { OpenURL } from "../../../src/features/action/OpenURL";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeDeviceUrlLauncher } from "../../fakes/FakeDeviceUrlLauncher";

/**
 * Issue #4213: `openLink` interpolated the caller-supplied URL into a command
 * STRING on both platforms, wrapped in nothing but a pair of double quotes.
 *
 * On Android that string is handed to `adb shell`, where a real shell ON THE
 * DEVICE parses it — so a URL containing `"` closes the quote and everything
 * after it is parsed as further shell words. `$`, backticks and `\` stay live
 * inside double quotes too. On iOS the simulator path ends at
 * `execFile("xcrun", argv)` with no shell, so the same interpolation is a
 * correctness/mangling defect rather than an injection one.
 *
 * These tests assert the ARGV / COMMAND ACTUALLY ISSUED, not the log line or
 * the returned result — both of those looked correct before the fix, which is
 * exactly why this went unnoticed.
 */

const SIMULATOR_UDID = "ABCDEF01-1234-1234-1234-1234567890AB";
const ANDROID_DEVICE: BootedDevice = {
  name: "pixel",
  platform: "android",
  deviceId: "emulator-5554",
};
const iosSimulator: BootedDevice = { name: "iPhone", platform: "ios", deviceId: SIMULATOR_UDID };

/**
 * Hostile-but-legal URLs, each paired with the exact POSIX single-quoted form
 * the device shell must receive. The expected column is written out literally
 * rather than computed, so it cannot drift with the implementation.
 */
const hostileUrls: Array<[label: string, url: string, deviceShellQuoted: string]> = [
  // Control row: an ordinary URL must still be passed through unchanged.
  ["control (plain URL)", "https://example.com/x", "'https://example.com/x'"],
  ["embedded double quote", 'https://example.com/a"b', `'https://example.com/a"b'`],
  ["quote-break command injection", 'https://x/" ; id ; echo "', `'https://x/" ; id ; echo "'`],
  ["command substitution $()", "https://example.com/?q=$(id)", "'https://example.com/?q=$(id)'"],
  ["backtick substitution", "https://example.com/?q=`id`", "'https://example.com/?q=`id`'"],
  ["bare variable expansion", "https://example.com/?q=$HOME", "'https://example.com/?q=$HOME'"],
  ["semicolon", "https://example.com/a;id", "'https://example.com/a;id'"],
  ["logical and", "https://example.com/a&&id", "'https://example.com/a&&id'"],
  [
    "pipe and redirect",
    "https://example.com/a|id>/data/local/tmp/x",
    "'https://example.com/a|id>/data/local/tmp/x'",
  ],
  ["backslash", "https://example.com/a\\b", "'https://example.com/a\\b'"],
  ["inner space", "https://example.com/a b", "'https://example.com/a b'"],
  // A single quote is the one character single-quoting cannot contain, so it
  // must be closed, escaped, and reopened: ' -> '\''
  ["single quote", "https://example.com/it's", "'https://example.com/it'\\''s'"],
  ["unicode", "https://example.com/café/日本", "'https://example.com/café/日本'"],
  [
    "percent-encoding is preserved verbatim",
    "https://example.com/a%20b%22c",
    "'https://example.com/a%20b%22c'",
  ],
];

describe("openLink does not let a URL escape the Android device shell (issue #4213)", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) {
      restores.pop()!();
    }
  });

  // Run execute() without the observe/visual-change machinery: the platform
  // dispatch is the only part under test here.
  const stubObservedInteraction = () => {
    const spy = spyOn(BaseVisualChange.prototype, "observedInteraction").mockImplementation(
      async (block: any) => block({} as any),
    );
    restores.push(() => spy.mockRestore());
  };

  test.each(hostileUrls)("android argv: %s", async (_label, url, quoted) => {
    stubObservedInteraction();
    const fakeAdb = new FakeAdbExecutor();
    const openURL = new OpenURL(ANDROID_DEVICE, fakeAdb as unknown as any);

    const result = await openURL.execute(url);

    // The whole `am start …` line is ONE adb argument, and the URL inside it
    // is one shell word: nothing the caller supplied can become a new word.
    expect(fakeAdb.getExecutedArgv()).toEqual([
      ["shell", `am start -a android.intent.action.VIEW -d ${quoted}`],
    ]);
    expect(result).toEqual({ success: true, url });
  });

  test("the reproduced injection payload cannot terminate the -d argument", async () => {
    stubObservedInteraction();
    const fakeAdb = new FakeAdbExecutor();
    // Before the fix this produced:
    //   am start -a android.intent.action.VIEW -d "https://x/" ; id ; echo ""
    // i.e. a second shell command (`id`) executed on the device.
    const payload = 'https://x/" ; id ; echo "';

    await new OpenURL(ANDROID_DEVICE, fakeAdb as unknown as any).execute(payload);

    const [argv] = fakeAdb.getExecutedArgv();
    const shellCommand = argv[1];
    // No unquoted metacharacter survives: the URL is wholly inside one
    // single-quoted word that starts right after `-d `.
    expect(shellCommand).toBe(
      `am start -a android.intent.action.VIEW -d 'https://x/" ; id ; echo "'`,
    );
    expect(shellCommand.startsWith("am start -a android.intent.action.VIEW -d '")).toBe(true);
    expect(shellCommand.endsWith("'")).toBe(true);
    // Exactly two single quotes -> exactly one quoted word, nothing after it.
    expect(shellCommand.split("'")).toHaveLength(3);
  });
});

describe("openLink passes the URL to simctl as its own argv element (issue #4213)", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) {
      restores.pop()!();
    }
  });

  const stubObservedInteraction = () => {
    const spy = spyOn(BaseVisualChange.prototype, "observedInteraction").mockImplementation(
      async (block: any) => block({} as any),
    );
    restores.push(() => spy.mockRestore());
  };

  test.each(hostileUrls)("ios simulator argv: %s", async (_label, url) => {
    stubObservedInteraction();
    const simctl = new FakeSimCtlClient();
    const openURL = new OpenURL(
      iosSimulator,
      new FakeAdbExecutor() as unknown as any,
      simctl as any,
      new FakeDeviceUrlLauncher() as any,
    );

    const result = await openURL.execute(url);

    // `executeCommand` re-splits its string back into argv; `executeCommandArgs`
    // hands argv straight to execFile, so the URL arrives byte-for-byte.
    expect(simctl.getMethodCalls("executeCommand")).toHaveLength(0);
    const calls = simctl.getMethodCalls("executeCommandArgs");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["openurl", SIMULATOR_UDID, url]);
    expect(result).toEqual({ success: true, url });
  });
});
