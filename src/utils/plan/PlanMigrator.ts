import { getMcpServerVersion, releaseVersion } from "../mcpVersion";

type MigrationWarning = {
  message: string;
  stepIndex?: number;
};

type PlanMigrationReport = {
  appliedMigrations: string[];
  warnings: MigrationWarning[];
  originalVersion: string;
  targetVersion: string;
  migrated: boolean;
  outdated: boolean;
};

export const parseVersion = (version: string | undefined): number[] | null => {
  if (!version || version === "unknown" || version === "latest") {
    return null;
  }
  // Dev builds stamp a git SHA as semver build metadata (`0.0.39+g<sha>[.dirty]`).
  // Strip it before parsing — otherwise the SHA's hex digits corrupt the patch
  // number and a `.dirty` suffix parses to NaN (→ always-outdated). Migration
  // only cares about the release portion.
  const numericParts = releaseVersion(version)
    .split(".")
    .map((part) => parseInt(part.replace(/\D/g, ""), 10));
  if (numericParts.some((part) => Number.isNaN(part))) {
    return null;
  }
  return numericParts.slice(0, 3);
};

export const isOlderVersion = (version: string | undefined, target: string): boolean => {
  const parsedVersion = parseVersion(version);
  const parsedTarget = parseVersion(target);
  if (!parsedVersion || !parsedTarget) {
    return true;
  }
  const length = Math.max(parsedVersion.length, parsedTarget.length);
  for (let i = 0; i < length; i++) {
    const current = parsedVersion[i] ?? 0;
    const targetPart = parsedTarget[i] ?? 0;
    if (current < targetPart) {
      return true;
    }
    if (current > targetPart) {
      return false;
    }
  }
  return false;
};

const isRecord = (value: unknown): value is Record<string, any> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isPlatform = (value: unknown): value is "android" | "ios" =>
  value === "android" || value === "ios";

const resolveStepPlatform = (
  params: Record<string, any>,
  planPlatform: unknown,
  planDevices: unknown,
): "android" | "ios" | undefined => {
  if (isPlatform(params.platform)) {
    return params.platform;
  }
  if (typeof params.device === "string" && Array.isArray(planDevices)) {
    const device = planDevices.find(
      (entry: unknown) => isRecord(entry) && entry.label === params.device,
    );
    if (isRecord(device) && isPlatform(device.platform)) {
      return device.platform;
    }
  }
  return isPlatform(planPlatform) ? planPlatform : undefined;
};

const recordWarning = (warnings: MigrationWarning[], message: string, stepIndex?: number): void => {
  warnings.push(stepIndex === undefined ? { message } : { message, stepIndex });
};

const ensureMetadata = (
  plan: Record<string, any>,
  warnings: MigrationWarning[],
): Record<string, any> => {
  if (!isRecord(plan.metadata)) {
    if (plan.metadata !== undefined) {
      recordWarning(warnings, "Plan metadata was not an object; resetting to defaults.");
    }
    plan.metadata = {};
  }
  return plan.metadata as Record<string, any>;
};

const migratePlanIdentity = (
  plan: Record<string, any>,
  metadata: Record<string, any>,
  warnings: MigrationWarning[],
): boolean => {
  let changed = false;
  if (!plan.name && typeof plan.planName === "string") {
    plan.name = plan.planName;
    delete plan.planName;
    recordWarning(warnings, "Renamed planName to name.");
    changed = true;
  }

  if (!plan.name && typeof metadata.name === "string") {
    plan.name = metadata.name;
    delete metadata.name;
    recordWarning(warnings, "Moved metadata.name to plan name.");
    changed = true;
  }

  if (!plan.description && typeof metadata.description === "string") {
    plan.description = metadata.description;
    delete metadata.description;
    recordWarning(warnings, "Moved metadata.description to plan description.");
    changed = true;
  }

  return changed;
};

const migrateLegacyPlanMetadata = (
  plan: Record<string, any>,
  metadata: Record<string, any>,
  warnings: MigrationWarning[],
): boolean => {
  let changed = false;
  if (typeof plan.generated === "string" && !metadata.createdAt) {
    metadata.createdAt = plan.generated;
    recordWarning(warnings, "Mapped generated timestamp to metadata.createdAt.");
    changed = true;
  }
  if (plan.generated !== undefined) {
    delete plan.generated;
    recordWarning(warnings, "Removed deprecated generated field.");
    changed = true;
  }

  if (typeof plan.appId === "string" && !metadata.appId) {
    metadata.appId = plan.appId;
    recordWarning(warnings, "Moved top-level appId to metadata.appId.");
    changed = true;
  }
  if (plan.appId !== undefined) {
    delete plan.appId;
    recordWarning(warnings, "Removed deprecated top-level appId field.");
    changed = true;
  }

  return changed;
};

const migratePlanVersionMetadata = (
  plan: Record<string, any>,
  metadata: Record<string, any>,
  warnings: MigrationWarning[],
): boolean => {
  let changed = false;
  if (typeof metadata.mcpVersion === "string" && !plan.mcpVersion) {
    plan.mcpVersion = metadata.mcpVersion;
    delete metadata.mcpVersion;
    recordWarning(warnings, "Moved metadata.mcpVersion to top-level mcpVersion.");
    changed = true;
  }

  if (typeof plan.mcpVersion !== "string" || !plan.mcpVersion) {
    plan.mcpVersion = "unknown";
    recordWarning(warnings, 'Defaulted missing mcpVersion to "unknown".');
    changed = true;
  }

  if (!metadata.createdAt) {
    metadata.createdAt = new Date().toISOString();
    recordWarning(warnings, "Defaulted missing metadata.createdAt.");
    changed = true;
  }

  if (!metadata.version) {
    metadata.version = "1.0.0";
    recordWarning(warnings, "Defaulted missing metadata.version to 1.0.0.");
    changed = true;
  }

  return changed;
};

const migratePlanFields = (plan: Record<string, any>, warnings: MigrationWarning[]): boolean => {
  const metadata = ensureMetadata(plan, warnings);
  let changed = migratePlanIdentity(plan, metadata, warnings);
  changed = migrateLegacyPlanMetadata(plan, metadata, warnings) || changed;
  changed = migratePlanVersionMetadata(plan, metadata, warnings) || changed;
  return changed;
};

const migrateInputTextParams = (
  mergedParams: Record<string, any>,
  stepIndex: number,
  warnings: MigrationWarning[],
  planPlatform: unknown,
  planDevices: unknown,
): void => {
  if (mergedParams.value !== undefined) {
    if (mergedParams.text === undefined) {
      mergedParams.text = mergedParams.value;
    }
    delete mergedParams.value;
    recordWarning(warnings, "Renamed inputText.value to text.", stepIndex);
  }

  const typeCommand: Record<string, unknown> = {
    action: "type",
    text: mergedParams.text,
    operation:
      resolveStepPlatform(mergedParams, planPlatform, planDevices) === "ios" ? "insert" : "replace",
  };
  delete mergedParams.text;
  if (mergedParams.mode !== undefined) {
    typeCommand.mode = mergedParams.mode;
    delete mergedParams.mode;
  }

  const commands: Array<Record<string, unknown>> = [typeCommand];
  if (mergedParams.imeAction !== undefined) {
    commands.push({ action: "key", key: mergedParams.imeAction });
    delete mergedParams.imeAction;
  }
  if (mergedParams.dismissKeyboard !== undefined) {
    delete mergedParams.dismissKeyboard;
    recordWarning(
      warnings,
      "Dropped inputText.dismissKeyboard during sendKeys migration; use the keyboard tool to dismiss it explicitly.",
      stepIndex,
    );
  }

  mergedParams.commands = commands;
  recordWarning(warnings, "Renamed inputText to sendKeys.", stepIndex);
};

const migrateToolName = (
  toolName: string,
  mergedParams: Record<string, any>,
  stepIndex: number,
  warnings: MigrationWarning[],
  planPlatform: unknown,
  planDevices: unknown,
): { normalizedTool: string; changed: boolean } => {
  let changed = false;
  let normalizedTool = toolName;
  if (toolName === "tapOnText") {
    normalizedTool = "tapOn";
    recordWarning(warnings, "Renamed tapOnText to tapOn.", stepIndex);
    changed = true;
  }
  if (toolName === "swipeOnScreen") {
    normalizedTool = "swipeOn";
    recordWarning(warnings, "Renamed swipeOnScreen to swipeOn.", stepIndex);
    if (mergedParams.autoTarget === undefined) {
      mergedParams.autoTarget = false;
      recordWarning(warnings, "Defaulted autoTarget=false for swipeOnScreen migration.", stepIndex);
    }
    changed = true;
  }
  if (toolName === "scroll") {
    normalizedTool = "swipeOn";
    recordWarning(warnings, "Renamed scroll to swipeOn.", stepIndex);
    if (!mergedParams.gestureType) {
      mergedParams.gestureType = "scrollTowardsDirection";
      recordWarning(
        warnings,
        "Defaulted gestureType=scrollTowardsDirection for scroll migration.",
        stepIndex,
      );
    }
    changed = true;
  }
  if (toolName === "inputText") {
    migrateInputTextParams(mergedParams, stepIndex, warnings, planPlatform, planDevices);
    normalizedTool = "sendKeys";
    changed = true;
  }
  if (toolName === "clearText") {
    normalizedTool = "sendKeys";
    mergedParams.commands = [{ action: "clear" }];
    recordWarning(warnings, "Renamed clearText to sendKeys.", stepIndex);
    changed = true;
  }
  if (toolName === "imeAction") {
    normalizedTool = "sendKeys";
    mergedParams.commands = [{ action: "key", key: mergedParams.action }];
    delete mergedParams.action;
    recordWarning(warnings, "Renamed imeAction to sendKeys.", stepIndex);
    changed = true;
  }

  return { normalizedTool, changed };
};

const migrateAppParams = (
  mergedParams: Record<string, any>,
  stepIndex: number,
  warnings: MigrationWarning[],
): boolean => {
  let changed = false;

  if (mergedParams.appId === undefined && typeof mergedParams.packageName === "string") {
    mergedParams.appId = mergedParams.packageName;
    delete mergedParams.packageName;
    recordWarning(warnings, "Renamed packageName to appId.", stepIndex);
    changed = true;
  }
  if (mergedParams.appId === undefined && typeof mergedParams.bundleId === "string") {
    mergedParams.appId = mergedParams.bundleId;
    delete mergedParams.bundleId;
    recordWarning(warnings, "Renamed bundleId to appId.", stepIndex);
    changed = true;
  }

  return changed;
};

const migrateTapParams = (
  mergedParams: Record<string, any>,
  stepIndex: number,
  warnings: MigrationWarning[],
): boolean => {
  let changed = false;

  if (!mergedParams.action) {
    mergedParams.action = "tap";
    recordWarning(warnings, "Defaulted tapOn.action to tap.", stepIndex);
    changed = true;
  }
  if (mergedParams.elementId === undefined && typeof mergedParams.id === "string") {
    mergedParams.elementId = mergedParams.id;
    delete mergedParams.id;
    recordWarning(warnings, "Renamed id to elementId for tapOn.", stepIndex);
    changed = true;
  }
  // Back-compat: tapOn's top-level { elementId } / { text } moved under `selector`
  // in v0.0.30 (see PR #2255 split of tapOn/tapAny). Wrap the legacy shape so plans
  // authored against 0.0.28-style schemas still validate.
  const selectorIsRecord = isRecord(mergedParams.selector);
  if (!selectorIsRecord) {
    const selector: Record<string, unknown> = {};
    if (typeof mergedParams.elementId === "string") {
      selector.elementId = mergedParams.elementId;
      delete mergedParams.elementId;
    }
    if (typeof mergedParams.text === "string") {
      selector.text = mergedParams.text;
      delete mergedParams.text;
    }
    if (Array.isArray(mergedParams.textAny)) {
      selector.textAny = mergedParams.textAny;
      delete mergedParams.textAny;
    }
    if (Object.keys(selector).length > 0) {
      mergedParams.selector = selector;
      recordWarning(
        warnings,
        "Wrapped legacy tapOn { elementId|text|textAny } under { selector: { ... } } for v0.0.30+ schema.",
        stepIndex,
      );
      changed = true;
    }
  }

  return changed;
};

const migrateLinkParams = (
  mergedParams: Record<string, any>,
  stepIndex: number,
  warnings: MigrationWarning[],
): boolean => {
  let changed = false;

  if (mergedParams.url === undefined && typeof mergedParams.link === "string") {
    mergedParams.url = mergedParams.link;
    delete mergedParams.link;
    recordWarning(warnings, "Renamed openLink.link to url.", stepIndex);
    changed = true;
  }

  return changed;
};

const migrateSwipeParams = (
  mergedParams: Record<string, any>,
  stepIndex: number,
  warnings: MigrationWarning[],
): boolean => {
  let changed = false;

  const container = isRecord(mergedParams.container) ? { ...mergedParams.container } : {};
  if (typeof mergedParams.containerElementId === "string" && !container.elementId) {
    container.elementId = mergedParams.containerElementId;
    delete mergedParams.containerElementId;
    recordWarning(warnings, "Renamed containerElementId to container.elementId.", stepIndex);
    changed = true;
  }
  if (typeof mergedParams.containerText === "string" && !container.text) {
    container.text = mergedParams.containerText;
    delete mergedParams.containerText;
    recordWarning(warnings, "Renamed containerText to container.text.", stepIndex);
    changed = true;
  }
  if (Object.keys(container).length > 0) {
    mergedParams.container = container;
  }
  changed = migrateSwipeDuration(mergedParams, stepIndex, warnings) || changed;
  if (mergedParams.scrollMode !== undefined) {
    delete mergedParams.scrollMode;
    recordWarning(warnings, "Removed deprecated scrollMode field.", stepIndex);
    changed = true;
  }

  return changed;
};

const migrateSystemTrayParams = (
  mergedParams: Record<string, any>,
  stepIndex: number,
  warnings: MigrationWarning[],
): boolean => {
  let changed = false;

  const notification = isRecord(mergedParams.notification) ? mergedParams.notification : undefined;
  if (
    notification &&
    typeof notification.timeout === "number" &&
    mergedParams.awaitTimeout === undefined
  ) {
    mergedParams.awaitTimeout = notification.timeout;
    delete notification.timeout;
    recordWarning(warnings, "Moved notification.timeout to awaitTimeout.", stepIndex);
    changed = true;
  }

  return changed;
};

const migrateObserveParams = (
  mergedParams: Record<string, any>,
  stepIndex: number,
  warnings: MigrationWarning[],
): boolean => {
  let changed = false;

  if (mergedParams.withViewHierarchy !== undefined) {
    delete mergedParams.withViewHierarchy;
    recordWarning(warnings, "Removed deprecated observe.withViewHierarchy field.", stepIndex);
    changed = true;
  }

  return changed;
};

const migrateSwipeDuration = (
  mergedParams: Record<string, any>,
  stepIndex: number,
  warnings: MigrationWarning[],
): boolean => {
  let changed = false;
  if (mergedParams.duration !== undefined) {
    if (!mergedParams.speed && typeof mergedParams.duration === "number") {
      mergedParams.speed =
        mergedParams.duration >= 800 ? "slow" : mergedParams.duration <= 250 ? "fast" : "normal";
      recordWarning(warnings, "Mapped swipe duration to speed.", stepIndex);
    }
    delete mergedParams.duration;
    recordWarning(warnings, "Removed deprecated swipe duration field.", stepIndex);
    changed = true;
  }
  return changed;
};

const migrateToolParams = (
  normalizedTool: string,
  mergedParams: Record<string, any>,
  stepIndex: number,
  warnings: MigrationWarning[],
): boolean => {
  if (["launchApp", "terminateApp", "crashApp", "stopApp"].includes(normalizedTool)) {
    return migrateAppParams(mergedParams, stepIndex, warnings);
  }

  if (normalizedTool === "tapOn") {
    return migrateTapParams(mergedParams, stepIndex, warnings);
  }

  if (normalizedTool === "openLink") {
    return migrateLinkParams(mergedParams, stepIndex, warnings);
  }

  if (normalizedTool === "swipeOn") {
    return migrateSwipeParams(mergedParams, stepIndex, warnings);
  }

  if (normalizedTool === "systemTray") {
    return migrateSystemTrayParams(mergedParams, stepIndex, warnings);
  }

  if (normalizedTool === "observe") {
    return migrateObserveParams(mergedParams, stepIndex, warnings);
  }

  return false;
};

const migrateStepMetadata = (
  step: Record<string, any>,
  stepIndex: number,
  warnings: MigrationWarning[],
): boolean => {
  let changed = false;

  if (!step.tool && typeof step.command === "string") {
    step.tool = step.command;
    delete step.command;
    recordWarning(warnings, "Renamed command to tool.", stepIndex);
    changed = true;
  }
  if (step.command !== undefined) {
    delete step.command;
    recordWarning(warnings, "Removed deprecated command field.", stepIndex);
    changed = true;
  }

  if (typeof step.description === "string" && !step.label) {
    step.label = step.description;
    recordWarning(warnings, "Mapped step description to label.", stepIndex);
    changed = true;
  }
  if (step.description !== undefined) {
    delete step.description;
    recordWarning(warnings, "Removed deprecated step description field.", stepIndex);
    changed = true;
  }

  return changed;
};

const migrateStepFields = (
  step: Record<string, any>,
  stepIndex: number,
  warnings: MigrationWarning[],
  planPlatform: unknown,
  planDevices: unknown,
): boolean => {
  let changed = migrateStepMetadata(step, stepIndex, warnings);

  const toolName = step.tool;
  if (typeof toolName !== "string") {
    return changed;
  }

  const paramsFromStep = isRecord(step.params) ? { ...step.params } : {};
  const inlineParams: Record<string, any> = {};
  for (const [key, value] of Object.entries(step)) {
    // Keep step-level keys (not tool params) at the step level. `optional` must survive migration —
    // importPlanFromYaml runs migratePlan() before PlanNormalizer, so moving it into params here
    // would strip the flag before the executor sees it, making a best-effort step mandatory (#2853).
    // `expectations` is likewise a plan-step field: as a tool param a strict schema rejects the
    // step (#9925). PlanNormalizer keeps it off `params` and the executor warns it is unevaluated.
    if (["tool", "command", "label", "params", "optional", "expectations"].includes(key)) {
      continue;
    }
    inlineParams[key] = value;
    delete step[key];
    changed = true;
  }
  const mergedParams = { ...inlineParams, ...paramsFromStep };

  const migratedTool = migrateToolName(
    toolName,
    mergedParams,
    stepIndex,
    warnings,
    planPlatform,
    planDevices,
  );
  const normalizedTool = migratedTool.normalizedTool;
  changed = migratedTool.changed || changed;

  step.tool = normalizedTool;

  changed = migrateToolParams(normalizedTool, mergedParams, stepIndex, warnings) || changed;

  step.params = mergedParams;

  return changed;
};

export const migratePlan = (
  rawPlan: unknown,
): { plan: Record<string, any>; report: PlanMigrationReport } => {
  if (!isRecord(rawPlan)) {
    throw new Error("Plan is not a valid object");
  }

  const warnings: MigrationWarning[] = [];
  const plan = rawPlan;
  const targetVersion = getMcpServerVersion();
  const originalVersion =
    typeof plan.mcpVersion === "string"
      ? plan.mcpVersion
      : typeof plan.metadata?.mcpVersion === "string"
        ? plan.metadata.mcpVersion
        : "unknown";
  const outdated = isOlderVersion(originalVersion, targetVersion);

  let migrated = false;
  const appliedMigrations: string[] = [];

  const planChanged = migratePlanFields(plan, warnings);
  if (planChanged) {
    appliedMigrations.push("plan-fields");
    migrated = true;
  }

  if (Array.isArray(plan.steps)) {
    let stepsChanged = false;
    plan.steps = plan.steps.map((step, index) => {
      if (!isRecord(step)) {
        return step;
      }
      const stepChanged = migrateStepFields(step, index, warnings, plan.platform, plan.devices);
      stepsChanged = stepsChanged || stepChanged;
      return step;
    });
    if (stepsChanged) {
      appliedMigrations.push("step-fields");
      migrated = true;
    }
  }

  return {
    plan,
    report: {
      appliedMigrations,
      warnings,
      originalVersion,
      targetVersion,
      migrated,
      outdated,
    },
  };
};
