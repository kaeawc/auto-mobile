import { ANDROID_AUTO_PACKAGE } from "../../../models/CarAppTemplates";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../../../utils/androidPackageName";

/** A Car App Library app whose `CarAppService` Android Auto has bound, and the user it runs as. */
export interface ProjectedCarApp {
  packageName: string;
  userId: number;
}

/** `* ServiceRecord{<hash> u<user> <package>/<class>[ c:<client>]}` */
const SERVICE_RECORD_HEADER =
  /^\s*\* ServiceRecord\{[0-9a-f]+ u(\d+) ([A-Za-z0-9_.]+)\/[^\s}]+(?: [^}]*)?\}/;

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

/**
 * The indented `dumpsys activity services` section headers (AOSP `ActiveServices.dumpLocked`). A
 * ServiceRecord block ends only at one of these, an unindented line, or the next ServiceRecord,
 * never at a low-indent field inside the record: API 36 prints ` startCommandResult=N` at indent
 * 1, before `Bindings:`.
 */
const SECTION_HEADER =
  /^\s+(?:User \d+ active services|Pending services|Restarting services|Destroying services|Connection bindings to services):$/;

function isSectionHeader(line: string): boolean {
  // An unindented line (`Active foreground apps - user 0:`, the next dumpsys section) is outer too.
  return SECTION_HEADER.test(line) || /^\S/.test(line);
}

/** Splits the dump into ServiceRecord blocks; a block ends at the next record or section header. */
function serviceBlocks(dump: string): ServiceBlock[] {
  const blocks: ServiceBlock[] = [];
  let current: ServiceBlock | undefined;
  for (const line of dump.split(/\r?\n/)) {
    const header = SERVICE_RECORD_HEADER.exec(line);
    if (header) {
      current = { userId: Number(header[1]), packageName: header[2], lines: [line] };
      blocks.push(current);
    } else if (isSectionHeader(line)) {
      current = undefined;
    } else {
      current?.lines.push(line);
    }
  }
  return blocks;
}

/**
 * The candidate projected apps, from `dumpsys activity services`: every ServiceRecord outside
 * Android Auto whose live binding client is Android Auto's process. The bind intent carries no
 * `androidx.car.app.CarAppService` action (a live API 36 capture shows `intent={id=0/main
 * cmp=<pkg>/<class>}`), so a Car App Library app is not told apart here: Android Auto also binds
 * Maps, media and Play services, and the per-package template route read keeps only the apps that
 * answer enabled. Each package and user appears once, ordered by package name then user: the
 * dump's order says nothing about which app is shown.
 */
export function parseProjectedCarApps(dump: string): ProjectedCarApp[] {
  const found = new Map<string, ProjectedCarApp>();
  for (const block of serviceBlocks(dump)) {
    const body = block.lines.join("\n");
    if (
      block.packageName === ANDROID_AUTO_PACKAGE ||
      !ANDROID_PACKAGE_NAME_PATTERN.test(block.packageName) ||
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
