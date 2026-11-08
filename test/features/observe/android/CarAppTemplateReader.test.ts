import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult, ObserveResult } from "../../../../src/models";
import type { ForegroundApp } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  CAR_APP_ROUTE_ABSENT_TTL_MS,
  CAR_APP_ROUTE_DISABLED_TTL_MS,
  CAR_APP_ROUTE_FAILED_RETRY_MS,
  CarAppTemplateReader,
  parseCarAppTemplateCallOutput,
  type CarAppAdb,
} from "../../../../src/features/observe/android/CarAppTemplateReader";
import { CAR_APP_TEMPLATES_NOTE } from "../../../../src/models/CarAppTemplates";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeTimer } from "../../../fakes/FakeTimer";

const android: BootedDevice = { deviceId: "emulator-5554", name: "AAOS", platform: "android" };

const enabledDocument = {
  schemaVersion: 1,
  enabled: true,
  sessions: [
    {
      id: "session0",
      screens: [
        {
          id: "session0/screen0",
          screenClass: "com.example.car.HomeScreen",
          top: true,
          template: {
            id: "session0/screen0/template",
            type: "ListTemplate",
            title: "Home",
            headerActions: [],
            items: [
              {
                id: "session0/screen0/template/items/0",
                kind: "row",
                title: "Wi-Fi",
                texts: ["Connected"],
                hasImage: false,
                toggle: true,
                browsable: false,
                enabled: true,
                actions: [],
              },
            ],
            actions: [],
            actionStrips: [],
            tabs: [],
          },
        },
      ],
    },
  ],
};

function bundle(document: unknown): string {
  return `Result: Bundle[{result=${JSON.stringify(document)}}]`;
}

class FakeCarAppAdb implements CarAppAdb {
  readonly commands: string[] = [];
  foregroundLookups = 0;
  /** What `getForegroundApp` answers; an Error rejects. */
  foreground: ForegroundApp | null | Error = { packageName: "com.example.car", userId: 0 };
  /** When set, `content call` waits on it, so tests can overlap reads. */
  gate: Promise<void> | undefined;
  constructor(private reply: () => string) {}
  setReply(reply: () => string): void {
    this.reply = reply;
  }
  async executeCommand(command: string): Promise<ExecResult> {
    this.commands.push(command);
    await this.gate;
    return createExecResult(this.reply(), "");
  }
  async getForegroundApp(): Promise<ForegroundApp | null> {
    this.foregroundLookups += 1;
    if (this.foreground instanceof Error) {
      throw this.foreground;
    }
    return this.foreground;
  }
}

function observation(appId: string | undefined, userId?: number): ObserveResult {
  return {
    updatedAt: 1,
    observationId: "car",
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    screenSize: { width: 1, height: 1 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    ...(appId ? { activeWindow: { appId, activityName: "a", layoutSeqSum: 0 } } : {}),
    ...(userId === undefined ? {} : { userId }),
  };
}

function setup(reply: () => string) {
  const adb = new FakeCarAppAdb(reply);
  const timer = new FakeTimer();
  const reader = new CarAppTemplateReader(() => adb, timer);
  return { adb, timer, reader };
}

describe("CarAppTemplateReader (#16751)", () => {
  test("an enabled route becomes the observe block with the not-host-rendered note", async () => {
    const { adb, reader } = setup(() => bundle(enabledDocument));

    const block = await reader.resolve(android, observation("com.example.car"));

    expect(block).toEqual({
      packageName: "com.example.car",
      source: "sdk",
      note: CAR_APP_TEMPLATES_NOTE,
      sessions: enabledDocument.sessions,
    });
    expect(adb.commands).toEqual([
      "shell content call --user 0 --uri 'content://com.example.car.automobile.carapptemplates' --method snapshot",
    ]);
  });

  test("addresses an Android user the observation already carries without a lookup", async () => {
    const { adb, reader } = setup(() => bundle(enabledDocument));
    await reader.resolve(android, observation("com.example.car", 10));
    expect(adb.commands[0]).toContain("content call --user 10 --uri");
    expect(adb.foregroundLookups).toBe(0);
  });

  test("reads the foreground app's Android user for a work-profile car app", async () => {
    const { adb, reader } = setup(() => bundle(enabledDocument));
    adb.foreground = { packageName: "com.example.car", userId: 10 };
    expect(await reader.resolve(android, observation("com.example.car"))).toBeDefined();
    expect(adb.commands).toEqual([
      "shell content call --user 10 --uri 'content://com.example.car.automobile.carapptemplates' --method snapshot",
    ]);
  });

  test("skips the read when the foreground lookup names another app or fails", async () => {
    const { adb, timer, reader } = setup(() => bundle(enabledDocument));
    for (const foreground of [
      { packageName: "com.example.other", userId: 10 },
      null,
      new Error("dumpsys failed"),
    ]) {
      adb.foreground = foreground;
      expect(await reader.resolve(android, observation("com.example.car"))).toBeUndefined();
      timer.advanceTime(CAR_APP_ROUTE_FAILED_RETRY_MS);
    }
    expect(adb.foregroundLookups).toBe(3);
    expect(adb.commands).toEqual([]);

    adb.foreground = { packageName: "com.example.car", userId: 0 };
    expect(await reader.resolve(android, observation("com.example.car"))).toBeDefined();
  });

  test("the quiet TTL is per Android user", async () => {
    const { adb, reader } = setup(() => bundle({ schemaVersion: 1, enabled: false, sessions: [] }));
    await reader.resolve(android, observation("com.example.car", 0));
    await reader.resolve(android, observation("com.example.car", 10));
    expect(adb.commands).toHaveLength(2);
    expect(adb.commands[1]).toContain("--user 10");
  });

  test("a quiet app makes no foreground lookup until its TTL passes", async () => {
    const { adb, timer, reader } = setup(() => {
      throw new Error("Could not find provider");
    });
    await reader.resolve(android, observation("com.example.car"));
    await reader.resolve(android, observation("com.example.car"));
    expect(adb.foregroundLookups).toBe(1);
    expect(adb.commands).toHaveLength(1);

    timer.advanceTime(CAR_APP_ROUTE_ABSENT_TTL_MS);
    await reader.resolve(android, observation("com.example.car"));
    expect(adb.foregroundLookups).toBe(2);
    expect(adb.commands).toHaveLength(2);
  });

  test("a failed foreground lookup is retried after the failure interval", async () => {
    const { adb, timer, reader } = setup(() => bundle(enabledDocument));
    adb.foreground = new Error("no devices");
    await reader.resolve(android, observation("com.example.car"));
    timer.advanceTime(CAR_APP_ROUTE_FAILED_RETRY_MS - 1);
    await reader.resolve(android, observation("com.example.car"));
    expect(adb.foregroundLookups).toBe(1);

    adb.foreground = { packageName: "com.example.car", userId: 0 };
    timer.advanceTime(1);
    expect(await reader.resolve(android, observation("com.example.car"))).toBeDefined();
    expect(adb.foregroundLookups).toBe(2);
  });

  test("a failed read is retried after the short failure interval, not the absent TTL", async () => {
    const { adb, timer, reader } = setup(() => {
      throw new Error("adb: device offline");
    });

    expect(await reader.resolve(android, observation("com.example.car"))).toBeUndefined();
    timer.advanceTime(CAR_APP_ROUTE_FAILED_RETRY_MS - 1);
    await reader.resolve(android, observation("com.example.car"));
    expect(adb.commands).toHaveLength(1);

    adb.setReply(() => bundle(enabledDocument));
    timer.advanceTime(1);
    expect(await reader.resolve(android, observation("com.example.car"))).toBeDefined();
    expect(adb.commands).toHaveLength(2);
  });

  test("a payload that fails schema validation is retried after the failure interval", async () => {
    const { adb, timer, reader } = setup(() => bundle({ enabled: true }));
    expect(await reader.resolve(android, observation("com.example.car"))).toBeUndefined();
    timer.advanceTime(CAR_APP_ROUTE_FAILED_RETRY_MS);
    await reader.resolve(android, observation("com.example.car"));
    expect(adb.commands).toHaveLength(2);
  });

  test("a missing provider in the command output counts as no route", async () => {
    const { adb, timer, reader } = setup(
      () =>
        "Error while accessing provider:com.example.car.automobile.carapptemplates\n" +
        "java.lang.IllegalArgumentException: Unknown authority",
    );
    await reader.resolve(android, observation("com.example.car"));
    timer.advanceTime(CAR_APP_ROUTE_FAILED_RETRY_MS);
    await reader.resolve(android, observation("com.example.car"));
    expect(adb.commands).toHaveLength(1);
  });

  test("overlapping observations of one app share a single read", async () => {
    const { adb, reader } = setup(() => bundle(enabledDocument));
    let release: () => void = () => {};
    adb.gate = new Promise((resolve) => {
      release = resolve;
    });
    const reads = Promise.all([
      reader.resolve(android, observation("com.example.car")),
      reader.resolve(android, observation("com.example.car")),
    ]);
    release();
    const [first, second] = await reads;
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(adb.commands).toHaveLength(1);
    expect(adb.foregroundLookups).toBe(1);

    adb.gate = undefined;
    await reader.resolve(android, observation("com.example.car"));
    expect(adb.commands).toHaveLength(2);
  });

  test("expired quiet entries are pruned", async () => {
    const { adb, timer, reader } = setup(() => {
      throw new Error("Could not find provider");
    });
    adb.foreground = { packageName: "com.example.a", userId: 0 };
    await reader.resolve(android, observation("com.example.a"));
    timer.advanceTime(CAR_APP_ROUTE_ABSENT_TTL_MS);
    adb.foreground = { packageName: "com.example.b", userId: 0 };
    await reader.resolve(android, observation("com.example.b"));
    expect(reader.quietEntryCount).toBe(2);
  });

  test("a route error is carried on the block", async () => {
    const { reader } = setup(() =>
      bundle({ schemaVersion: 1, enabled: true, sessions: [], error: "main_thread_timeout" }),
    );
    const block = await reader.resolve(android, observation("com.example.car"));
    expect(block?.error).toBe("main_thread_timeout");
    expect(block?.sessions).toEqual([]);
  });

  test("an app without the route is not asked again until the absent TTL passes", async () => {
    const { adb, timer, reader } = setup(() => {
      throw new Error("Could not find provider: com.example.car.automobile.carapptemplates");
    });

    expect(await reader.resolve(android, observation("com.example.car"))).toBeUndefined();
    timer.advanceTime(CAR_APP_ROUTE_ABSENT_TTL_MS - 1);
    expect(await reader.resolve(android, observation("com.example.car"))).toBeUndefined();
    expect(adb.commands).toHaveLength(1);

    adb.setReply(() => bundle(enabledDocument));
    timer.advanceTime(1);
    expect(await reader.resolve(android, observation("com.example.car"))).toBeDefined();
    expect(adb.commands).toHaveLength(2);
  });

  test("a disabled route is rechecked after the shorter disabled TTL", async () => {
    const { adb, timer, reader } = setup(() =>
      bundle({ schemaVersion: 1, enabled: false, sessions: [] }),
    );

    expect(await reader.resolve(android, observation("com.example.car"))).toBeUndefined();
    timer.advanceTime(CAR_APP_ROUTE_DISABLED_TTL_MS - 1);
    await reader.resolve(android, observation("com.example.car"));
    expect(adb.commands).toHaveLength(1);

    timer.advanceTime(1);
    await reader.resolve(android, observation("com.example.car"));
    expect(adb.commands).toHaveLength(2);
  });

  test("an enabled route is asked on every observation", async () => {
    const { adb, reader } = setup(() => bundle(enabledDocument));
    await reader.resolve(android, observation("com.example.car"));
    await reader.resolve(android, observation("com.example.car"));
    expect(adb.commands).toHaveLength(2);
  });

  test("malformed output yields no block", async () => {
    for (const reply of [
      "Result: null",
      "Result: Bundle[{result={not json}}]",
      bundle({ enabled: true }),
    ]) {
      const { reader } = setup(() => reply);
      expect(await reader.resolve(android, observation("com.example.car"))).toBeUndefined();
    }
  });

  test("iOS, a missing foreground app and an unsafe package name make no call", async () => {
    const { adb, reader } = setup(() => bundle(enabledDocument));
    await reader.resolve({ ...android, platform: "ios" }, observation("com.example.car"));
    await reader.resolve(android, observation(undefined));
    await reader.resolve(android, observation("com.example; reboot"));
    expect(adb.commands).toEqual([]);
  });

  test("parses the bundle value up to its closing delimiter", () => {
    expect(parseCarAppTemplateCallOutput('Result: Bundle[{result={"a":"}]"}}]')).toEqual({
      a: "}]",
    });
    expect(parseCarAppTemplateCallOutput("Error: nothing")).toBeUndefined();
  });
});
