import { describe, expect, test } from "bun:test";
import {
  captureIosSettings,
  restoreIosSettings,
  IOS_SETTINGS_KEYS,
} from "../../../src/utils/ios-cmdline-tools/iosSettings";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

const UDID = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";

describe("iosSettings", () => {
  test("allowlist is scalar-only for the first cut (no array-typed keys)", () => {
    expect(IOS_SETTINGS_KEYS.map(k => k.key)).toEqual(["AppleLocale"]);
  });

  test("captureIosSettings reads allowlisted keys + UI state", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      `spawn "${UDID}" defaults read ".GlobalPreferences" "AppleLocale"`,
      "nl_BE\n"
    );
    simctl.setCommandResult(`ui "${UDID}" appearance`, "dark\n");
    simctl.setCommandResult(`ui "${UDID}" content_size`, "large\n");

    const snapshot = await captureIosSettings(simctl as any, UDID);

    expect(snapshot.values).toEqual({ ".GlobalPreferences/AppleLocale": "nl_BE" });
    expect(snapshot.ui).toEqual({ appearance: "dark", contentSize: "large" });
  });

  test("captureIosSettings skips unset keys (defaults read non-zero) without throwing", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandError(
      `spawn "${UDID}" defaults read ".GlobalPreferences" "AppleLocale"`,
      new Error("does not exist")
    );
    // appearance/content_size return "" by default → ui undefined

    const snapshot = await captureIosSettings(simctl as any, UDID);
    expect(snapshot.values).toEqual({});
    expect(snapshot.ui).toBeUndefined();
  });

  test("restoreIosSettings replays per-key defaults write + ui commands", async () => {
    const simctl = new FakeSimCtlClient();
    await restoreIosSettings(simctl as any, UDID, {
      values: { ".GlobalPreferences/AppleLocale": "nl_BE" },
      ui: { appearance: "dark", contentSize: "large" },
    });

    const commands = simctl.getMethodCalls("executeCommand").map(c => String(c.command));
    expect(commands).toEqual([
      `spawn "${UDID}" defaults write ".GlobalPreferences" "AppleLocale" "nl_BE"`,
      `ui "${UDID}" appearance dark`,
      `ui "${UDID}" content_size "large"`,
    ]);
  });

  test("capture -> restore round-trips the locale value", async () => {
    const capSim = new FakeSimCtlClient();
    capSim.setCommandResult(
      `spawn "${UDID}" defaults read ".GlobalPreferences" "AppleLocale"`,
      "en_US"
    );
    const snapshot = await captureIosSettings(capSim as any, UDID);

    const restoreSim = new FakeSimCtlClient();
    await restoreIosSettings(restoreSim as any, UDID, snapshot);

    const commands = restoreSim.getMethodCalls("executeCommand").map(c => String(c.command));
    expect(commands).toContain(
      `spawn "${UDID}" defaults write ".GlobalPreferences" "AppleLocale" "en_US"`
    );
  });

  test("restoreIosSettings is non-fatal when a single key write fails", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandError(
      `spawn "${UDID}" defaults write ".GlobalPreferences" "AppleLocale" "nl_BE"`,
      new Error("boom")
    );

    await restoreIosSettings(simctl as any, UDID, {
      values: { ".GlobalPreferences/AppleLocale": "nl_BE" },
      ui: { appearance: "light" },
    });

    const commands = simctl.getMethodCalls("executeCommand").map(c => String(c.command));
    // UI restore still ran after the failed write.
    expect(commands).toContain(`ui "${UDID}" appearance light`);
  });
});
