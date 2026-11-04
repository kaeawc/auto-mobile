import { expect, test } from "bun:test";
import {
  prototypeGateCapabilities,
  prototypeRequiredCapabilities,
} from "../../../src/features/prototype/prototypeCapabilityGates";
import { expandPrototypeComponents } from "../../../src/features/prototype/prototypeComponents";
import {
  PROTOTYPE_MARKER_TAP_EMIT_CONTEXT,
  prototypeMapError,
} from "../../../src/features/prototype/prototypeMap";
import { applyPrototypePatch } from "../../../src/features/prototype/prototypePatch";

const map = (fields: Record<string, unknown> = {}) => ({ type: "map", ...fields });
const spec = (node: Record<string, unknown>, requires: Record<string, unknown>) => ({
  requires,
  root: { type: "column", children: [node] },
});
const location = { name: "location", purpose: "Show where you are." };

test("a map needs the map module declared", () => {
  expect(prototypeMapError(spec(map(), {}))).toEqual({
    path: "root.children[0]",
    message: "map requires map in requires.platform",
  });
  expect(prototypeMapError(spec(map(), { platform: ["map"] }))).toBeUndefined();
});

test("showUserLocation needs the location module and its permission", () => {
  const node = map({ showUserLocation: true });
  expect(prototypeMapError(spec(node, { platform: ["map"] }))?.message).toBe(
    "showUserLocation requires location in requires.platform",
  );
  expect(prototypeMapError(spec(node, { platform: ["map", "location"] }))?.message).toBe(
    "showUserLocation requires permission location in requires.permissions",
  );
  const declared = { platform: ["map", "location"], permissions: [location] };
  expect(prototypeMapError(spec(node, declared))).toBeUndefined();
  // A hidden user-location dot reads nothing, so it needs neither.
  expect(
    prototypeMapError(spec(map({ showUserLocation: false }), { platform: ["map"] })),
  ).toBeUndefined();
});

test("onCameraIdle writes only into /data", () => {
  const at = (into: string) =>
    prototypeMapError(spec(map({ onCameraIdle: { into } }), { platform: ["map"] }));
  expect(at("/data/camera")).toBeUndefined();
  for (const into of ["/camera", "/data", "/dataCamera"]) {
    expect(at(into)).toEqual({
      path: "root.children[0].onCameraIdle.into",
      message: "onCameraIdle.into must be a /data/<pointer> path",
    });
  }
});

test("the contract adds markerId to a marker tap's emit context", () => {
  expect(PROTOTYPE_MARKER_TAP_EMIT_CONTEXT).toEqual(["markerId"]);
});

test("an onMarkerTap emit cannot author markerId, at any action depth", () => {
  const emit = (context: Record<string, unknown>) => ({ type: "emit", name: "tap", context });
  const at = (onMarkerTap: unknown[]) =>
    prototypeMapError(spec(map({ onMarkerTap }), { platform: ["map"] }));
  const message =
    "markerId is reserved in an onMarkerTap emit context: the runtime sets it to the tapped marker's id";
  expect(at([emit({ markerId: { value: "x" } })])).toEqual({
    path: "root.children[0].onMarkerTap[0].context.markerId",
    message,
  });
  const timer = { type: "startTimer", id: "t", afterMs: 100 };
  expect(at([{ ...timer, actions: [emit({ markerId: { state: "s" } })] }])).toEqual({
    path: "root.children[0].onMarkerTap[0].actions[0].context.markerId",
    message,
  });
  const request = { type: "request", method: "GET", url: "https://example.com" };
  expect(at([{ ...request, onError: [emit({ markerId: { value: 1 } })] }])?.path).toBe(
    "root.children[0].onMarkerTap[0].onError[0].context.markerId",
  );
  // Other names, payload fields and non-emit actions are the author's.
  expect(at([emit({ marker: { value: "x" } })])).toBeUndefined();
  expect(at([{ type: "emit", name: "tap", payload: { markerId: "x" } }])).toBeUndefined();
  expect(at([{ type: "setState", key: "markerId", value: "x" }])).toBeUndefined();
});

test("markerId stays an authored name outside onMarkerTap", () => {
  const button = {
    type: "button",
    label: "Go",
    onTap: [{ type: "emit", name: "go", context: { markerId: { value: "x" } } }],
  };
  const both = {
    requires: { platform: ["map"] },
    root: { type: "column", children: [map(), button] },
  };
  expect(prototypeMapError(both)).toBeUndefined();
});

test("the map gate names each map node as well as the declaration", () => {
  const gates = prototypeRequiredCapabilities(spec(map(), { platform: ["map"] }));
  expect(gates.find((gate) => gate.capability === "prototype_platform_map_v1")?.fields).toEqual([
    "requires.platform[0]",
    "root.children[0]",
  ]);
});

test("a component prop used in onMarkerTap binds like one in onTap", () => {
  const expansion = expandPrototypeComponents({
    requires: { platform: ["map"] },
    components: {
      stops: {
        root: map({ onMarkerTap: [{ type: "emit", name: "{props.eventName}" }] }),
      },
    },
    root: { type: "use", component: "stops", props: { eventName: "stop_tapped" } },
  });
  expect(expansion.success).toBe(true);
  expect(expansion.success && expansion.spec).toMatchObject({
    root: { type: "map", onMarkerTap: [{ type: "emit", name: "stop_tapped" }] },
  });
});

test("a map-shaped value outside a node position is not a map use", () => {
  const request = {
    type: "button",
    label: "Go",
    onTap: [{ type: "request", url: "https://example.com", via: "device", query: { type: "map" } }],
  };
  const gates = prototypeRequiredCapabilities({ root: { type: "column", children: [request] } });
  expect(gates.map((gate) => gate.capability)).not.toContain("prototype_platform_map_v1");
});

const backendGate = (value: unknown, backend: string) =>
  prototypeRequiredCapabilities(value).find(
    (gate) => gate.capability === `prototype_platform_map_${backend}_v1`,
  );

test("a non-default backend needs its own capability on top of the map module's", () => {
  for (const backend of ["google", "maplibre"]) {
    const gate = backendGate(spec(map({ backend }), { platform: ["map"] }), backend);
    expect(gate?.fields).toEqual(["root.children[0].backend"]);
    expect(gate?.unsupportedMessage(gate.fields, "android")).toContain(
      `the map \`${backend}\` backend at root.children[0].backend`,
    );
  }
  for (const node of [map(), map({ backend: "auto" })]) {
    const capabilities = prototypeGateCapabilities(spec(node, { platform: ["map"] }));
    expect(capabilities).toContain("prototype_platform_map_v1");
    expect(capabilities.filter((name) => name.startsWith("prototype_platform_map_"))).toEqual([
      "prototype_platform_map_v1",
    ]);
  }
});

test("the backend gate reads the complete patch result", () => {
  const shown = spec(map({ id: "rideMap" }), { platform: ["map"] });
  const patched = applyPrototypePatch(shown, [
    { op: "replaceNode", id: "rideMap", node: map({ id: "rideMap", backend: "google" }) },
  ]);
  expect(patched.success).toBe(true);
  expect(backendGate(shown, "google")).toBeUndefined();
  expect(patched.success && backendGate(patched.spec, "google")?.fields).toEqual([
    "root.children[0].backend",
  ]);
});

test("a backend inside a component is reported at the authored node", () => {
  const gate = backendGate(
    {
      requires: { platform: ["map"] },
      components: { stops: { root: map({ backend: "google" }) } },
      root: { type: "column", children: [{ type: "use", component: "stops" }] },
    },
    "google",
  );
  expect(gate?.fields).toEqual(["root.children[0] (use stops) → components.stops.root.backend"]);
});
