import { ANDROID_AUTO_PACKAGE } from "../../../models/CarAppTemplates";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../../../utils/androidPackageName";

/** A Car App Library app whose `CarAppService` Android Auto has bound, and the user it runs as. */
export interface ProjectedCarApp {
  packageName: string;
  userId: number;
}

/** The intent action a Car App Library host binds an app's `CarAppService` with. */
export const CAR_APP_SERVICE_ACTION = "androidx.car.app.CarAppService";

/** `* ServiceRecord{<hash> u<user> <package>/<class>[ c:<client>]}` */
const SERVICE_RECORD_HEADER =
  /^(\s*)\* ServiceRecord\{[0-9a-f]+ u(\d+) ([A-Za-z0-9_.]+)\/[^\s}]+(?: [^}]*)?\}/;

const escapedHost = ANDROID_AUTO_PACKAGE.replace(/\./g, "\\.");
/**
 * A live binding client in Android Auto's process (`gearhead` or one of its `:suffix` processes).
 * The header's `c:<package>` is only the last start/bind caller, so it never counts on its own.
 */
const ANDROID_AUTO_CLIENT = new RegExp(
  `AppBindRecord\\{[0-9a-f]+ ProcessRecord\\{[0-9a-f]+ \\d+:${escapedHost}(?::[\\w.]+)?/`,
);

interface ServiceBlock {
  packageName: string;
  userId: number;
  lines: string[];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Splits the dump into ServiceRecord blocks; a block ends at its next sibling or outer line. */
function serviceBlocks(dump: string): ServiceBlock[] {
  const blocks: ServiceBlock[] = [];
  let current: (ServiceBlock & { indent: number }) | undefined;
  for (const line of dump.split(/\r?\n/)) {
    const header = SERVICE_RECORD_HEADER.exec(line);
    if (header) {
      current = {
        indent: header[1].length,
        userId: Number(header[2]),
        packageName: header[3],
        lines: [line],
      };
      blocks.push(current);
    } else if (current && line.trim() !== "" && indentOf(line) <= current.indent) {
      current = undefined;
    } else {
      current?.lines.push(line);
    }
  }
  return blocks;
}

/**
 * The apps Android Auto has bound a `CarAppService` of, from `dumpsys activity services`: a
 * ServiceRecord whose intent carries {@link CAR_APP_SERVICE_ACTION} and whose binding client is
 * Android Auto's process. Android Auto's own services are excluded. Each package and user appears
 * once, ordered by package name then user: the dump's order says nothing about which app is shown.
 */
export function parseProjectedCarApps(dump: string): ProjectedCarApp[] {
  const found = new Map<string, ProjectedCarApp>();
  for (const block of serviceBlocks(dump)) {
    const body = block.lines.join("\n");
    if (
      block.packageName === ANDROID_AUTO_PACKAGE ||
      !ANDROID_PACKAGE_NAME_PATTERN.test(block.packageName) ||
      !body.includes(`act=${CAR_APP_SERVICE_ACTION}`) ||
      !ANDROID_AUTO_CLIENT.test(body)
    ) {
      continue;
    }
    found.set(`${block.packageName}\u0000${block.userId}`, {
      packageName: block.packageName,
      userId: block.userId,
    });
  }
  return [...found.values()].sort(
    (a, b) => a.packageName.localeCompare(b.packageName) || a.userId - b.userId,
  );
}
