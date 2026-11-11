import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult, ObserveResult } from "../../../../src/models";
import type { ForegroundApp } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  CAR_APP_PROJECTED_SERVICES_TTL_MS,
  CarAppTemplateReader,
  type CarAppAdb,
} from "../../../../src/features/observe/android/CarAppTemplateReader";
import { ANDROID_AUTO_PROJECTION_NOTE } from "../../../../src/models/AndroidAutoProjection";
import { ANDROID_AUTO_PACKAGE } from "../../../../src/models/CarAppTemplates";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  fixtureListBundle,
  projectionServicesDump,
  type ProjectionServicesFixture,
} from "../../../helpers/androidAutoProjectionFixtures";

const phone: BootedDevice = { deviceId: "emulator-5580", name: "Pixel 9", platform: "android" };
const FIXTURE_APP = "dev.jasonpearson.automobile.automotivefixture";
const NAVIGATION_HOST = `${ANDROID_AUTO_PACKAGE}/.apphost.TemplateNavigationService`;
const DUMP = "shell dumpsys activity services";
const MISSING =
  "Error while accessing provider:x\njava.lang.IllegalArgumentException: Unknown authority";

/** Answers the captured services dump and each package's `content call` route read. */
class FakeProjectionAdb implements CarAppAdb {
  readonly commands: string[] = [];
  dump: string | Error;
  /** Keyed by package, or `<package>@<user>` for one user only. */
  readonly routes = new Map<string, string>();
  /** Runs during every route read, before it answers. */
  onRouteRead: () => void = () => {};
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
    this.onRouteRead();
    const packageName = /content:\/\/(.+)\.automobile\.carapptemplates/.exec(command)?.[1] ?? "";
    const user = /--user (\d+)/.exec(command)?.[1] ?? "";
    const answer = this.routes.get(`${packageName}@${user}`) ?? this.routes.get(packageName);
    return createExecResult(answer ?? MISSING, "");
  }
  async getForegroundApp(): Promise<ForegroundApp | null> {
    return { packageName: ANDROID_AUTO_PACKAGE, userId: 0 };
  }
  dumps(): number {
    return this.commands.filter((command) => command === DUMP).length;
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

/** The served flow: the templates block first, then the projection block over that result. */
async function observeProjection(reader: CarAppTemplateReader, result: ObserveResult) {
  const carAppTemplates = await reader.resolve(phone, result);
  const templated = carAppTemplates ? { ...result, carAppTemplates } : result;
  return reader.resolveAndroidAuto(phone, templated);
}

function setup(bound: ProjectionServicesFixture) {
  const adb = new FakeProjectionAdb(bound);
  const timer = new FakeTimer();
  const reader = new CarAppTemplateReader(() => adb, timer);
  return { adb, timer, reader };
}

/** The captured dump plus the fixture's ServiceRecord block repeated as Android user 10. */
function dumpWithFixtureAlsoBoundForUser10(): string {
  const lines = projectionServicesDump("one").split(/\r?\n/);
  const start = lines.findIndex((line) =>
    line.includes(`u0 ${FIXTURE_APP}/.car.FixtureCarAppService`),
  );
  const end = lines.findIndex((line, index) => index > start && line.includes("* ServiceRecord{"));
  const user10 = lines
    .slice(start, end)
    .map((line, index) => (index === 0 ? line.replace(" u0 ", " u10 ") : line));
  return [...lines.slice(0, end), ...user10, ...lines.slice(end)].join("\n");
}

describe("androidAuto projection block (#17841)", () => {
  test("the fixture on the head unit: projecting, its bound service, no visible app claimed", async () => {
    const { adb, reader } = setup("one");
    adb.routes.set(FIXTURE_APP, fixtureListBundle());

    const block = await observeProjection(reader, observation(ANDROID_AUTO_PACKAGE));

    expect(block).toEqual({
      projecting: true,
      projectedBy: ANDROID_AUTO_PACKAGE,
      templateHosts: [NAVIGATION_HOST],
      apps: [
        {
          packageName: FIXTURE_APP,
          userId: 0,
          services: [`${FIXTURE_APP}/.car.FixtureCarAppService`],
        },
      ],
      note: ANDROID_AUTO_PROJECTION_NOTE,
    });
    expect(JSON.stringify(block)).not.toContain('visible":');
    expect(adb.dumps()).toBe(1);
  });

  test("bound apps whose route does not answer are not listed as car apps", async () => {
    const { reader } = setup("one");

    const block = await observeProjection(reader, observation(ANDROID_AUTO_PACKAGE));

    expect(block).toMatchObject({ projecting: true, templateHosts: [NAVIGATION_HOST], apps: [] });
  });

  test("nothing bound after projection ended: no block", async () => {
    const { reader } = setup("none");
    expect(await observeProjection(reader, observation(ANDROID_AUTO_PACKAGE))).toBeUndefined();
  });

  test("a foreground app other than Android Auto never dumps services for the block", async () => {
    const { adb, reader } = setup("one");
    expect(await reader.resolveAndroidAuto(phone, observation(FIXTURE_APP))).toBeUndefined();
    expect(adb.dumps()).toBe(0);
  });

  test("a non-Android device is never asked", async () => {
    const { adb, reader } = setup("one");
    const simulator: BootedDevice = { deviceId: "sim", name: "iPhone", platform: "ios" };
    expect(
      await reader.resolveAndroidAuto(simulator, observation(ANDROID_AUTO_PACKAGE)),
    ).toBeUndefined();
    expect(adb.dumps()).toBe(0);
  });

  test("a failed services dump omits the block", async () => {
    const { adb, reader } = setup("one");
    adb.dump = new Error("adb: device offline");
    expect(await observeProjection(reader, observation(ANDROID_AUTO_PACKAGE))).toBeUndefined();
  });

  test("a route read slower than the dump's TTL still uses the observation's one snapshot", async () => {
    const { adb, timer, reader } = setup("one");
    adb.routes.set(FIXTURE_APP, fixtureListBundle());
    adb.onRouteRead = () => timer.advanceTime(CAR_APP_PROJECTED_SERVICES_TTL_MS + 1);

    const block = await observeProjection(reader, observation(ANDROID_AUTO_PACKAGE));

    expect(block).toMatchObject({ projecting: true, apps: [{ packageName: FIXTURE_APP }] });
    expect(adb.dumps()).toBe(1);
  });

  test("an app bound for two users is listed only for the user whose route answered", async () => {
    const { adb, reader } = setup("one");
    adb.dump = dumpWithFixtureAlsoBoundForUser10();
    adb.routes.set(`${FIXTURE_APP}@0`, fixtureListBundle());

    const block = await observeProjection(reader, observation(ANDROID_AUTO_PACKAGE));

    expect(block?.apps.map(({ packageName, userId }) => ({ packageName, userId }))).toEqual([
      { packageName: FIXTURE_APP, userId: 0 },
    ]);
  });

  test("without a templates read for the same observation there is no block and no dump", async () => {
    const { adb, reader } = setup("one");
    adb.routes.set(FIXTURE_APP, fixtureListBundle());
    await reader.resolve(phone, observation(ANDROID_AUTO_PACKAGE));

    const other = { ...observation(ANDROID_AUTO_PACKAGE), observationId: "bb" };
    expect(await reader.resolveAndroidAuto(phone, other)).toBeUndefined();
    expect(adb.dumps()).toBe(1);
  });
});
