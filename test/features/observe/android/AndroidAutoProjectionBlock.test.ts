import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult, ObserveResult } from "../../../../src/models";
import type { ForegroundApp } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
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
  const reader = new CarAppTemplateReader(() => adb, new FakeTimer());
  return { adb, reader };
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
});
