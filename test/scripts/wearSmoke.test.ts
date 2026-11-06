import { describe, expect, test } from "bun:test";
import {
  assertRoundObservation,
  assertWatchDevice,
  buildWearSmokePlan,
  expectNoText,
  expectText,
  WEAR_FIXTURE,
  WEAR_SMOKE_TITLE,
  wearSmokeNotes,
  wearSmokeOptionsFromEnv,
} from "../../scripts/ci/wear-smoke/wearSmoke";
import {
  renderSmokeSummary,
  runSmoke,
  type Payload,
  type SmokeDeps,
} from "../../scripts/ci/emulator-smoke/smokeRunner";
import type { DriveClient } from "../../scripts/mcp-drive";

function envelope(payload: Payload, isError = false): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

const APP = WEAR_FIXTURE.appId;

function screen(appId: string, ...labels: string[]): Payload {
  return {
    skeleton: [
      { elementId: "e1", label: labels[0] ?? "Watch face" },
      ...labels.slice(1).map((label, i) => ({ elementId: `e${i + 2}`, label })),
    ],
    activeWindow: { appId },
    isScreenRound: true,
    screenSize: { width: 384, height: 384 },
  };
}

/** The observe replies a healthy fixture run produces, in plan order. */
function fixtureObserves(): Payload[] {
  return [
    screen("com.google.android.wearable.sysui"),
    screen(APP, "Item 1"),
    screen(APP, WEAR_FIXTURE.detailText),
    screen(APP, WEAR_FIXTURE.listRowText),
    screen(APP, WEAR_FIXTURE.pickerInitialText),
    screen(APP, "Level 3"),
    screen("com.google.android.wearable.sysui"),
    screen(APP, WEAR_FIXTURE.notificationActionStatus),
  ];
}

class FakeClient implements DriveClient {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  closed = false;
  constructor(
    private readonly replies: Record<string, unknown>,
    private readonly observes: Payload[],
  ) {}
  callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ tool, args });
    if (tool === "observe") {
      return Promise.resolve(envelope(this.observes.shift() ?? screen("none")));
    }
    return Promise.resolve(this.replies[tool] ?? envelope({ success: true, message: "ok" }));
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const START = envelope({
  success: true,
  formFactor: "watch",
  runtime: { session: { sessionUuid: "s-1" } },
});

function deps(client: DriveClient): SmokeDeps {
  return {
    client,
    outDir: "/out",
    writeFile: () => undefined,
    copyFile: () => true,
    now: () => 0,
    log: () => undefined,
  };
}

describe("buildWearSmokePlan", () => {
  test("boots the named AVD as a watch with rotaryScroll and ambient enabled", () => {
    const [start] = buildWearSmokePlan({ avdName: "wear-smoke" });
    expect(start.tool).toBe("startDevice");
    expect(start.args).toMatchObject({
      formFactor: "watch",
      avdName: "wear-smoke",
      enableTools: ["rotaryScroll", "ambient"],
    });
    expect(start.args.createIfMissing).toBeUndefined();
  });

  test("without an AVD name, startDevice creates the watch at the pinned version", () => {
    const [start] = buildWearSmokePlan({ osVersion: "17" });
    expect(start.args).toMatchObject({
      createIfMissing: true,
      minOsVersion: "17",
      maxOsVersion: "17",
    });
  });

  test("with the fixture covers install, list, tap, back, rotary, home and ambient", () => {
    const tools = buildWearSmokePlan({ fixtureApkPath: "/fixture.apk" }).map((step) => step.tool);
    for (const tool of [
      "installApp",
      "launchApp",
      "swipeOn",
      "tapOn",
      "pressButton",
      "rotaryScroll",
      "homeScreen",
      "ambient",
    ]) {
      expect(tools).toContain(tool);
    }
  });

  test("installs the fixture with its permissions granted, so posting needs no dialog", () => {
    const install = buildWearSmokePlan({ fixtureApkPath: "/f.apk" }).find(
      (step) => step.id === "install",
    );
    expect(install?.args).toMatchObject({ artifactPath: "/f.apk", grantAllPermissions: true });
  });

  test("scrolls back up to the picker row, which sits above the item list", () => {
    const scroll = buildWearSmokePlan({ fixtureApkPath: "/f.apk" }).find(
      (step) => step.id === "scroll-to-picker",
    );
    expect(scroll?.args).toMatchObject({
      direction: "down",
      lookFor: { text: WEAR_FIXTURE.pickerRowText },
    });
  });

  test("posts the notification, goes home, then finds it and taps its action", () => {
    const plan = buildWearSmokePlan({ fixtureApkPath: "/f.apk" });
    const ids = plan.map((step) => step.id);
    const order = [
      "post-notification",
      "home",
      "observe-home",
      "find-notification",
      "notification-action",
      "observe-notification-action",
      "ambient-enter",
    ].map((id) => ids.indexOf(id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).not.toContain(-1);
    const notification = { title: WEAR_FIXTURE.notificationTitle, appId: APP };
    expect(plan.find((step) => step.id === "find-notification")?.args).toMatchObject({
      action: "find",
      notification,
    });
    expect(plan.find((step) => step.id === "notification-action")?.args).toMatchObject({
      action: "tap",
      notification: { ...notification, tapActionLabel: WEAR_FIXTURE.notificationActionLabel },
    });
  });

  test("without the fixture runs only device-level steps and says so", () => {
    const plan = buildWearSmokePlan({});
    expect(plan.map((step) => step.tool)).not.toContain("installApp");
    expect(plan.map((step) => step.tool)).not.toContain("rotaryScroll");
    expect(plan.map((step) => step.tool)).not.toContain("systemTray");
    expect(wearSmokeNotes({})[0]).toContain("#16828");
    expect(wearSmokeNotes({ fixtureApkPath: "/fixture.apk" })).toEqual([]);
  });

  test("only ambient exit is marked to run after a failure", () => {
    const always = buildWearSmokePlan({ fixtureApkPath: "/f.apk" }).filter((step) => step.always);
    expect(always.map((step) => step.id)).toEqual(["ambient-exit"]);
  });
});

describe("assertions", () => {
  test("watch device", () => {
    expect(assertWatchDevice({ formFactor: "watch" })).toBeUndefined();
    expect(assertWatchDevice({ formFactor: "phone" })).toContain("reported phone");
  });

  test("round observation needs a hierarchy and isScreenRound true", () => {
    expect(assertRoundObservation(screen("x"))).toBeUndefined();
    expect(assertRoundObservation({ ...screen("x"), isScreenRound: false })).toContain(
      "observed false",
    );
    expect(assertRoundObservation({ isScreenRound: true })).toContain("no skeleton");
  });

  test("text checks require the fixture in the foreground", () => {
    expect(expectText(APP, "Hello")(screen(APP, "Hello"))).toBeUndefined();
    expect(expectText(APP, "Hello")(screen(APP, "Bye"))).toContain('"Hello" is not on screen');
    expect(expectText(APP, "Hello")(screen("other", "Hello"))).toContain("observed other");
    expect(expectNoText(APP, "Hello")(screen(APP, "Hello"))).toContain("still on screen");
    expect(expectNoText(APP, "Hello")(screen(APP, "Bye"))).toBeUndefined();
  });
});

describe("runSmoke with the Wear plan", () => {
  test("a healthy fixture run passes and threads the session", async () => {
    const client = new FakeClient({ startDevice: START }, fixtureObserves());
    const result = await runSmoke(
      buildWearSmokePlan({ fixtureApkPath: "/f.apk", avdName: "w" }),
      deps(client),
    );
    expect(result.steps.filter((step) => step.status !== "passed")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(client.calls[1].args.sessionUuid).toBe("s-1");
    expect(client.closed).toBe(true);
  });

  test("a broken fixture assertion fails readably and still wakes the watch", async () => {
    const client = new FakeClient({ startDevice: START }, fixtureObserves());
    const result = await runSmoke(
      buildWearSmokePlan({ fixtureApkPath: "/f.apk", avdName: "w", breakAssertion: true }),
      deps(client),
    );
    expect(result.ok).toBe(false);
    const failed = result.steps.find((step) => step.status === "failed");
    expect(failed?.id).toBe("observe-launched");
    expect(failed?.detail).toContain("com.example.deliberately.broken");
    expect(result.steps.at(-1)).toMatchObject({ id: "ambient-exit", status: "passed" });
    expect(result.steps.at(-2)).toMatchObject({ id: "ambient-enter", status: "skipped" });
    const summary = renderSmokeSummary(WEAR_SMOKE_TITLE, result);
    expect(summary).toContain("**Failed** at `observe-launched` (`observe`)");
  });

  test("a rotary scroll that does not move the picker fails the rotary step", async () => {
    const client = new FakeClient(
      {
        startDevice: START,
        rotaryScroll: envelope(
          { success: false, message: "Rotary scroll did not change the screen" },
          true,
        ),
      },
      fixtureObserves(),
    );
    const result = await runSmoke(
      buildWearSmokePlan({ fixtureApkPath: "/f.apk", avdName: "w" }),
      deps(client),
    );
    expect(result.steps.find((step) => step.status === "failed")?.id).toBe("rotary");
  });

  test("a notification action that leaves no status line fails the final observe", async () => {
    const observes = fixtureObserves();
    observes[observes.length - 1] = screen(APP, "Ready");
    const client = new FakeClient({ startDevice: START }, observes);
    const result = await runSmoke(
      buildWearSmokePlan({ fixtureApkPath: "/f.apk", avdName: "w" }),
      deps(client),
    );
    const failed = result.steps.find((step) => step.status === "failed");
    expect(failed?.id).toBe("observe-notification-action");
    expect(failed?.detail).toContain(`"${WEAR_FIXTURE.notificationActionStatus}" is not on screen`);
  });

  test("a systemTray failure stops the plan at the find step and still wakes the watch", async () => {
    const client = new FakeClient(
      {
        startDevice: START,
        systemTray: envelope(
          { success: false, message: "Could not open the watch notification stream" },
          true,
        ),
      },
      fixtureObserves(),
    );
    const result = await runSmoke(
      buildWearSmokePlan({ fixtureApkPath: "/f.apk", avdName: "w" }),
      deps(client),
    );
    expect(result.steps.find((step) => step.status === "failed")?.id).toBe("find-notification");
    expect(result.steps.at(-1)).toMatchObject({ id: "ambient-exit", status: "passed" });
  });

  test("the device-only plan passes on a round watch and notes the missing fixture", async () => {
    const client = new FakeClient({ startDevice: START }, [screen("sysui"), screen("sysui")]);
    const result = await runSmoke(buildWearSmokePlan({ avdName: "w" }), deps(client));
    expect(result.ok).toBe(true);
    const summary = renderSmokeSummary(WEAR_SMOKE_TITLE, result, wearSmokeNotes({}));
    expect(summary).toContain("> The Wear fixture app (#16828) was not built");
  });
});

describe("wearSmokeOptionsFromEnv", () => {
  test("treats empty values as unset", () => {
    expect(
      wearSmokeOptionsFromEnv({
        WEAR_SMOKE_FIXTURE_APK: "",
        WEAR_SMOKE_AVD_NAME: "w",
        WEAR_SMOKE_BREAK_ASSERTION: "1",
      }),
    ).toEqual({
      fixtureApkPath: undefined,
      avdName: "w",
      osVersion: undefined,
      breakAssertion: true,
    });
  });
});
