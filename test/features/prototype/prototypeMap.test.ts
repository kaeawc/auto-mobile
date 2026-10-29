import { expect, test } from "bun:test";
import { prototypeRequiredCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { expandPrototypeComponents } from "../../../src/features/prototype/prototypeComponents";
import { prototypeMapError } from "../../../src/features/prototype/prototypeMap";

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
