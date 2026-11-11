import { describe, expect, test } from "bun:test";
import {
  HeadUnitInteraction,
  deriveHeadUnitEffect,
  headUnitButtonCommands,
  headUnitRead,
  headUnitScreens,
  headUnitTapCommand,
  type HeadUnitIdleTiming,
} from "../../../src/features/androidAuto/HeadUnitInteraction";
import type { CarAppProjectedTemplates } from "../../../src/models/CarAppTemplates";
import { FakeSession } from "../../fakes/FakeAndroidAutoProjection";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FIXTURE_CAR_APP_PACKAGE,
  fixtureProjectedTemplates,
} from "../../helpers/androidAutoProjectionFixtures";

type TopTemplate = NonNullable<
  CarAppProjectedTemplates["projected"][number]["sessions"][number]["screens"][number]["template"]
>;

const MENU = fixtureProjectedTemplates(1);
const LIST = fixtureProjectedTemplates(2);
const FIXTURE_CAR = "dev.jasonpearson.automobile.automotivefixture.car";

const TIMING: HeadUnitIdleTiming = { pollMs: 250, unchangedSettleMs: 1_000, timeoutMs: 3_000 };

/**
 * Template reads in order: each read returns the next entry, and the last one repeats. A command
 * sent to the console moves the reads on to `afterCommand`, as the head unit would.
 */
function setup(
  beforeCommand: (CarAppProjectedTemplates | undefined)[],
  afterCommand: (CarAppProjectedTemplates | undefined)[],
) {
  const session = new FakeSession();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let reads = [...beforeCommand];
  let readCount = 0;
  const templates = {
    read: async () => {
      readCount++;
      return reads.length > 1 ? reads.shift() : reads[0];
    },
  };
  const dhuConsole = {
    sendCommand: (command: string) => {
      session.sendCommand(command);
      reads = [...afterCommand];
    },
    isRunning: () => session.isRunning(),
  };
  const interaction = new HeadUnitInteraction(dhuConsole, templates, timer, TIMING);
  return { session, interaction, reads: () => readCount };
}

describe("head unit console commands", () => {
  test("tapAt sends head-unit pixels, rounded", () => {
    expect(headUnitTapCommand(640.4, 359.6)).toBe("tap 640 360");
  });

  test("tapAt refuses a negative or non-finite point", () => {
    expect(() => headUnitTapCommand(-1, 10)).toThrow("non-negative head-unit pixel");
    expect(() => headUnitTapCommand(10, Number.NaN)).toThrow("tapAt y");
  });

  test("pressButton maps D-pad, back, home, media and rotary buttons", () => {
    expect(headUnitButtonCommands("back")).toEqual(["dpad back"]);
    expect(headUnitButtonCommands("select")).toEqual(["dpad click"]);
    expect(headUnitButtonCommands("up")).toEqual(["dpad up"]);
    expect(headUnitButtonCommands("home")).toEqual(["keycode home"]);
    expect(headUnitButtonCommands("playPause")).toEqual(["keycode media_play_pause"]);
    expect(headUnitButtonCommands("rotary_rotate_cw", { steps: 3 })).toEqual([
      "dpad rotate right",
      "dpad rotate right",
      "dpad rotate right",
    ]);
  });

  test("pressButton refuses a button, steps or a hold the console cannot send", () => {
    expect(() => headUnitButtonCommands("volume_up")).toThrow("no head unit equivalent");
    expect(() => headUnitButtonCommands("back", { steps: 2 })).toThrow("steps applies only");
    expect(() => headUnitButtonCommands("select", { durationMs: 800 })).toThrow("no long press");
  });
});

describe("head unit screen identity from the captured templates", () => {
  test("reads the top screen class, template and depth of each projected session", () => {
    expect(headUnitScreens(LIST)).toEqual([
      expect.objectContaining({
        packageName: FIXTURE_CAR_APP_PACKAGE,
        screenClass: `${FIXTURE_CAR}.ListScreen`,
        templateType: "ListTemplate",
        depth: 2,
      }),
    ]);
    expect(headUnitScreens(MENU)).toEqual([
      expect.objectContaining({
        screenClass: `${FIXTURE_CAR}.TemplateMenuScreen`,
        title: "AutoMobile Templates",
        depth: 1,
      }),
    ]);
  });

  test("a push and a pop read as changed, the same stack as unchanged", () => {
    const menu = headUnitRead(MENU);
    const list = headUnitRead(LIST);
    expect(deriveHeadUnitEffect(menu, list)).toEqual({
      screenChanged: true,
      basis: "carAppTemplates changed",
    });
    expect(deriveHeadUnitEffect(list, menu).screenChanged).toBe(true);
    expect(deriveHeadUnitEffect(menu, headUnitRead(fixtureProjectedTemplates(1)))).toEqual({
      screenChanged: false,
      basis: "carAppTemplates unchanged",
    });
  });

  test("a change inside the same top template reads as changed (#17911)", () => {
    const edited = (edit: (template: TopTemplate) => TopTemplate) => {
      const templates = fixtureProjectedTemplates(2);
      const top = templates.projected[0].sessions[0].screens[1];
      top.template = edit(top.template!);
      return headUnitRead(templates);
    };
    const tabbed = (active: number) =>
      edited((template) => ({
        ...template,
        type: "TabTemplate",
        tabs: [0, 1].map((index) => ({
          id: `tab${index}`,
          contentId: `content${index}`,
          title: `Tab ${index}`,
          hasIcon: false,
          active: index === active,
        })),
      }));
    // A tab switch keeps the screen class, template type, title and depth.
    expect(deriveHeadUnitEffect(tabbed(0), tabbed(1)).screenChanged).toBe(true);
    expect(deriveHeadUnitEffect(tabbed(0), tabbed(0)).screenChanged).toBe(false);
    // An item refresh: the first row's text changes in place.
    const refreshed = edited((template) => ({
      ...template,
      items: template.items.map((item, index) =>
        index === 0 ? { ...item, texts: [...item.texts, "updated"] } : item,
      ),
    }));
    expect(deriveHeadUnitEffect(headUnitRead(LIST), refreshed)).toEqual({
      screenChanged: true,
      basis: "carAppTemplates changed",
    });
    expect(headUnitScreens(LIST)).toEqual(refreshed.screens);
  });

  test("without template data on either side the change is unknown, not unchanged", () => {
    expect(deriveHeadUnitEffect(undefined, headUnitRead(LIST))).toEqual({
      basis: "no template data",
    });
  });
});

describe("HeadUnitInteraction", () => {
  test("a tap that pushes ListScreen reports the change once the templates settle", async () => {
    const { session, interaction } = setup([MENU], [MENU, LIST, LIST]);
    const result = await interaction.run(["tap 640 200"]);
    expect(session.commands).toEqual(["tap 640 200"]);
    expect(result.effect).toEqual({ screenChanged: true, basis: "carAppTemplates changed" });
    expect(result.after?.[0].screenClass).toBe(`${FIXTURE_CAR}.ListScreen`);
    expect(result.idle).toEqual({ basis: "carAppTemplates", stable: true, waitedMs: 750 });
  });

  test("back pops to the menu", async () => {
    const { session, interaction } = setup([LIST], [MENU]);
    const result = await interaction.run(["dpad back"]);
    expect(session.commands).toEqual(["dpad back"]);
    expect(result.effect.screenChanged).toBe(true);
    expect(result.after?.[0].depth).toBe(1);
  });

  test("a no-op tap waits out the unchanged settle window, then reads as unchanged", async () => {
    const { interaction } = setup([MENU], [MENU]);
    const result = await interaction.run(["tap 5 5"]);
    expect(result.effect).toEqual({ screenChanged: false, basis: "carAppTemplates unchanged" });
    expect(result.idle).toEqual({ basis: "carAppTemplates", stable: true, waitedMs: 1_000 });
  });

  test("a template still loading is not idle", async () => {
    const loading = fixtureProjectedTemplates(2);
    const top = loading.projected[0].sessions[0].screens[1];
    top.template = { ...top.template!, loading: true };
    const { interaction } = setup([MENU], [loading, loading, LIST, LIST]);
    const result = await interaction.run(["tap 640 200"]);
    expect(result.idle.waitedMs).toBe(1_000);
    expect(result.after?.[0].loading).toBeUndefined();
  });

  test("templates that never settle end at the timeout", async () => {
    const reads = Array.from({ length: 20 }, (_, index) => (index % 2 ? MENU : LIST));
    const { interaction } = setup([MENU], reads);
    const result = await interaction.run(["tap 640 200"]);
    expect(result.idle).toEqual({ basis: "carAppTemplates", stable: false, waitedMs: 3_000 });
  });

  test("with no projected template route it sends the input and reports the change as unknown", async () => {
    const { session, interaction, reads } = setup([undefined], [undefined]);
    const result = await interaction.run(["dpad back"]);
    expect(session.commands).toEqual(["dpad back"]);
    expect(result.effect).toEqual({ basis: "no template data" });
    expect(result.idle).toEqual({ basis: "none", stable: false, waitedMs: 250 });
    expect(reads()).toBe(2);
  });

  test("a stopped DHU is refused before any input", async () => {
    const { session, interaction } = setup([MENU], [LIST]);
    session.running = false;
    await expect(interaction.run(["tap 1 1"])).rejects.toThrow("not running");
    expect(session.commands).toEqual([]);
  });

  test("an aborted call sends nothing", async () => {
    const { session, interaction } = setup([MENU], [LIST]);
    const controller = new AbortController();
    controller.abort();
    await expect(interaction.run(["tap 1 1"], controller.signal)).rejects.toThrow();
    expect(session.commands).toEqual([]);
  });

  test("a failed template read is no evidence: it neither shows a change nor settles idle", async () => {
    const failed = fixtureProjectedTemplates(2);
    failed.projected[0] = { ...failed.projected[0], sessions: [], error: "main_thread_timeout" };
    const { interaction } = setup([MENU], [failed]);
    const result = await interaction.run(["tap 640 200"]);
    expect(result.effect).toEqual({ basis: "no template data" });
    expect(result.idle).toEqual({ basis: "none", stable: false, waitedMs: 3_000 });
    expect(result.after).toBeUndefined();
  });

  test("a tap that toggles a row on the same screen reports the change (#17911)", async () => {
    const toggled = fixtureProjectedTemplates(2);
    const top = toggled.projected[0].sessions[0].screens[1];
    top.template = {
      ...top.template!,
      items: top.template!.items.map((item, index) =>
        index === 0 ? { ...item, toggle: !(item.toggle ?? false) } : item,
      ),
    };
    const { interaction } = setup([LIST], [toggled]);
    const result = await interaction.run(["tap 640 200"]);
    expect(result.effect).toEqual({ screenChanged: true, basis: "carAppTemplates changed" });
    expect(result.idle).toEqual({ basis: "carAppTemplates", stable: true, waitedMs: 500 });
  });

  test("a projected app whose read failed makes the screen unknown, not changed (#17911)", async () => {
    const partial = fixtureProjectedTemplates(2);
    partial.projected.unshift({
      packageName: "com.example.other",
      sessions: [],
      error: "template_read_failed",
    });
    const { interaction } = setup([LIST], [partial]);
    const result = await interaction.run(["dpad down"]);
    expect(result.effect).toEqual({ basis: "no template data" });
    expect(result.idle.stable).toBe(false);
  });

  test("a loading active tab is not idle", async () => {
    const tabs = (loading: boolean) => {
      const templates = fixtureProjectedTemplates(2);
      const top = templates.projected[0].sessions[0].screens[1];
      // The captured ListTemplate has no tabContent, so it serves as both the bar and the tab.
      const outer = top.template!;
      top.template = {
        ...outer,
        type: "TabTemplate",
        tabContent: { ...outer, type: "ListTemplate", ...(loading ? { loading: true } : {}) },
      };
      return templates;
    };
    const { interaction } = setup([MENU], [tabs(true), tabs(true), tabs(false), tabs(false)]);
    const result = await interaction.run(["tap 640 200"]);
    expect(result.idle.waitedMs).toBe(1_000);
    expect(result.after?.[0].loading).toBeUndefined();
  });
});
