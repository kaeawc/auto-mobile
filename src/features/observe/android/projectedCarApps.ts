import { ANDROID_AUTO_PACKAGE } from "../../../models/CarAppTemplates";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../../../utils/androidPackageName";

/** A Car App Library app whose `CarAppService` Android Auto has bound, and the user it runs as. */
export interface ProjectedCarApp {
  packageName: string;
  userId: number;
}

/** A bound app with the components Android Auto holds a live binding to, as the dump names them. */
export interface ProjectedCarAppServices extends ProjectedCarApp {
  /** `<package>/<class>`, sorted; the class keeps the dump's short `.`-prefixed form. */
  services: string[];
}

/** What one `dumpsys activity services` read says about an Android Auto projection (#17841). */
export interface AndroidAutoProjectionServices {
  /**
   * Android Auto's own Car App Library template hosts (`.apphost.Template*Service`, one per app
   * category) that one of its processes holds bound, sorted. A bound host means a head unit session
   * is hosting car app templates; it says nothing about which app the head unit shows.
   */
  templateHosts: string[];
  /** Every app outside Android Auto with a live Android Auto binding, as {@link parseProjectedCarApps}. */
  apps: ProjectedCarAppServices[];
}

/** `* ServiceRecord{<hash> u<user> <package>/<class>[ c:<client>]}` */
const SERVICE_RECORD_HEADER =
  /^\s*\* ServiceRecord\{[0-9a-f]+ u(\d+) ([A-Za-z0-9_.]+)\/([^\s}]+)(?: [^}]*)?\}/;

const escapedHost = ANDROID_AUTO_PACKAGE.replace(/\./g, "\\.");
/** Android Auto's template host classes, short (`.apphost.X`) or fully qualified. */
const TEMPLATE_HOST_CLASS = new RegExp(`^(?:${escapedHost})?\\.apphost\\.Template\\w*Service$`);
/**
 * A live binding client in Android Auto's process (`gearhead` or one of its `:suffix` processes).
 * The header's `c:<package>` is only the last start/bind caller, so it never counts on its own.
 */
const ANDROID_AUTO_CLIENT = new RegExp(
  `AppBindRecord\\{[0-9a-f]+ ProcessRecord\\{[0-9a-f]+ \\d+:${escapedHost}(?::[\\w.]+)?/`,
);

interface ServiceBlock {
  packageName: string;
  className: string;
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
      current = {
        userId: Number(header[1]),
        packageName: header[2],
        className: header[3],
        lines: [line],
      };
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
  return parseAndroidAutoProjectionServices(dump).apps.map(({ packageName, userId }) => ({
    packageName,
    userId,
  }));
}

/** The bound apps (with their bound components) and Android Auto's bound template hosts. */
export function parseAndroidAutoProjectionServices(dump: string): AndroidAutoProjectionServices {
  const found = new Map<string, ProjectedCarAppServices>();
  const templateHosts = new Set<string>();
  for (const block of serviceBlocks(dump)) {
    if (!ANDROID_AUTO_CLIENT.test(block.lines.join("\n"))) {
      continue;
    }
    const component = `${block.packageName}/${block.className}`;
    if (block.packageName === ANDROID_AUTO_PACKAGE) {
      if (TEMPLATE_HOST_CLASS.test(block.className)) {
        templateHosts.add(component);
      }
      continue;
    }
    if (!ANDROID_PACKAGE_NAME_PATTERN.test(block.packageName)) {
      continue;
    }
    const key = `${block.packageName}\u0000${block.userId}`;
    const app = found.get(key) ?? {
      packageName: block.packageName,
      userId: block.userId,
      services: [],
    };
    if (!app.services.includes(component)) {
      app.services.push(component);
    }
    found.set(key, app);
  }
  const apps = [...found.values()]
    .map((app) => ({ ...app, services: [...app.services].sort() }))
    .sort((a, b) => a.packageName.localeCompare(b.packageName) || a.userId - b.userId);
  return { templateHosts: [...templateHosts].sort(), apps };
}
