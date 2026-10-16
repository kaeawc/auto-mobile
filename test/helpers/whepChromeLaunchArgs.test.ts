import { describe, expect, test } from "bun:test";
import { buildWhepChromeLaunchArgs, stripChromeUpdaterNoise } from "./whepChromeLaunchArgs";

describe("buildWhepChromeLaunchArgs", () => {
  test("hardens fresh-profile Chrome while retaining the reader flags and final blank page", () => {
    const args = buildWhepChromeLaunchArgs({
      debugPort: 9222,
      userDataDir: "/tmp/fresh Chrome profile",
    });

    expect(args).toEqual([
      "--headless=new",
      "--no-proxy-server",
      "--autoplay-policy=no-user-gesture-required",
      "--remote-debugging-port=9222",
      "--no-first-run",
      "--use-mock-keychain",
      "--password-store=basic",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--user-data-dir=/tmp/fresh Chrome profile",
      "about:blank",
    ]);
    expect(new Set(args).size).toBe(args.length);
  });

  test("uses each launch's port and profile without sharing a mutable argument list", () => {
    const first = buildWhepChromeLaunchArgs({ debugPort: 9222, userDataDir: "/tmp/first" });
    first.pop();
    const retry = buildWhepChromeLaunchArgs({ debugPort: 9333, userDataDir: "/tmp/retry" });

    expect(retry).toContain("--remote-debugging-port=9333");
    expect(retry).toContain("--user-data-dir=/tmp/retry");
    expect(retry).not.toContain("--remote-debugging-port=9222");
    expect(retry).not.toContain("--user-data-dir=/tmp/first");
    expect(retry.at(-1)).toBe("about:blank");
  });
});

describe("stripChromeUpdaterNoise", () => {
  const updaterLines = [
    "[INFO:chrome/updater/app/app.cc:101] updater started",
    "[INFO:components/update_client/update_client.cc:200] checking updates",
    "UpdaterMain (--install)",
    "UpdaterMain (--wake)",
    "UpdaterMain (--crash-handler)",
    '{"response":{"server":"prod","protocol":"3.1"}}',
    "[INFO] Omaha response received: update check completed",
  ];

  test.each(updaterLines)("drops updater chatter: %s", (line) => {
    expect(stripChromeUpdaterNoise(line)).toBe("");
  });

  test("preserves Chrome diagnostics in order even before more than 1500 chars of updater noise", () => {
    const chromeLines = [
      "DevTools listening on ws://127.0.0.1:9222/devtools/browser/example",
      "[ERROR:net/socket/ssl_client_socket_impl.cc] handshake failed",
      "[ERROR:content/browser/renderer_host/render_process_host_impl.cc] renderer stalled",
    ];
    const log = [
      chromeLines[0],
      ...updaterLines,
      chromeLines[1],
      chromeLines[2],
      ...Array<string>(40).fill(updaterLines[0]),
    ].join("\n");

    expect(stripChromeUpdaterNoise(log)).toBe(chromeLines.join("\n"));
  });

  test("removes an updater-only log including its trailing newline", () => {
    expect(stripChromeUpdaterNoise(`${updaterLines.join("\n")}\n`)).toBe("");
  });

  test("handles CRLF logs", () => {
    expect(stripChromeUpdaterNoise(`first\r\n${updaterLines[0]}\r\nlast`)).toBe("first\nlast");
  });

  test("keeps unrelated log lines and blank lines unchanged", () => {
    const log = "Chrome startup\n\ncomponent renderer ready\n";
    expect(stripChromeUpdaterNoise(log)).toBe(log);
  });

  test("returns an empty string for an empty log", () => {
    expect(stripChromeUpdaterNoise("")).toBe("");
  });
});
