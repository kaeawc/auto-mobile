import { beforeEach, describe, expect, it } from "bun:test";
import { SystemConfigurationManager } from "../../../src/features/utility/SystemConfigurationManager";
import {
  timeZoneIdsEquivalent,
  validateTimeZoneId,
} from "../../../src/features/utility/system-configuration/parsing";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeProcessExecutor } from "../../fakes/FakeProcessExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice, ExecResult } from "../../../src/models";

/**
 * Issue #10190: `changeLocalization { timeZone }` used to store any string on the
 * device and verify it by reading the same stored string back. An id that is not
 * a time zone is now refused before anything is sent, and the read-back follows
 * the locale path's three outcomes (applied, not applied -> restore, unreadable
 * -> indeterminate, no restore).
 */
const ANDROID: BootedDevice = { deviceId: "emulator-5554", name: "Pixel 7", platform: "android" };
const IOS: BootedDevice = {
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  name: "iPhone 15 Pro",
  platform: "ios",
};

const INVALID_IDS: ReadonlyArray<readonly [id: string, reasonFragment: string]> = [
  ["America/Los Angeles", "not an IANA time zone id"],
  ["Pacific/Los_Angeles", "not an IANA time zone id"],
  ["PST8", "not an IANA time zone id"],
  ["PST", "not an IANA time zone id"],
  ["GMT+5", "not an IANA time zone id"],
  ["UTC+5", "not an IANA time zone id"],
  ["Etc/GMT+15", "not an IANA time zone id"],
  ["Z", "not an IANA time zone id"],
  ["Not/AZone", "not an IANA time zone id"],
  ["+05:00", "bare UTC offset"],
  ["+0500", "bare UTC offset"],
  ["-08:00", "bare UTC offset"],
  ["america/los_angeles", 'did you mean "America/Los_Angeles"'],
  ["utc", 'did you mean "UTC"'],
  ["America/los_angeles", 'did you mean "America/Los_Angeles"'],
];

const VALID_IDS: readonly string[] = [
  "America/Los_Angeles",
  "Asia/Kolkata",
  "Europe/Kyiv",
  "Pacific/Kanton",
  "America/Port-au-Prince",
  // Fixed-offset tzdata zones: the sign is inverted, Etc/GMT+5 is UTC-5.
  "UTC",
  "GMT",
  "Etc/UTC",
  "Etc/GMT+5",
  "Etc/GMT-14",
  // tzdata rule zones.
  "EST5EDT",
  "PST8PDT",
  // Legacy aliases: absent from Intl.supportedValuesOf, still resolved by devices.
  "US/Pacific",
  "Asia/Calcutta",
  "Europe/Kiev",
  "Asia/Saigon",
];

describe("validateTimeZoneId (#10190)", () => {
  for (const [id, reason] of INVALID_IDS) {
    it(`rejects ${JSON.stringify(id)} and names it`, () => {
      const error = validateTimeZoneId(id);
      expect(error).toContain(`Invalid time zone "${id}"`);
      expect(error).toContain(reason);
    });
  }

  for (const id of VALID_IDS) {
    it(`accepts ${JSON.stringify(id)}`, () => {
      expect(validateTimeZoneId(id)).toBeNull();
    });
  }

  it("accepts a sample of the runtime's canonical ids", () => {
    const canonical = Intl.supportedValuesOf("timeZone");
    for (let index = 0; index < canonical.length; index += 40) {
      expect(validateTimeZoneId(canonical[index])).toBeNull();
    }
  });

  it("points a UTC-offset request at the inverted-sign fixed-offset zone", () => {
    expect(validateTimeZoneId("+05:00")).toContain('"Etc/GMT-5"');
  });
});

describe("timeZoneIdsEquivalent (#10190)", () => {
  const cases: ReadonlyArray<readonly [actual: string | null, requested: string, equal: boolean]> =
    [
      ["Asia/Tokyo", "Asia/Tokyo", true],
      ["US/Pacific", "US/Pacific", true],
      ["Asia/Calcutta", "Asia/Calcutta", true],
      ["Etc/GMT+5", "Etc/GMT+5", true],
      ["America/New_York", "Asia/Tokyo", false],
      ["Etc/GMT+5", "Etc/GMT-5", false],
      // A case variant is not a zone the device resolves.
      ["asia/tokyo", "Asia/Tokyo", false],
      ["GMT", "Asia/Tokyo", false],
      [null, "Asia/Tokyo", false],
      ["", "Asia/Tokyo", false],
      ["Not/AZone", "Asia/Tokyo", false],
    ];
  for (const [actual, requested, equal] of cases) {
    it(`${JSON.stringify(actual)} vs ${JSON.stringify(requested)} is ${equal}`, () => {
      expect(timeZoneIdsEquivalent(actual, requested)).toBe(equal);
    });
  }
});

describe("Android changeLocalization time zone (#10190)", () => {
  const GET = "shell getprop persist.sys.timezone";
  let adb: FakeAdbClient;
  let manager: SystemConfigurationManager;

  beforeEach(() => {
    adb = new FakeAdbClient();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    manager = new SystemConfigurationManager(
      ANDROID,
      new FakeAdbClientFactory(adb),
      new FakeProcessExecutor(),
      timer,
    );
  });

  const setprops = (): string[] => adb.getAllCommands().filter((c) => c.includes("setprop"));

  for (const [id] of INVALID_IDS) {
    it(`refuses ${JSON.stringify(id)} without issuing any command`, async () => {
      const result = await manager.setTimeZone(id);

      expect(result.success).toBe(false);
      expect(result.error).toContain(`Invalid time zone "${id}"`);
      // Exact absence: not even the previous-zone read happens.
      expect(adb.getAllCommands()).toEqual([]);
    });
  }

  for (const id of ["US/Pacific", "Asia/Calcutta", "EST5EDT", "Etc/GMT+5", "UTC"]) {
    it(`sends the legacy or fixed-offset id ${id} and matches it on read-back`, async () => {
      adb.setCommandResultSequence(GET, ["America/New_York", id]);

      const result = await manager.setTimeZone(id);

      expect(result).toMatchObject({
        success: true,
        zoneId: id,
        previousZoneId: "America/New_York",
        method: "setprop persist.sys.timezone",
      });
      expect(setprops()).toEqual([`shell setprop persist.sys.timezone '${id}'`]);
    });
  }

  it("marks a successful change as stored, not confirmed applied", async () => {
    adb.setCommandResultSequence(GET, ["America/New_York", "Asia/Tokyo"]);

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result.success).toBe(true);
    expect(result.warning).toContain("does not confirm the zone is in effect");
  });

  it("restores the previous zone when the new one does not read back", async () => {
    adb.setCommandResultSequence(GET, ["America/New_York", "UTC", "America/New_York"]);

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result.success).toBe(false);
    expect(result.warning).toBeUndefined();
    expect(result.error).toBe(
      'Read-back verification failed: expected "Asia/Tokyo" but got "UTC". Restored the previous time zone ("America/New_York").',
    );
    expect(setprops()).toEqual([
      "shell setprop persist.sys.timezone 'Asia/Tokyo'",
      "shell setprop persist.sys.timezone 'America/New_York'",
    ]);
  });

  it("treats a case-variant read-back as not applied", async () => {
    adb.setCommandResultSequence(GET, ["America/New_York", "asia/tokyo", "America/New_York"]);

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result.success).toBe(false);
    expect(result.error).toContain('got "asia/tokyo". Restored the previous time zone');
  });

  it("clears the prop when no zone was set before", async () => {
    adb.setCommandResultSequence(GET, ["", "UTC", ""]);

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result.error).toContain("Restored the previous time zone (unset).");
    expect(setprops()).toContain("shell setprop persist.sys.timezone ''");
  });

  it("names the value the device is left with when the restore fails", async () => {
    adb.setCommandResultSequence(GET, ["America/New_York", "UTC"]);
    adb.setCommandError("shell setprop persist.sys.timezone 'America/New_York'", new Error("busy"));

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      'Restoring the previous time zone ("America/New_York") failed (busy); persist.sys.timezone is left as "UTC".',
    );
  });

  it("does not restore when the device still holds the previous zone", async () => {
    adb.setCommandResultSequence(GET, ["America/New_York"]);

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result.error).toBe(
      'Read-back verification failed: expected "Asia/Tokyo" but got "America/New_York"',
    );
    expect(setprops()).toEqual(["shell setprop persist.sys.timezone 'Asia/Tokyo'"]);
  });

  it("does not restore when the read-back is unreadable (indeterminate)", async () => {
    adb.setCommandResultSequence(GET, ["America/New_York", ""]);

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Time zone change outcome is indeterminate");
    expect(result.error).toContain('"Asia/Tokyo" was sent');
    expect(result.error).toContain('previously "America/New_York"');
    expect(result.error).toContain("Do not retry automatically");
    expect(setprops()).toEqual(["shell setprop persist.sys.timezone 'Asia/Tokyo'"]);
  });

  it("does not restore when the setprop itself fails", async () => {
    adb.setCommandResultSequence(GET, ["America/New_York"]);
    adb.setCommandError("shell setprop persist.sys.timezone 'Asia/Tokyo'", new Error("denied"));

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result.error).toBe("Failed to set time zone: denied");
    expect(setprops()).toHaveLength(1);
  });
});

/**
 * Stateful stand-in for `xcrun simctl spawn <udid> defaults` on one simulator.
 * It answers `read`/`write`/`delete` from a key-value store so a restore is
 * observable as state, and can drop, fail or hide individual keys.
 */
class FakeSimulatorDefaults {
  readonly values = new Map<string, string>();
  readonly droppedWrites = new Set<string>();
  /** Writes whose rendered "<verb> <domain> <key> <args>" starts with the key throw. */
  readonly failingWrites = new Map<string, Error>();
  /** The next write to a key stores this value instead (the device changed it). */
  readonly rewrittenWrites = new Map<string, string>();
  readonly unreadableAfterWrite = new Set<string>();
  private readonly writtenKeys = new Set<string>();

  constructor(executor: FakeProcessExecutor) {
    executor.setCommandHandler("defaults ", (command) => this.handle(command));
  }

  private handle(command: string): ExecResult {
    const [verb, domain, key, ...args] = command.slice(command.indexOf("defaults ") + 9).split(" ");
    const id = `${domain} ${key}`;
    if (verb === "read") {
      const value = this.values.get(id);
      if (value === undefined || (this.unreadableAfterWrite.has(id) && this.writtenKeys.has(id))) {
        throw new Error(`The domain/default pair of (${domain}, ${key}) does not exist`);
      }
      return result(`${value}\n`);
    }
    const rendered = [verb, id, ...args].join(" ");
    for (const [prefix, failure] of this.failingWrites) {
      if (rendered.startsWith(prefix)) {
        throw failure;
      }
    }
    this.writtenKeys.add(id);
    const rewritten = this.rewrittenWrites.get(id);
    if (rewritten !== undefined) {
      this.rewrittenWrites.delete(id);
      this.values.set(id, rewritten);
      return result("");
    }
    if (this.droppedWrites.has(id)) {
      return result("");
    }
    if (verb === "delete") {
      this.values.delete(id);
    } else if (args[0] === "-bool") {
      this.values.set(id, args[1] === "YES" ? "1" : "0");
    } else {
      this.values.set(id, args.join(" "));
    }
    return result("");
  }
}

function result(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

describe("iOS simulator changeLocalization time zone (#10190)", () => {
  const ZONE = ".GlobalPreferences AppleTimeZone";
  const AUTO = "com.apple.mobiletimerd AutomaticTimeZoneSetting";
  const writeCmd = (id: string, ...args: string[]): string =>
    `xcrun simctl spawn ${IOS.deviceId} defaults write ${id} ${args.join(" ")}`;
  const deleteCmd = (id: string): string =>
    `xcrun simctl spawn ${IOS.deviceId} defaults delete ${id}`;

  let executor: FakeProcessExecutor;
  let defaults: FakeSimulatorDefaults;
  let manager: SystemConfigurationManager;

  beforeEach(() => {
    executor = new FakeProcessExecutor();
    defaults = new FakeSimulatorDefaults(executor);
    defaults.values.set(ZONE, "America/New_York");
    defaults.values.set(AUTO, "1");
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    manager = new SystemConfigurationManager(
      IOS,
      new FakeAdbClientFactory(new FakeAdbClient()),
      executor,
      timer,
    );
  });

  const mutations = (): string[] =>
    executor.getExecutedCommands().filter((c) => /defaults (write|delete)/.test(c));

  for (const [id] of INVALID_IDS) {
    it(`refuses ${JSON.stringify(id)} without issuing any command`, async () => {
      const result = await manager.setTimeZone(id);

      expect(result.success).toBe(false);
      expect(result.error).toContain(`Invalid time zone "${id}"`);
      expect(executor.getExecutedCommands()).toEqual([]);
      expect(defaults.values.get(AUTO)).toBe("1");
    });
  }

  it("accepts a legacy alias, matches it on read-back and leaves automatic time zone off", async () => {
    const result = await manager.setTimeZone("US/Pacific");

    expect(result).toMatchObject({
      success: true,
      zoneId: "US/Pacific",
      previousZoneId: "America/New_York",
    });
    expect(result.warning).toContain("does not confirm that running apps observe the new zone");
    expect(mutations()).toEqual([writeCmd(AUTO, "-bool", "NO"), writeCmd(ZONE, "US/Pacific")]);
    // The existing design: the manual zone is pinned by switching automatic off.
    expect(defaults.values.get(AUTO)).toBe("0");
  });

  it("restores automatic time zone and the previous zone when the read-back differs", async () => {
    defaults.droppedWrites.add(ZONE);
    defaults.values.set(ZONE, "America/New_York");

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result.success).toBe(false);
    expect(result.warning).toBeUndefined();
    expect(result.error).toBe(
      'Read-back verification failed: expected "Asia/Tokyo" but got "America/New_York". Restored automatic time zone ("1") and the previous time zone ("America/New_York").',
    );
    expect(defaults.values.get(AUTO)).toBe("1");
    expect(mutations()).toContain(writeCmd(AUTO, "-bool", "YES"));
  });

  it("puts the previous zone back when the device applied a different zone", async () => {
    defaults.rewrittenWrites.set(ZONE, "Europe/Paris");

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Read-back verification failed: expected "Asia/Tokyo" but got "Europe/Paris". Restored automatic time zone ("1") and the previous time zone ("America/New_York").',
    );
    expect(defaults.values.get(ZONE)).toBe("America/New_York");
    expect(defaults.values.get(AUTO)).toBe("1");
    expect(mutations()).toEqual([
      writeCmd(AUTO, "-bool", "NO"),
      writeCmd(ZONE, "Asia/Tokyo"),
      writeCmd(ZONE, "America/New_York"),
      writeCmd(AUTO, "-bool", "YES"),
    ]);
  });

  it("deletes the automatic switch again when it was never set", async () => {
    defaults.values.delete(AUTO);
    defaults.droppedWrites.add(ZONE);

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Restored automatic time zone (unset)");
    expect(defaults.values.has(AUTO)).toBe(false);
    expect(mutations()).toContain(deleteCmd(AUTO));
  });

  it("restores automatic time zone when the AppleTimeZone write throws", async () => {
    defaults.failingWrites.set(`write ${ZONE} Asia/Tokyo`, new Error("defaults write failed"));

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Failed to set time zone: defaults write failed. Restored automatic time zone ("1") and the previous time zone ("America/New_York").',
    );
    expect(defaults.values.get(AUTO)).toBe("1");
    expect(defaults.values.get(ZONE)).toBe("America/New_York");
  });

  it("changes nothing when the automatic switch write itself fails", async () => {
    defaults.failingWrites.set(`write ${AUTO}`, new Error("defaults write failed"));

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result).toEqual({
      success: false,
      zoneId: "Asia/Tokyo",
      error: "Failed to set time zone: defaults write failed",
    });
    // Only the failed attempt: no zone write and no restore.
    expect(mutations()).toEqual([writeCmd(AUTO, "-bool", "NO")]);
    expect(defaults.values.get(AUTO)).toBe("1");
  });

  it("does not restore anything when the read-back is unreadable (indeterminate)", async () => {
    defaults.unreadableAfterWrite.add(ZONE);

    const result = await manager.setTimeZone("Asia/Tokyo");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Time zone change outcome is indeterminate");
    expect(result.error).toContain("automatic time zone is off");
    expect(result.error).toContain('previously "America/New_York"');
    expect(mutations()).toEqual([writeCmd(AUTO, "-bool", "NO"), writeCmd(ZONE, "Asia/Tokyo")]);
  });

  it("names what is left behind when the restore fails", async () => {
    defaults.droppedWrites.add(ZONE);
    defaults.failingWrites.set(`write ${AUTO} -bool YES`, new Error("locked"));

    const outcome = await manager.setTimeZone("Asia/Tokyo");

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain(
      'Restoring the previous automatic time zone ("1") and time zone ("America/New_York") failed: AutomaticTimeZoneSetting: locked; AutomaticTimeZoneSetting is left as "0".',
    );
  });
});
