export function parseLauncherActivities(stdout: string, packageName: string): string[] {
  const activities: string[] = [];
  if (!stdout.trim()) {
    return activities;
  }
  const escapedPackageName = RegExp.escape(packageName);
  const patterns = [
    new RegExp(`${escapedPackageName}/([^\\s]+)`, "g"),
    new RegExp(`${escapedPackageName}\\.[^\\s]*Activity[^\\s]*`, "g"),
    new RegExp(`${escapedPackageName}\\.[^\\s]+`, "g"),
  ];
  for (const pattern of patterns) {
    for (const match of stdout.match(pattern) ?? []) {
      const activityName = activityFromMatch(match, packageName);
      if (activityName && !activities.includes(activityName)) {
        activities.push(activityName);
      }
    }
  }
  return activities;
}

function activityFromMatch(match: string, packageName: string): string | undefined {
  // All three patterns preserve the first slash segment, even for full-class tokens.
  if (match.includes("/")) {
    return match.split("/")[1];
  }
  return match.startsWith(packageName + ".") ? match : undefined;
}

interface PackageDumpFilter {
  component: string;
  indentation: number;
  hasMain: boolean;
  hasLauncher: boolean;
}

/** Read complete intent filters only within the Activity Resolver Table. */
export function parseLauncherActivitiesFromPackageDump(
  stdout: string,
  packageName: string,
): string[] {
  const activities = new Set<string>();
  let inActivityTable = false;
  let filter: PackageDumpFilter | undefined;

  for (const rawLine of stdout.split("\n")) {
    const dumpLine = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const line = dumpLine.trim();
    if (!inActivityTable) {
      inActivityTable = dumpLine === "Activity Resolver Table:";
      continue;
    }
    if (!line) {
      continue;
    }
    const indentation = dumpLine.length - dumpLine.trimStart().length;
    // Any unindented section ends this table, including Receiver/Service tables.
    if (indentation === 0) {
      break;
    }
    const nextFilter = parsePackageDumpFilterHeader(line, indentation);
    if (nextFilter || (filter && indentation <= filter.indentation)) {
      addPackageDumpLauncherActivity(filter, packageName, activities);
      filter = nextFilter;
      continue;
    }
    // A remaining open filter can only receive lines deeper than its header.
    if (filter) {
      filter.hasMain ||= line === 'Action: "android.intent.action.MAIN"';
      filter.hasLauncher ||= line === 'Category: "android.intent.category.LAUNCHER"';
    }
  }
  addPackageDumpLauncherActivity(filter, packageName, activities);
  return [...activities];
}

function parsePackageDumpFilterHeader(
  line: string,
  indentation: number,
): PackageDumpFilter | undefined {
  const tokens = line.split(/\s+/);
  if (
    tokens.length !== 4 ||
    !/^[0-9a-f]+$/i.test(tokens[0]) ||
    !tokens[1].includes("/") ||
    tokens[2] !== "filter" ||
    !/^[0-9a-f]+$/i.test(tokens[3])
  ) {
    return undefined;
  }
  return { component: tokens[1], indentation, hasMain: false, hasLauncher: false };
}

function addPackageDumpLauncherActivity(
  filter: PackageDumpFilter | undefined,
  packageName: string,
  activities: Set<string>,
): void {
  if (!filter?.hasMain || !filter.hasLauncher) {
    return;
  }
  const [componentPackage, activity] = filter.component.split("/");
  if (componentPackage === packageName && activity) {
    activities.add(activity);
  }
}

export function resolveComponentActivity(
  componentName: string,
  packageName: string,
): string | undefined {
  const slash = componentName.indexOf("/");
  if (slash >= 0) {
    let activity = componentName.slice(slash + 1);
    if (activity.startsWith(".")) {
      activity = packageName + activity;
    }
    return activity;
  }
  return undefined;
}
