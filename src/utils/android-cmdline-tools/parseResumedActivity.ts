/** An activity reported as resumed by `dumpsys activity activities`. */
export interface ResumedActivity {
  packageName: string;
  activityName: string;
  userId: number;
  taskId: number;
}

export interface DisplayResumedActivity {
  activity?: ResumedActivity;
  displayCount: number;
}

const DISPLAY_HEADER = /^Display #(\d+) \(activities from top to bottom\):/;
const RESUMED_LINE =
  /^\s*(topResumedActivity|mResumedActivity|ResumedActivity|Resumed|mFocusedActivity)\s*[:=]\s*ActivityRecord\{\S+\s+u(\d+)\s+([^\s}]+)(.*)$/;

function parseResumedLine(
  line: string,
): { activity: ResumedActivity; priority: number } | undefined {
  const match = line.match(RESUMED_LINE);
  if (!match) {
    return undefined;
  }
  const [packageName, component] = match[3].split("/");
  if (!packageName || !component) {
    return undefined;
  }
  const task = match[4].match(/(?:^|[\s}])t(\d+)(?=[\s}]|$)/);
  return {
    activity: {
      packageName,
      activityName: component.startsWith(".") ? packageName + component : component,
      userId: Number(match[2]),
      taskId: task ? Number(task[1]) : -1,
    },
    priority: match[1] === "topResumedActivity" ? 3 : match[1] === "mResumedActivity" ? 2 : 1,
  };
}

/**
 * Select a resumed activity from the requested display's section. A global
 * resumed/focused line is accepted only in legacy output without display
 * sections; it cannot safely identify a display on a multi-display device.
 */
export function parseResumedActivityForDisplay(
  output: string,
  displayId: number = 0,
): DisplayResumedActivity {
  let currentDisplay: number | undefined;
  let displayCount = 0;
  let selected: ResumedActivity | undefined;
  let selectedPriority = -1;
  let legacy: ResumedActivity | undefined;

  for (const line of output.split(/\r?\n/)) {
    const display = line.match(DISPLAY_HEADER);
    if (display) {
      currentDisplay = Number(display[1]);
      displayCount++;
      continue;
    }
    // Display sections end at the next unindented dumpsys heading.
    if (/^\S/.test(line)) {
      currentDisplay = undefined;
    }
    const parsed = parseResumedLine(line);
    if (!parsed) {
      continue;
    }
    if (currentDisplay === undefined) {
      legacy ??= parsed.activity;
      continue;
    }
    if (currentDisplay !== displayId) {
      continue;
    }
    if (parsed.priority > selectedPriority) {
      selected = parsed.activity;
      selectedPriority = parsed.priority;
    }
  }

  return { activity: displayCount > 0 ? selected : legacy, displayCount };
}
