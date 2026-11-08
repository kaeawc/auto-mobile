import { record, type Raw } from "./prototypeTemplate";

/**
 * `permissions.request` may only ask for permissions the spec declares in `requires.permissions`,
 * since the declaration carries the usage string and the manifest entry (#14297). Bound lists are
 * only known at run time, so only a literal list is checked here.
 */
export function prototypePermissionRequestError(
  args: Raw,
  path: string,
  declared: ReadonlySet<string>,
): { path: string; message: string } | undefined {
  const names = record(args.names)?.value;
  if (!Array.isArray(names)) {
    return undefined;
  }
  const index = names.findIndex((name) => typeof name === "string" && !declared.has(name));
  return index < 0
    ? undefined
    : {
        path: `${path}.names.value[${index}]`,
        message: `Permission ${String(names[index])} is not declared in requires.permissions`,
      };
}
