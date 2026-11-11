import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult, ObserveResult } from "../../../../src/models";
import type { ForegroundApp } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  CAR_APP_PROJECTED_SERVICES_TTL_MS,
  CAR_APP_ROUTE_ABSENT_TTL_MS,
  CarAppTemplateReader,
  type CarAppAdb,
} from "../../../../src/features/observe/android/CarAppTemplateReader";
import {
  ANDROID_AUTO_PACKAGE,
  CAR_APP_PROJECTED_NOTE,
  CAR_APP_TEMPLATES_NOTE,
  carAppTemplateDocumentSchema,
} from "../../../../src/models/CarAppTemplates";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  contentCallBundle,
  fixtureListBundle,
  fixtureListSnapshot,
  projectionServicesDump,
  type ProjectionServicesFixture,
} from "../../../helpers/androidAutoProjectionFixtures";

const phone: BootedDevice = { deviceId: "emulator-5580", name: "Pixel 9", platform: "android" };
const FIXTURE_APP = "dev.jasonpearson.automobile.automotivefixture";
const MAPS_APP = "com.google.android.apps.maps";
const PLAY_APP = "com.android.vending";
/** Every package with a live Android Auto binding in the captured dump, besides the fixture. */
const OTHER_BOUND_APPS = 5;
const DUMP = "shell dumpsys activity services";
const MISSING =
  "Error while accessing provider:x\njava.lang.IllegalArgumentException: Unknown authority";

const fixtureDocument = carAppTemplateDocumentSchema.parse(fixtureListSnapshot());

/** Answers the services dump and each package's `content call` from per-package replies. */
class FakeProjectionAdb implements CarAppAdb {
  readonly commands: string[] = [];
  foregroundLookups = 0;
  dump: string | Error;
  readonly routes = new Map<string, string>();
  constructor(bound: ProjectionServicesFixture) {
    this.dump = projectionServicesDump(bound);
  }
  async executeCommand(command: string): Promise<ExecResult> {
    this.commands.push(command);
    if (command === DUMP) {
      if (this.dump instanceof Error) {
        throw this.dump;
      }
      return createExecResult(this.dump, "");
    }
    const packageName = /content:\/\/(.+)\.automobile\.carapptemplates/.exec(command)?.[1] ?? "";
    return createExecResult(this.routes.get(packageName) ?? MISSING, "");
  }
  async getForegroundApp(): Promise<ForegroundApp | null> {
    this.foregroundLookups += 1;
    return { packageName: ANDROID_AUTO_PACKAGE, userId: 0 };
  }
  contentCalls(): string[] {
    return this.commands.filter((command) => command !== DUMP);
  }
}

function observation(appId: string): ObserveResult {
  return {
    updatedAt: 1,
    observationId: "aa",
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    screenSize: { width: 1, height: 1 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId, activityName: "GhostActivity", layoutSeqSum: 0 },
    userId: 0,
  };
}

function setup(bound: ProjectionServicesFixture) {
  const adb = new FakeProjectionAdb(bound);
  const timer = new FakeTimer();
  const reader = new CarAppTemplateReader(() => adb, timer);
  return { adb, timer, reader };
}

const projecting = observation(ANDROID_AUTO_PACKAGE);

describe("CarAppTemplateReader during Android Auto projection (#17826)", () => {
  test("zero bound car apps: one services dump, no route call, no block", async () => {
    const { adb, reader } = setup("none");
    expect(await reader.resolve(phone, projecting)).toBeUndefined();
    expect(adb.commands).toEqual([DUMP]);
    expect(adb.foregroundLookups).toBe(0);
  });

  test("the answering bound app becomes the projection block, read as its service user", async () => {
    const { adb, reader } = setup("one");
    adb.routes.set(FIXTURE_APP, fixtureListBundle());

    const block = await reader.resolve(phone, projecting);

    expect(block).toEqual({
      source: "sdk",
      note: CAR_APP_TEMPLATES_NOTE,
      projectedBy: ANDROID_AUTO_PACKAGE,
      projectedNote: CAR_APP_PROJECTED_NOTE,
      projected: [{ packageName: FIXTURE_APP, sessions: fixtureDocument.sessions }],
    });
    expect(adb.contentCalls()).toHaveLength(1 + OTHER_BOUND_APPS);
    expect(adb.contentCalls()).toContain(
      `shell content call --user 0 --uri 'content://${FIXTURE_APP}.automobile.carapptemplates' --method snapshot`,
    );
    expect(adb.foregroundLookups).toBe(0);
  });

  test("two answering apps are both listed by package name, none marked visible", async () => {
    const { adb, reader } = setup("one");
    adb.routes.set(FIXTURE_APP, fixtureListBundle());
    adb.routes.set(
      MAPS_APP,
      contentCallBundle({ ...fixtureDocument, error: "main_thread_timeout", sessions: [] }),
    );

    const block = await reader.resolve(phone, projecting);

    expect(block).toMatchObject({
      projectedNote: CAR_APP_PROJECTED_NOTE,
      projected: [
        { packageName: MAPS_APP, sessions: [], error: "main_thread_timeout" },
        { packageName: FIXTURE_APP, sessions: fixtureDocument.sessions },
      ],
    });
    expect(adb.contentCalls()).toContain(
      `shell content call --user 0 --uri 'content://${MAPS_APP}.automobile.carapptemplates' --method snapshot`,
    );
  });

  test("a bound app without the route costs one cached failed call", async () => {
    const { adb, timer, reader } = setup("one");
    adb.routes.set(FIXTURE_APP, fixtureListBundle());

    const first = await reader.resolve(phone, projecting);
    await reader.resolve(phone, projecting);
    timer.advanceTime(CAR_APP_ROUTE_ABSENT_TTL_MS - 1);
    await reader.resolve(phone, projecting);

    expect(first).toMatchObject({ projected: [{ packageName: FIXTURE_APP }] });
    const playCalls = adb.contentCalls().filter((command) => command.includes(PLAY_APP));
    expect(playCalls).toHaveLength(1);
    expect(adb.contentCalls()).toHaveLength(1 + OTHER_BOUND_APPS + 2);
    expect(adb.contentCalls().filter((command) => command.includes(FIXTURE_APP))).toHaveLength(3);
  });

  test("no bound app answering enabled leaves no block", async () => {
    const { adb, reader } = setup("one");
    adb.routes.set(
      FIXTURE_APP,
      contentCallBundle({ schemaVersion: 1, enabled: false, sessions: [] }),
    );
    expect(await reader.resolve(phone, projecting)).toBeUndefined();
  });

  test("back-to-back observations reuse one services dump until its TTL passes", async () => {
    const { adb, timer, reader } = setup("one");
    adb.routes.set(FIXTURE_APP, fixtureListBundle());
    const dumps = () => adb.commands.filter((command) => command === DUMP).length;

    await Promise.all([reader.resolve(phone, projecting), reader.resolve(phone, projecting)]);
    expect(dumps()).toBe(1);
    timer.advanceTime(CAR_APP_PROJECTED_SERVICES_TTL_MS - 1);
    expect(await reader.resolve(phone, projecting)).toMatchObject({
      projected: [{ packageName: FIXTURE_APP }],
    });
    expect(dumps()).toBe(1);
    timer.advanceTime(1);
    await reader.resolve(phone, projecting);
    expect(dumps()).toBe(2);
  });

  test("a failed services dump is not cached", async () => {
    const { adb, reader } = setup("one");
    adb.routes.set(FIXTURE_APP, fixtureListBundle());
    adb.dump = new Error("adb: device offline");
    expect(await reader.resolve(phone, projecting)).toBeUndefined();

    adb.dump = projectionServicesDump("one");
    expect(await reader.resolve(phone, projecting)).toMatchObject({
      projected: [{ packageName: FIXTURE_APP }],
    });
    expect(adb.commands.filter((command) => command === DUMP)).toHaveLength(2);
  });

  test("a failed services dump omits the block", async () => {
    const { adb, reader } = setup("one");
    adb.dump = new Error("adb: device offline");
    expect(await reader.resolve(phone, projecting)).toBeUndefined();
    expect(adb.contentCalls()).toEqual([]);
  });

  test("a non-Android-Auto foreground app never runs the services dump", async () => {
    const { adb, reader } = setup("one");
    adb.routes.set(FIXTURE_APP, fixtureListBundle());

    const block = await reader.resolve(phone, observation(FIXTURE_APP));

    expect(block).toEqual({
      packageName: FIXTURE_APP,
      source: "sdk",
      note: CAR_APP_TEMPLATES_NOTE,
      sessions: fixtureDocument.sessions,
    });
    expect(adb.commands).not.toContain(DUMP);
  });

  test("readProjected reads the bound apps for a head-unit action and keeps observe's snapshot", async () => {
    const { adb, reader } = setup("one");
    adb.routes.set(FIXTURE_APP, fixtureListBundle());
    await reader.resolve(phone, projecting);

    const block = await reader.readProjected(phone);

    expect(block?.projected).toEqual([
      { packageName: FIXTURE_APP, sessions: fixtureDocument.sessions },
    ]);
    expect(await reader.resolveAndroidAuto(phone, projecting)).toMatchObject({
      apps: [{ packageName: FIXTURE_APP }],
    });
    expect(await reader.readProjected({ ...phone, platform: "ios" })).toBeUndefined();
  });
});
