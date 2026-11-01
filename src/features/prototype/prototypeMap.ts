import { prototypeDataPathPointer } from "./prototypeData";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import type { PrototypePlatformError } from "./prototypePlatform";
import { record, type Raw } from "./prototypeTemplate";

/**
 * Rules for the `map` node (#14309) that the contract cannot express: a map needs `map` in
 * `requires.platform`; `showUserLocation` reads the `location` module, so it also needs `location`
 * in `requires.platform` and the `location` permission in `requires.permissions`; and
 * `onCameraIdle.into` is a `/data` write path.
 */
export function prototypeMapError(root: Raw): PrototypePlatformError | undefined {
  const requires = record(root.requires) ?? {};
  const platform = Array.isArray(requires.platform) ? requires.platform : [];
  const permissions = Array.isArray(requires.permissions) ? requires.permissions : [];
  const scope = {
    map: platform.includes("map"),
    location: platform.includes("location"),
    permission: permissions.some((entry) => record(entry)?.name === "location"),
  };
  let first: PrototypePlatformError | undefined;
  walkPrototypeNodes(root, (node, path) => {
    if (!first && node.type === "map") {
      first = mapNodeError(node, path, scope);
    }
  });
  return first;
}

function mapNodeError(
  node: Raw,
  path: string,
  scope: { map: boolean; location: boolean; permission: boolean },
): PrototypePlatformError | undefined {
  const fail = (at: string, message: string) => ({ path: at, message });
  if (!scope.map) {
    return fail(path, "map requires map in requires.platform");
  }
  if (node.showUserLocation === true && !scope.location) {
    return fail(
      `${path}.showUserLocation`,
      "showUserLocation requires location in requires.platform",
    );
  }
  if (node.showUserLocation === true && !scope.permission) {
    return fail(
      `${path}.showUserLocation`,
      "showUserLocation requires permission location in requires.permissions",
    );
  }
  const into = record(node.onCameraIdle)?.into;
  if (into !== undefined && prototypeDataPathPointer(into) === undefined) {
    return fail(`${path}.onCameraIdle.into`, "onCameraIdle.into must be a /data/<pointer> path");
  }
  return undefined;
}
