import { describe, expect, test } from "bun:test";
import {
  PROTOTYPE_ELEMENT_ATTRIBUTES,
  PrototypeElementController,
  prototypeElementOptions,
  prototypeElementScriptSpec,
  type PrototypeElementAttribute,
  type PrototypeElementEvent,
} from "../../../../../src/features/prototype/web/embed/prototypeWebElement";
import type { PrototypeMountHandle } from "../../../../../src/features/prototype/web/embed/prototypeWebMount";
import type {
  PrototypeMountOptions,
  PrototypeViewState,
} from "../../../../../src/features/prototype/web/embed/prototypeWebMountState";

const spec = { id: "hello", root: { type: "text", text: "Hello" } };

const VIEW: PrototypeViewState = {
  frame: "pixel-9",
  orientation: "portrait",
  zoom: "fit",
  scale: 1,
  mode: "light",
  screens: [],
  unsupportedNodes: [],
};

/** A fake element and mount: records mounts, updates, destroys and dispatched events. */
function harness(
  attributes: Record<string, string> = {},
  script: string | null = null,
  onDispatch: (type: PrototypeElementEvent) => void = () => {},
) {
  const attrs = new Map(Object.entries(attributes));
  const host: { script: string | null; watcher?: () => void } = { script };
  const log: string[] = [];
  const mounts: PrototypeMountOptions[] = [];
  const updates: Partial<PrototypeMountOptions>[] = [];
  const events: [PrototypeElementEvent, unknown][] = [];
  const controller = new PrototypeElementController(
    {
      getAttribute: (name) => attrs.get(name) ?? null,
      childSpecText: () => host.script,
      watchChildren: (changed) => {
        host.watcher = changed;
        log.push("watch");
        return () => {
          host.watcher = undefined;
          log.push("unwatch");
        };
      },
    },
    {
      mount: (options): PrototypeMountHandle => {
        mounts.push(options);
        log.push("mount");
        // As mount does, the first draw reports synchronously, before the handle is returned.
        options.onRender?.({ unsupportedNodes: [] });
        return {
          update: (next) => {
            updates.push(next);
            log.push("update");
          },
          destroy: () => log.push("destroy"),
          state: VIEW,
        };
      },
      dispatch: (type, detail) => {
        events.push([type, detail]);
        onDispatch(type);
      },
    },
  );
  return { controller, attrs, host, log, mounts, updates, events };
}

const optionsOf = (attributes: Partial<Record<PrototypeElementAttribute, string>>) =>
  prototypeElementOptions((name) => attributes[name] ?? null);

describe("<automobile-prototype> attributes (#16454)", () => {
  test("observes one attribute per scalar option", () => {
    expect([...PROTOTYPE_ELEMENT_ATTRIBUTES]).toEqual([
      "frame",
      "orientation",
      "zoom",
      "mode",
      "screen",
      "controls",
    ]);
  });

  test("sets no option for an absent attribute", () => {
    expect(optionsOf({})).toEqual({});
  });

  test("maps each attribute to its option", () => {
    expect(
      optionsOf({
        frame: "iphone-16",
        orientation: "landscape",
        zoom: "1.5",
        mode: "dark",
        screen: "detail",
        controls: "rotate, zoom",
      }),
    ).toEqual({
      frame: "iphone-16",
      orientation: "landscape",
      zoom: 1.5,
      mode: "dark",
      screen: "detail",
      controls: ["rotate", "zoom"],
    });
  });

  test("turns the frame and the controls off with false or none", () => {
    expect(optionsOf({ frame: "false", controls: "none" })).toEqual({
      frame: false,
      controls: false,
    });
    expect(optionsOf({ frame: "none", controls: "false" })).toEqual({
      frame: false,
      controls: false,
    });
  });

  test("fits for a zoom that is not a number, and ignores an unknown orientation or mode", () => {
    expect(optionsOf({ zoom: "fit" })).toEqual({ zoom: "fit" });
    expect(optionsOf({ zoom: "big" })).toEqual({ zoom: "fit" });
    expect(optionsOf({ zoom: "" })).toEqual({ zoom: "fit" });
    expect(optionsOf({ orientation: "sideways", mode: "sepia" })).toEqual({});
  });

  test("keeps only known controls, so an empty list draws none", () => {
    expect(optionsOf({ controls: "screen dance" })).toEqual({ controls: ["screen"] });
    expect(optionsOf({ controls: "" })).toEqual({ controls: [] });
  });
});

describe("<automobile-prototype> spec and lifecycle (#16454)", () => {
  test("mounts on connect with the child script's spec and the attributes", () => {
    const { controller, mounts } = harness({ frame: "iphone-16" }, JSON.stringify(spec));
    controller.connect();
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ spec, frame: "iphone-16" });
    expect(controller.spec).toEqual(spec);
    expect(controller.state).toBe(VIEW);
  });

  test("waits for a spec before mounting, then mounts once it is set", () => {
    const { controller, mounts, updates } = harness();
    controller.connect();
    expect(mounts).toEqual([]);
    expect(controller.state).toBeUndefined();
    controller.spec = spec;
    expect(mounts.map((options) => options.spec)).toEqual([spec]);
    controller.spec = { ...spec, id: "next" };
    expect(updates).toEqual([{ spec: { ...spec, id: "next" } }]);
  });

  test("prefers the spec property over the child script", () => {
    const { controller, mounts } = harness({}, JSON.stringify({ id: "script" }));
    controller.spec = spec;
    controller.connect();
    expect(mounts[0]?.spec).toEqual(spec);
  });

  test("does not mount while disconnected, and destroys on disconnect", () => {
    const { controller, log } = harness();
    controller.spec = spec;
    expect(log).toEqual([]);
    controller.connect();
    controller.disconnect();
    expect(log).toEqual(["mount", "destroy"]);
    expect(controller.state).toBeUndefined();
    controller.connect();
    expect(log).toEqual(["mount", "destroy", "mount"]);
  });

  test("mounts an unparseable child script as no spec, so mount refuses it", () => {
    expect(prototypeElementScriptSpec("{not json")).toBeUndefined();
    const { controller, mounts } = harness({}, "{not json");
    controller.connect();
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.spec).toBeUndefined();
  });

  test("updates on an attribute change, and remounts when one is removed", () => {
    const { controller, attrs, log, updates } = harness({ zoom: "2" });
    controller.spec = spec;
    controller.connect();
    attrs.set("orientation", "landscape");
    controller.attributeChanged();
    expect(updates).toEqual([{ zoom: 2, orientation: "landscape" }]);
    attrs.delete("zoom");
    controller.attributeChanged();
    expect(log).toEqual(["mount", "update", "destroy", "mount"]);
  });

  test("ignores an attribute change before it has mounted", () => {
    const { controller, log } = harness();
    controller.attributeChanged();
    expect(log).toEqual([]);
  });

  test("dispatches each mount callback as its event, with the callback's detail", () => {
    const { controller, mounts, events } = harness();
    controller.spec = spec;
    controller.connect();
    const options = mounts[0]!;
    const error = {
      code: "invalidInput" as const,
      message: "bad",
      missing: [],
      libraryVersion: "0.0.0",
    };
    options.onRender?.({ unsupportedNodes: [] });
    options.onScreenChange?.({ screen: "detail" });
    options.onOrientationChange?.({ orientation: "landscape" });
    options.onZoomChange?.({ zoom: 2, scale: 2 });
    options.onError?.(error);
    expect(events).toEqual([
      ["render", { unsupportedNodes: [] }],
      ["render", { unsupportedNodes: [] }],
      ["screenchange", { screen: "detail" }],
      ["orientationchange", { orientation: "landscape" }],
      ["zoomchange", { zoom: 2, scale: 2 }],
      ["error", error],
    ]);
  });

  test("a render listener that sets the spec updates the first mount, not a second", () => {
    const listener: { controller?: PrototypeElementController } = {};
    const fixture = harness({}, null, (type) => {
      if (type === "render" && listener.controller?.spec === spec) {
        listener.controller.spec = { ...spec, id: "replaced" };
      }
    });
    const { controller } = fixture;
    listener.controller = controller;
    controller.spec = spec;
    controller.connect();
    expect(fixture.log).toEqual(["mount", "update"]);
    expect(fixture.updates).toEqual([{ spec: { ...spec, id: "replaced" } }]);
  });

  test("a render listener that removes the element destroys the first mount", () => {
    const listener: { controller?: PrototypeElementController } = {};
    const fixture = harness({}, null, (type) => {
      if (type === "render") {
        listener.controller?.disconnect();
      }
    });
    const { controller } = fixture;
    listener.controller = controller;
    controller.spec = spec;
    controller.connect();
    expect(fixture.log).toEqual(["mount", "destroy"]);
    expect(controller.state).toBeUndefined();
  });

  test("a JSON script that arrives after connecting is drawn once it parses", () => {
    const { controller, host, log, mounts } = harness();
    controller.connect();
    expect(log).toEqual(["watch"]);
    // The parser has streamed in only part of the script so far.
    host.script = '{"id": "hel';
    host.watcher?.();
    expect(mounts).toEqual([]);
    host.script = JSON.stringify(spec);
    host.watcher?.();
    expect(mounts.map((options) => options.spec)).toEqual([spec]);
    expect(log).toEqual(["watch", "unwatch", "mount"]);
    expect(host.watcher).toBeUndefined();
  });

  test("stops watching for a script on disconnect", () => {
    const { controller, host, log } = harness();
    controller.connect();
    controller.disconnect();
    expect(log).toEqual(["watch", "unwatch"]);
    expect(host.watcher).toBeUndefined();
  });

  test("clearing the spec after it mounted mounts afresh with no spec, not the stale one", () => {
    const { controller, log, mounts } = harness();
    controller.spec = spec;
    controller.connect();
    controller.spec = undefined;
    expect(log).toEqual(["mount", "destroy", "mount"]);
    expect(mounts.map((options) => options.spec)).toEqual([spec, undefined]);
  });
});
