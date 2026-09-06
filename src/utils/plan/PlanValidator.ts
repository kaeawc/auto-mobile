import { Plan } from "../../models/Plan";
import { ActionableError } from "../../models";
import { normalizePlanDevices } from "./PlanDevices";

/**
 * Validates a plan structure and enforces multi-device rules.
 */
export class PlanValidator {
  // Tools that don't require device labels (exceptions to the rule).
  // criticalSection is intentionally NOT here: every criticalSection step
  // must target a specific device, just like any other tool.
  private static readonly DEVICE_AGNOSTIC_TOOLS = new Set<string>();

  /**
   * Validates a plan and throws ActionableError if invalid.
   * @param plan Plan to validate
   * @throws ActionableError if validation fails
   */
  static validate(plan: Plan): void {
    // Validate basic structure
    if (!plan.name || typeof plan.name !== "string") {
      throw new ActionableError("Plan must have a valid name");
    }

    if (!plan.steps || !Array.isArray(plan.steps)) {
      throw new ActionableError("Plan must have a steps array");
    }

    // Validate multi-device requirements
    this.validateMultiDeviceRequirements(plan);

    // Validate devices field if present
    if (plan.devices !== undefined) {
      this.validateDevicesField(plan);
      this.validateDeviceLabelsPresent(plan);
    }

    // Validate cross-step consistency for criticalSection/barrier locks. Runs
    // even when devices aren't declared so callers get a useful error rather
    // than a deadlock at runtime.
    this.validateCoordinationLocks(plan);
  }

  /**
   * Validates the devices field structure.
   */
  private static validateDevicesField(plan: Plan): void {
    if (!Array.isArray(plan.devices)) {
      throw new ActionableError("Plan 'devices' field must be an array of device labels");
    }

    if (plan.devices.length === 0) {
      throw new ActionableError(
        "Plan 'devices' array cannot be empty. Remove the field or specify at least one device.",
      );
    }

    const { labels, definitions, hasDefinitions, hasLabels } = normalizePlanDevices(plan.devices);

    if (hasDefinitions && hasLabels) {
      throw new ActionableError(
        "Plan 'devices' must be a list of labels or a list of objects with label/platform (do not mix formats).",
      );
    }

    if (hasDefinitions) {
      for (const device of definitions) {
        if (!device.label || device.label.trim() === "") {
          throw new ActionableError(
            `Invalid device label: ${JSON.stringify(device.label)}. Device labels must be non-empty strings.`,
          );
        }
        if (!device.platform || (device.platform !== "android" && device.platform !== "ios")) {
          throw new ActionableError(
            `Invalid device platform for ${device.label}: ${JSON.stringify(device.platform)}.`,
          );
        }
      }
    }

    if (labels.length !== plan.devices.length) {
      throw new ActionableError(
        "Plan 'devices' entries must be strings or objects with label/platform.",
      );
    }

    const uniqueDevices = new Set(labels);
    if (uniqueDevices.size !== labels.length) {
      throw new ActionableError(
        `Plan 'devices' array contains duplicate labels: [${labels.join(", ")}]`,
      );
    }

    for (const device of labels) {
      if (typeof device !== "string" || device.trim() === "") {
        throw new ActionableError(
          `Invalid device label: ${JSON.stringify(device)}. Device labels must be non-empty strings.`,
        );
      }
    }
  }

  /**
   * Validates that every step has a device label when the devices field is
   * present. criticalSection follows the same rule for its outer step, and
   * additionally every nested sub-step inside a criticalSection must declare
   * a device — there is no routing fallback inside the barrier, so an
   * undefined target would silently execute on the wrong device.
   */
  private static validateDeviceLabelsPresent(plan: Plan): void {
    if (!plan.devices || plan.devices.length === 0) {
      return;
    }

    const deviceSet = new Set(normalizePlanDevices(plan.devices).labels);
    const missingLabels: Array<{ index: number; tool: string }> = [];
    const invalidLabels: Array<{ index: number; tool: string; device: string }> = [];
    const missingInCriticalSection: Array<{
      parentIndex: number;
      subIndex: number;
      tool: string;
    }> = [];
    const invalidInCriticalSection: Array<{
      parentIndex: number;
      subIndex: number;
      tool: string;
      device: string;
    }> = [];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];

      // Skip any device-agnostic tools (currently none — criticalSection is
      // intentionally treated like any other device-targeted tool).
      if (this.DEVICE_AGNOSTIC_TOOLS.has(step.tool)) {
        continue;
      }

      // Every step must declare a device, including criticalSection.
      const device = step.params?.device;
      if (device === undefined || device === null || device === "") {
        missingLabels.push({ index: i, tool: step.tool });
      } else if (!deviceSet.has(device)) {
        invalidLabels.push({ index: i, tool: step.tool, device });
      }

      // Additionally, criticalSection sub-steps must each declare a device.
      if (step.tool === "criticalSection") {
        const subSteps = step.params?.steps;
        if (Array.isArray(subSteps)) {
          for (let j = 0; j < subSteps.length; j++) {
            const sub = subSteps[j];
            if (!sub || typeof sub !== "object") {
              continue;
            }
            const subParams = (sub as { params?: Record<string, unknown> }).params;
            const subDevice = subParams?.device;
            const subTool = String((sub as { tool?: unknown }).tool ?? "unknown");

            if (subDevice === undefined || subDevice === null || subDevice === "") {
              missingInCriticalSection.push({
                parentIndex: i,
                subIndex: j,
                tool: subTool,
              });
            } else if (typeof subDevice !== "string" || !deviceSet.has(subDevice)) {
              invalidInCriticalSection.push({
                parentIndex: i,
                subIndex: j,
                tool: subTool,
                device: String(subDevice),
              });
            }
          }
        }
      }
    }

    // Report all validation errors
    const errors: string[] = [];

    if (missingLabels.length > 0) {
      const steps = missingLabels.map((m) => `step ${m.index} (${m.tool})`).join(", ");
      errors.push(
        `Plan declares 'devices' field but the following steps are missing 'device' parameter: ${steps}`,
      );
    }

    if (invalidLabels.length > 0) {
      const steps = invalidLabels
        .map((m) => `step ${m.index} (${m.tool}): device="${m.device}"`)
        .join(", ");
      errors.push(
        `Plan declares devices [${Array.from(deviceSet).join(", ")}] but the following steps use invalid device labels: ${steps}`,
      );
    }

    if (missingInCriticalSection.length > 0) {
      const steps = missingInCriticalSection
        .map((m) => `step ${m.parentIndex}.steps[${m.subIndex}] (${m.tool})`)
        .join(", ");
      errors.push(
        `Every step inside a criticalSection must declare a 'device' parameter, but the following sub-steps are missing it: ${steps}`,
      );
    }

    if (invalidInCriticalSection.length > 0) {
      const steps = invalidInCriticalSection
        .map((m) => `step ${m.parentIndex}.steps[${m.subIndex}] (${m.tool}): device="${m.device}"`)
        .join(", ");
      errors.push(
        `Plan declares devices [${Array.from(deviceSet).join(", ")}] but the following criticalSection sub-steps use invalid device labels: ${steps}`,
      );
    }

    if (errors.length > 0) {
      throw new ActionableError(errors.join("\n"));
    }
  }

  /**
   * Validates coordination-tool params: criticalSection's cross-step lock
   * consistency (a lock is entered at most once per plan), and barrier's
   * own per-step params.
   */
  private static validateCoordinationLocks(plan: Plan): void {
    this.validateCriticalSectionLocks(plan);
    this.validateBarrierParams(plan);
  }

  /**
   * Validates that every criticalSection lock has a consistent contract
   * across the steps that share it:
   *   - All steps sharing a lock declare the same deviceCount.
   *   - The number of steps sharing a lock equals that deviceCount (otherwise
   *     the section will deadlock waiting for a device that never arrives).
   *   - Each participating step targets a distinct device (no device can
   *     enter the same lock twice — it would re-acquire and deadlock).
   *
   * Unlike barrier, a criticalSection lock is a single-use rendezvous within
   * a plan, so every occurrence of a given lock name is validated together.
   *
   * These checks catch coordination bugs at validation time instead of
   * surfacing them as a 30-second timeout at runtime.
   */
  private static validateCriticalSectionLocks(plan: Plan): void {
    interface LockOccurrence {
      stepIndex: number;
      device: unknown;
      deviceCount: unknown;
    }
    const lockUsage = new Map<string, LockOccurrence[]>();

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (step.tool !== "criticalSection") {
        continue;
      }
      const params = step.params;
      if (!params || typeof params !== "object") {
        continue;
      }
      const lock = (params as { lock?: unknown }).lock;
      if (typeof lock !== "string" || lock.length === 0) {
        // Schema-level requirements are validated elsewhere; skip silently.
        continue;
      }
      const occurrences = lockUsage.get(lock) ?? [];
      occurrences.push({
        stepIndex: i,
        device: (params as { device?: unknown }).device,
        deviceCount: (params as { deviceCount?: unknown }).deviceCount,
      });
      lockUsage.set(lock, occurrences);
    }

    const errors: string[] = [];

    for (const [lock, occurrences] of lockUsage.entries()) {
      const deviceCounts = new Set(
        occurrences.map((o) => o.deviceCount).filter((c) => typeof c === "number"),
      );

      if (deviceCounts.size > 1) {
        const detail = occurrences
          .map((o) => `step ${o.stepIndex} deviceCount=${String(o.deviceCount)}`)
          .join(", ");
        errors.push(
          `criticalSection lock "${lock}" has inconsistent deviceCount values: ${detail}. All steps sharing a lock must declare the same deviceCount.`,
        );
        continue;
      }

      const declaredCount =
        deviceCounts.size === 1 ? (deviceCounts.values().next().value as number) : undefined;

      if (declaredCount !== undefined && occurrences.length !== declaredCount) {
        errors.push(
          `criticalSection lock "${lock}" declares deviceCount=${declaredCount} but ${occurrences.length} step${occurrences.length === 1 ? "" : "s"} reference${occurrences.length === 1 ? "s" : ""} it. Every participating device needs its own criticalSection step with this lock.`,
        );
      }

      const devicesSeen = new Map<string, number[]>();
      for (const o of occurrences) {
        if (typeof o.device !== "string" || o.device.length === 0) {
          continue;
        }
        const list = devicesSeen.get(o.device) ?? [];
        list.push(o.stepIndex);
        devicesSeen.set(o.device, list);
      }
      for (const [device, indices] of devicesSeen.entries()) {
        if (indices.length > 1) {
          errors.push(
            `criticalSection lock "${lock}" is entered twice by device "${device}" (steps ${indices.join(", ")}). Each device can participate in a given lock at most once.`,
          );
        }
      }
    }

    if (errors.length > 0) {
      throw new ActionableError(errors.join("\n"));
    }
  }

  /**
   * Validates each barrier step's own params (required `lock`, required
   * positive-integer `deviceCount`) — the same per-step param parity
   * criticalSection gets.
   *
   * Unlike criticalSection, a barrier lock name is meant to be reused across
   * multiple synchronization rounds within a plan (the runtime coordinator,
   * CriticalSectionCoordinator.waitAtBarrier, clears its arrival set once a
   * round's deviceCount is reached). Rounds aren't explicitly delineated in
   * plan YAML, so this deliberately does NOT try to statically reconstruct
   * them or validate arrival counts across steps — that would require
   * inferring round boundaries from step order, which is unsound when
   * successive rounds use different device sets. Cross-round arrival-count
   * consistency is left to the runtime coordinator, which already matches
   * arrivals per round at execution time.
   */
  private static validateBarrierParams(plan: Plan): void {
    const errors: string[] = [];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (step.tool !== "barrier") {
        continue;
      }
      const params = step.params;
      if (!params || typeof params !== "object") {
        errors.push(`barrier step ${i} is missing its params object.`);
        continue;
      }

      const lock = (params as { lock?: unknown }).lock;
      if (typeof lock !== "string" || lock.length === 0) {
        errors.push(`barrier step ${i} is missing a non-empty 'lock' parameter.`);
      }

      const deviceCount = (params as { deviceCount?: unknown }).deviceCount;
      if (typeof deviceCount !== "number" || !Number.isInteger(deviceCount) || deviceCount < 1) {
        errors.push(
          `barrier step ${i} must declare a positive integer 'deviceCount', got ${JSON.stringify(deviceCount)}.`,
        );
      }
    }

    if (errors.length > 0) {
      throw new ActionableError(errors.join("\n"));
    }
  }

  /**
   * Checks if a plan uses multi-device features (devices field or device labels).
   * This determines if the plan requires the devices field to be declared.
   */
  static hasMultiDeviceFeatures(plan: Plan): boolean {
    // Check if devices field is present
    if (plan.devices && plan.devices.length > 0) {
      return true;
    }

    // Check if any step uses device parameter or criticalSection/barrier
    for (const step of plan.steps) {
      if (step.tool === "criticalSection" || step.tool === "barrier") {
        return true;
      }
      if (step.params?.device !== undefined) {
        return true;
      }
    }

    return false;
  }

  /**
   * Validates that if a plan uses multi-device features, it must declare devices.
   */
  static validateMultiDeviceRequirements(plan: Plan): void {
    const hasFeatures = this.hasMultiDeviceFeatures(plan);

    // If plan uses device labels or criticalSection/barrier, it must declare devices
    if (hasFeatures && (!plan.devices || plan.devices.length === 0)) {
      throw new ActionableError(
        "Plan uses multi-device features (device labels or criticalSection/barrier) but does not declare 'devices' field. " +
          "Add a 'devices' array at the top level of your plan.",
      );
    }
  }
}
