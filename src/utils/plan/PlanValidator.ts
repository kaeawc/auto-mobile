import { Plan, PlanStep } from "../../models/Plan";
import { ActionableError } from "../../models";
import { normalizePlanDevices } from "./PlanDevices";

/**
 * Aggregated usage of a single barrier lock name across a plan, used by the
 * coordination checks below.
 */
interface BarrierLockUsage {
  devices: Set<string>;
  deviceCounts: Set<number>;
  arrivals: number;
  // Per-device occurrence count, used to catch a device scheduled more times
  // than there are generations for it to participate in.
  deviceOccurrences: Map<string, number>;
}

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

      // Every step must declare a device, including criticalSection. Uses
      // effectiveField (not a raw params read) so an inline-form barrier
      // step -- lock/deviceCount/device sitting directly on the step rather
      // than nested under params -- is resolved correctly instead of
      // reporting a spurious missing-device error (#6215 review).
      const device = this.effectiveField(step, "device");
      if (device === undefined || device === null || device === "") {
        missingLabels.push({ index: i, tool: step.tool });
      } else if (typeof device !== "string" || !deviceSet.has(device)) {
        invalidLabels.push({ index: i, tool: step.tool, device: String(device) });
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
   * Resolves the effective value of a coordination field (`lock`/`device`/
   * `deviceCount`) for a step, honoring PlanNormalizer's params-wins
   * precedence: when a field is present under `params`, that value wins even
   * if a different value also sits inline on the step — PlanNormalizer's
   * `{ ...inlineParams, ...paramsFromStep }` merge discards the inline one at
   * normalization, the same precedence the #6090/#6107 networkCondition/
   * doNotDisturb inline-vs-params handling established. Falling back to the
   * inline value only when `params` doesn't declare the field also keeps this
   * correct for a step that reaches this validator before normalization.
   */
  private static effectiveField(step: PlanStep, field: string): unknown {
    const params = step.params;
    if (
      params &&
      typeof params === "object" &&
      Object.prototype.hasOwnProperty.call(params, field)
    ) {
      return (params as Record<string, unknown>)[field];
    }
    // A step reaching this validator before PlanNormalizer runs may carry
    // coordination fields as plain siblings of `tool`/`params` -- outside
    // PlanStep's declared shape, but present on the underlying object.
    // oxlint-disable-next-line auto-mobile/no-unknown-cast
    const inlineFields = step as unknown as Record<string, unknown>;
    return inlineFields[field];
  }

  /**
   * Validates coordination-tool params: criticalSection's cross-step lock
   * consistency (a lock is entered at most once per plan), and barrier's
   * own per-step params.
   */
  private static validateCoordinationLocks(plan: Plan): void {
    this.validateCriticalSectionLocks(plan);
    this.validateBarrierParams(plan);
    this.validateNoCrossToolLockSharing(plan);
    this.validateBarrierConsistentDeviceCount(plan);
    this.validateBarrierDistinctDeviceCounts(plan);
    this.validateBarrierGenerationCompleteness(plan);
    this.validateBarrierExcessDeviceArrivals(plan);
  }

  /**
   * Validates that no lock name is shared between a criticalSection step
   * and a barrier step. Both tools share the runtime coordinator's lock
   * namespace and expected-device-count state (CriticalSectionCoordinator
   * keys both by the same lock name), so mixing tool types on one lock name
   * is racy: e.g. a criticalSection A/B pair and a barrier C/D pair both
   * using lock "shared" with deviceCount=2 can pair A with C instead of the
   * intended A-with-B / C-with-D, and cross-tool arrivals can overwrite each
   * other's expected count. Each tool type must use a distinct lock name.
   */
  private static validateNoCrossToolLockSharing(plan: Plan): void {
    const criticalSectionLocks = new Set<string>();
    const barrierLocks = new Set<string>();

    for (const step of plan.steps) {
      if (step.tool !== "criticalSection" && step.tool !== "barrier") {
        continue;
      }
      const lock = this.effectiveField(step, "lock");
      if (typeof lock !== "string" || lock.length === 0) {
        continue;
      }
      (step.tool === "criticalSection" ? criticalSectionLocks : barrierLocks).add(lock);
    }

    const shared = Array.from(criticalSectionLocks).filter((lock) => barrierLocks.has(lock));
    if (shared.length > 0) {
      throw new ActionableError(
        `lock name${shared.length === 1 ? "" : "s"} ${shared.map((l) => `"${l}"`).join(", ")} ${shared.length === 1 ? "is" : "are"} used by both a criticalSection step and a barrier step. Both tools share the runtime coordinator's lock namespace and expected-count state, so mixing tool types on the same lock name is racy and can pair mismatched participants or overwrite the expected count. Use a distinct lock name per tool type.`,
      );
    }
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
      const lock = this.effectiveField(step, "lock");
      if (typeof lock !== "string" || lock.length === 0) {
        // Schema-level requirements are validated elsewhere; skip silently.
        continue;
      }
      const occurrences = lockUsage.get(lock) ?? [];
      occurrences.push({
        stepIndex: i,
        device: this.effectiveField(step, "device"),
        deviceCount: this.effectiveField(step, "deviceCount"),
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

  // ---------------------------------------------------------------------
  // Barrier coordination checks below enforce NECESSARY conditions for a
  // barrier plan to be executable — they do not prove full deadlock-freedom.
  // Specifically NOT checked (tracked in issue #6231):
  //   - Generation-boundary stranding within one lock: e.g. deviceCount=3
  //     with arrivals A,A/B,B/C/D passes every check below (4 distinct
  //     devices, 6 arrivals divisible by 3, no device exceeds its 2-generation
  //     budget), but if A/C/D happen to complete generation 1 first, B's two
  //     arrivals can never both be scheduled into the same generation and it
  //     deadlocks. Proving this requires reasoning about which subsets of
  //     arrivals can complete each generation — a scheduling-feasibility
  //     problem, not a simple count check.
  //   - Cross-lock ordering cycles: device A doing barrier(X) then
  //     barrier(Y), and device B doing barrier(Y) then barrier(X), with both
  //     locks needing exactly {A, B} — A blocks at X waiting for B, B blocks
  //     at Y waiting for A. Every per-lock check below passes because each
  //     lock individually has enough distinct arrivals and no device exceeds
  //     its generation budget. A sound version of this check is possible but
  //     only for locks with zero population slack (evaluated and deferred
  //     during the #6215 review — see issue #6231 for why).
  // ---------------------------------------------------------------------

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

      const lock = this.effectiveField(step, "lock");
      if (typeof lock !== "string" || lock.length === 0) {
        errors.push(`barrier step ${i} is missing a non-empty 'lock' parameter.`);
      }

      const deviceCount = this.effectiveField(step, "deviceCount");
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
   * Validates that every barrier lock is populated by enough distinct devices
   * to ever satisfy its declared `deviceCount`.
   *
   * This is sound WITHOUT reconstructing rounds: a single round needs
   * `deviceCount` distinct device arrivals, so if fewer distinct devices ever
   * target a given lock across the whole plan, no round can ever complete —
   * regardless of how many times those devices arrive (reused across
   * rounds). This mirrors the intent of criticalSection's cross-step lock
   * check without inferring round boundaries.
   */
  private static validateBarrierDistinctDeviceCounts(plan: Plan): void {
    const usageByLock = this.collectBarrierLockUsage(plan);
    const errors: string[] = [];

    for (const [lock, usage] of usageByLock.entries()) {
      for (const deviceCount of usage.deviceCounts) {
        if (usage.devices.size < deviceCount) {
          const devices = Array.from(usage.devices).join(", ") || "none";
          errors.push(
            `barrier lock "${lock}" declares deviceCount=${deviceCount} but only ${usage.devices.size} distinct device${usage.devices.size === 1 ? "" : "s"} (${devices}) ever target it in this plan. No round can ever complete.`,
          );
        }
      }
    }

    if (errors.length > 0) {
      throw new ActionableError(errors.join("\n"));
    }
  }

  /**
   * Validates that a reused barrier lock declares the same `deviceCount`
   * every time it's used.
   *
   * The runtime coordinator (CriticalSectionCoordinator) keys a single
   * shared expected-device-count per lock name: every arrival's
   * `registerExpectedDevices` call overwrites it, so whichever arrival
   * happens to run last wins. Mixed-count reuse of the same lock therefore
   * makes whether the barrier ever releases depend on arrival order — it
   * can deadlock to the barrier timeout nondeterministically. A plan that
   * legitimately wants different participant counts per phase must use a
   * distinct lock name per count instead.
   */
  private static validateBarrierConsistentDeviceCount(plan: Plan): void {
    const usageByLock = this.collectBarrierLockUsage(plan);
    const errors: string[] = [];

    for (const [lock, usage] of usageByLock.entries()) {
      if (usage.deviceCounts.size <= 1) {
        continue;
      }
      const counts = Array.from(usage.deviceCounts)
        .sort((a, b) => a - b)
        .join(", ");
      errors.push(
        `barrier lock "${lock}" is reused with inconsistent deviceCount values (${counts}). The runtime coordinator keeps a single shared expected count per lock name, so mixed-count reuse is racy and can deadlock depending on arrival order. Use a distinct lock name for each deviceCount instead.`,
      );
    }

    if (errors.length > 0) {
      throw new ActionableError(errors.join("\n"));
    }
  }

  /**
   * Validates that a reused barrier lock's total arrivals form complete
   * generations, catching a class of deadlock the distinct-device check
   * above cannot: e.g. arrivals A, B, A with deviceCount=2 has 2 distinct
   * devices (passes that check) but the 3rd (trailing) arrival starts a new
   * generation that only ever gets 1 of the 2 devices it needs, so it waits
   * forever.
   *
   * Sound WITHOUT reconstructing rounds: only meaningful when a lock has a
   * single consistent deviceCount N (validateBarrierConsistentDeviceCount
   * already rejects a lock with more than one, so this defensively skips
   * that case too rather than picking an arbitrary N). For that N, the
   * total number of barrier steps referencing the lock must be an exact
   * multiple of N: each generation consumes exactly N arrivals, so a
   * non-multiple total necessarily leaves an incomplete trailing generation
   * that can never complete. This never false-rejects a valid plan.
   */
  private static validateBarrierGenerationCompleteness(plan: Plan): void {
    const usageByLock = this.collectBarrierLockUsage(plan);
    const errors: string[] = [];

    for (const [lock, usage] of usageByLock.entries()) {
      if (usage.deviceCounts.size !== 1) {
        continue;
      }
      const deviceCount = usage.deviceCounts.values().next().value as number;
      if (deviceCount < 1 || usage.arrivals % deviceCount === 0) {
        continue;
      }
      errors.push(
        `barrier lock "${lock}" has ${usage.arrivals} total arrival${usage.arrivals === 1 ? "" : "s"} across the plan, which is not a multiple of its deviceCount=${deviceCount}. At least one generation is necessarily incomplete and would deadlock waiting for a device that never arrives.`,
      );
    }

    if (errors.length > 0) {
      throw new ActionableError(errors.join("\n"));
    }
  }

  /**
   * Validates that no single device is scheduled to arrive at a barrier lock
   * more times than there are generations for it to participate in.
   *
   * PlanPartitioner executes each device's track sequentially, so a device
   * can only ever occupy one "slot" per generation — it cannot re-enter the
   * same lock a second time within a generation it's already part of. For a
   * lock with a single consistent deviceCount N and T total arrivals (T
   * divisible by N, per validateBarrierGenerationCompleteness), there are
   * G = T / N generations available in total. A device appearing more than G
   * times can never be scheduled into a generation it hasn't already used,
   * so it deadlocks waiting at an arrival no generation will ever admit.
   *
   * Sound: a device appearing at most G times is exactly the necessary
   * condition for a feasible one-arrival-per-generation assignment to exist
   * (e.g. A,A,B,B with deviceCount=2 has G=2 and each device appears
   * exactly 2 times — feasible, and correctly accepted).
   */
  private static validateBarrierExcessDeviceArrivals(plan: Plan): void {
    const usageByLock = this.collectBarrierLockUsage(plan);
    const errors: string[] = [];

    for (const [lock, usage] of usageByLock.entries()) {
      if (usage.deviceCounts.size !== 1) {
        continue;
      }
      const deviceCount = usage.deviceCounts.values().next().value as number;
      if (deviceCount < 1 || usage.arrivals % deviceCount !== 0) {
        // Inconsistent-count and incomplete-generation cases are already
        // reported by the other checks; skip here to avoid a meaningless G.
        continue;
      }
      const generations = usage.arrivals / deviceCount;

      for (const [device, occurrences] of usage.deviceOccurrences.entries()) {
        if (occurrences <= generations) {
          continue;
        }
        errors.push(
          `barrier lock "${lock}" has ${generations} generation${generations === 1 ? "" : "s"} available (deviceCount=${deviceCount}, ${usage.arrivals} total arrivals), but device "${device}" arrives ${occurrences} times. A device can participate in a lock at most once per generation, since each device's track executes sequentially, so this device would deadlock waiting for a generation that never admits it again.`,
        );
      }
    }

    if (errors.length > 0) {
      throw new ActionableError(errors.join("\n"));
    }
  }

  private static collectBarrierLockUsage(plan: Plan): Map<string, BarrierLockUsage> {
    const usageByLock = new Map<string, BarrierLockUsage>();

    for (const step of plan.steps) {
      if (step.tool === "barrier") {
        this.recordBarrierLockUsage(usageByLock, step);
      }
    }

    return usageByLock;
  }

  private static recordBarrierLockUsage(
    usageByLock: Map<string, BarrierLockUsage>,
    step: PlanStep,
  ): void {
    const lock = this.effectiveField(step, "lock");
    if (typeof lock !== "string" || lock.length === 0) {
      return;
    }

    const usage = usageByLock.get(lock) ?? {
      devices: new Set<string>(),
      deviceCounts: new Set<number>(),
      arrivals: 0,
      deviceOccurrences: new Map<string, number>(),
    };
    usage.arrivals += 1;

    const device = this.effectiveField(step, "device");
    if (typeof device === "string" && device.length > 0) {
      usage.devices.add(device);
      usage.deviceOccurrences.set(device, (usage.deviceOccurrences.get(device) ?? 0) + 1);
    }

    const deviceCount = this.effectiveField(step, "deviceCount");
    if (typeof deviceCount === "number" && Number.isInteger(deviceCount) && deviceCount >= 1) {
      usage.deviceCounts.add(deviceCount);
    }

    usageByLock.set(lock, usage);
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
