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

export function parseFallbackMainActivities(stdout: string, packageName: string): string[] {
  const activities: string[] = [];
  const pattern = new RegExp(`${RegExp.escape(packageName)}[^\\s]*`, "g");
  const lines = stdout.split("\n");
  for (const line of lines) {
    if (!isMainActivityLine(line)) {
      continue;
    }
    for (const match of line.match(pattern) ?? []) {
      if (!activities.includes(match)) {
        activities.push(match);
      }
    }
  }
  return activities;
}

function isMainActivityLine(line: string): boolean {
  return (
    line.includes("android.intent.action.MAIN") ||
    line.includes("MainActivity") ||
    line.includes(".Main")
  );
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
