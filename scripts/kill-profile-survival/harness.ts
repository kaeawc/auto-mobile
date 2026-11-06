import type { BootedDevice } from "../../src/models";
import { applyKillProfile, resetKillProfile } from "../../src/features/utility/ApplyKillProfile";
import {
  DeviceClockRestoreRegistry,
  writeDeviceClock,
  type DeviceClockAdapter,
  type DeviceClockDependencies,
} from "../../src/features/utility/DeviceClock";
import {
  EXPECTED_SCORES_API_LEVEL,
  KILL_PROFILE_EXPECTED_SCORES,
  SURVIVAL_EVENT_IDS,
  type ExpectedSurvivalScore,
  type SurvivalEventId,
} from "../../src/features/utility/KillProfileExpectedScores";
import { KillProfileRestoreRegistry } from "../../src/features/utility/KillProfileRestore";
import type { KillProfile, KillProfileId } from "../../src/features/utility/KillProfiles";
import type { AdbCommandRunner } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "../../src/utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import {
  outputLooksLikeShellFailure,
  packageListingContains,
} from "../../src/utils/android-cmdline-tools/shellOutputHeuristics";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { shellQuote } from "../../src/utils/shellQuote";
import type { Timer } from "../../src/utils/SystemTimer";
import { FIXTURE_PACKAGE, scoringWindow, SURVIVAL_MATRIX } from "./matrix";
import {
  CLOCK_ADVANCE_MS,
  FOREGROUND_HEARTBEAT_MS,
  PRIMARY_WINDOW_MS,
  RECOVERY_WINDOW_MS,
  parseEvents,
  scoreEvents,
  type ScoringWindow,
  type SurvivalScore,
} from "./score";

/** Readiness is polled, never guessed from a launch command finishing. */
const READY_TIMEOUT_MS = 30_000;
const POLL_MS = 1_000;

export interface HarnessDeps {
  shell: AdbCommandRunner;
  clock: DeviceClockAdapter;
  timer: Pick<Timer, "now" | "sleep">;
  /** Cancellation stops observation; cleanup deliberately runs without this signal. */
  signal?: AbortSignal;
}

export interface SurvivalResult {
  profileId: KillProfile["id"];
  version: number;
  window: ScoringWindow;
  rawLog: string;
  score: SurvivalScore;
  expectedScore: ExpectedSurvivalScore;
  mismatches: SurvivalEventId[];
  pendingMeasurement: SurvivalEventId[];
}

export interface SurvivalReport {
  serial: string;
  avd: string;
  /** BOOT_COMPLETED is delivered synthetically by rooted adb; this does not test a real reboot. */
  bootProbe: "root-broadcast-excluding-stopped-packages";
  challenge: { primaryMs: number; recoveryMs: number; clockAdvanceMs: number; doze: true };
  results: SurvivalResult[];
  /** Set when the device API differs from the one the expected scores were measured on. */
  noBaseline?: string;
  aborted?: string;
}

/** Expected scores are only valid on the API they were measured on; elsewhere nothing is compared. */
function withBaseline(result: SurvivalResult, api: number): SurvivalResult {
  if (api === EXPECTED_SCORES_API_LEVEL) {
    return result;
  }
  return { ...result, mismatches: [], pendingMeasurement: [...SURVIVAL_EVENT_IDS] };
}

export async function checkedCommand(shell: AdbCommandRunner, command: string): Promise<string> {
  const result = await shell.executeCommand(command, { noRetry: true, timeoutMs: 60_000 });
  if (result.error || outputLooksLikeShellFailure(result.stdout, result.stderr)) {
    throw new Error(`adb ${command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function waitReady(deps: HarnessDeps): Promise<number> {
  const deadline = deps.timer.now() + READY_TIMEOUT_MS;
  const read =
    "if test -f files/survival-error; then cat files/survival-error >&2; exit 1; fi; " +
    "if test -f files/survival-ready; then cat files/survival-ready; fi";
  while (deps.timer.now() <= deadline) {
    deps.signal?.throwIfAborted();
    const raw = await checkedCommand(
      deps.shell,
      `shell run-as ${FIXTURE_PACKAGE} sh -c ${shellQuote(read)}`,
    );
    if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) {
      return Number(raw);
    }
    await deps.timer.sleep(POLL_MS);
  }
  throw new Error("Fixture did not commit schedules within the readiness deadline");
}

async function observeUntil(deps: HarnessDeps, deadline: number): Promise<void> {
  // Host time measures elapsed observation; device wall time may be intentionally skewed.
  while (deps.timer.now() < deadline) {
    deps.signal?.throwIfAborted();
    await deps.timer.sleep(Math.min(30_000, deadline - deps.timer.now()));
  }
  deps.signal?.throwIfAborted();
}

function requireVerified(result: { verified?: boolean; error?: string }): void {
  if (!result.verified) {
    throw new Error(result.error ?? "Device clock change did not verify");
  }
}

async function measure(
  device: BootedDevice,
  profile: KillProfile,
  deps: HarnessDeps,
  registry: KillProfileRestoreRegistry,
  clockDeps: DeviceClockDependencies,
): Promise<SurvivalResult> {
  await checkedCommand(
    deps.shell,
    `shell appops set --uid ${FIXTURE_PACKAGE} SCHEDULE_EXACT_ALARM allow`,
  );
  await checkedCommand(
    deps.shell,
    `shell am start -W -n ${FIXTURE_PACKAGE}/.MainActivity --ez autoStart true`,
  );
  const startMs = await waitReady(deps);
  const observationStart = deps.timer.now();
  await checkedCommand(deps.shell, "shell input keyevent KEYCODE_HOME");
  const killDeps = { shell: deps.shell, registry };
  const applied = await applyKillProfile(device, FIXTURE_PACKAGE, profile.id, killDeps);
  if (applied.status !== "applied") {
    throw new Error(`${profile.id} was ${applied.status}; cannot score an incomplete recipe`);
  }
  // A common Doze challenge uses the real recipe and its capture/restore paths, not copied commands.
  const doze = await applyKillProfile(device, FIXTURE_PACKAGE, "oneplus-sleep-standby", killDeps);
  if (doze.status !== "applied") {
    throw new Error("The common Doze challenge was not applied");
  }
  const broadcastMs = await deps.clock.readInstantMs();
  if (broadcastMs >= startMs + FOREGROUND_HEARTBEAT_MS) {
    throw new Error(
      "Profile setup exceeded the first heartbeat deadline; refusing contaminated scores",
    );
  }
  // Exclude stopped packages explicitly: a probe must not revive a force-stopped fixture.
  await checkedCommand(
    deps.shell,
    `shell am broadcast -a android.intent.action.BOOT_COMPLETED -p ${FIXTURE_PACKAGE} -f 0x01000010`,
  );
  await checkedCommand(
    deps.shell,
    `shell am broadcast -a ${FIXTURE_PACKAGE}.PUSH -p ${FIXTURE_PACKAGE} -f 0x11000010`,
  );
  await observeUntil(deps, observationStart + PRIMARY_WINDOW_MS);
  const deferralMs = await deps.clock.readInstantMs();
  requireVerified(
    await writeDeviceClock(
      device,
      deps.clock,
      { mode: "advance", byMs: CLOCK_ADVANCE_MS },
      {
        dependencies: clockDeps,
      },
    ),
  );
  // End only the shared Doze challenge; the measured profile's app restrictions remain applied.
  await checkedCommand(deps.shell, "shell dumpsys deviceidle unforce");
  await observeUntil(deps, deps.timer.now() + RECOVERY_WINDOW_MS);
  const rawLog = await checkedCommand(
    deps.shell,
    `shell run-as ${FIXTURE_PACKAGE} cat files/survival-events.log`,
  );
  const endMs = await deps.clock.readInstantMs();
  const window = scoringWindow(startMs, broadcastMs, deferralMs, endMs, broadcastMs);
  const score = scoreEvents(parseEvents(rawLog), window);
  const expectedScore = KILL_PROFILE_EXPECTED_SCORES[profile.id];
  return {
    profileId: profile.id,
    version: profile.version,
    window,
    rawLog,
    score,
    expectedScore,
    mismatches: SURVIVAL_EVENT_IDS.filter(
      (id) => expectedScore[id] !== "TODO_MEASURE" && expectedScore[id] !== score[id],
    ),
    pendingMeasurement: SURVIVAL_EVENT_IDS.filter((id) => expectedScore[id] === "TODO_MEASURE"),
  };
}

/** Attempt every cleanup even when another restore fails; retain all errors and stop the matrix. */
async function restoreAll(actions: Array<() => Promise<void>>): Promise<void> {
  const failures: string[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }
  if (failures.length) {
    throw new Error(`Survival cleanup failed: ${failures.join("; ")}`);
  }
}

async function runProfile(
  device: BootedDevice,
  profile: KillProfile,
  apk: string,
  deps: HarnessDeps,
): Promise<SurvivalResult> {
  const registry = new KillProfileRestoreRegistry();
  const clockRegistry = new DeviceClockRestoreRegistry();
  const clockDeps: DeviceClockDependencies = {
    hostClock: deps.timer,
    invalidate: () => {},
    restoreRegistry: clockRegistry,
  };
  let installAttempted = false;
  try {
    // Root before scheduling so adbd's restart cannot eat the first callback. This is the same
    // clock implementation clockFaultInjectors/setDeviceState use, with private restore ownership.
    requireVerified(
      await writeDeviceClock(
        device,
        deps.clock,
        { mode: "advance", byMs: 3_000 },
        {
          dependencies: clockDeps,
        },
      ),
    );
    installAttempted = true;
    const installed = await checkedCommand(deps.shell, `install ${shellQuote(apk)}`);
    if (!installed.includes("Success")) {
      throw new Error(`Fixture install failed: ${installed}`);
    }
    return await measure(device, profile, deps, registry, clockDeps);
  } finally {
    await restoreAll([
      async () => {
        if (!registry.pendingFor(device.deviceId, FIXTURE_PACKAGE).length) {
          return;
        }
        await resetKillProfile(device, FIXTURE_PACKAGE, {}, { shell: deps.shell, registry });
      },
      async () => {
        if (!clockRegistry.slot(device.deviceId).get()) {
          return;
        }
        requireVerified(
          await writeDeviceClock(
            device,
            deps.clock,
            { mode: "reset" },
            {
              dependencies: clockDeps,
            },
          ),
        );
      },
      async () => {
        if (!installAttempted) {
          return;
        }
        // Uninstall ends the wake lock/service and removes this run's alarms, jobs and app ops.
        const removed = await checkedCommand(deps.shell, `uninstall ${FIXTURE_PACKAGE}`);
        if (!removed.includes("Success")) {
          throw new Error(`Fixture uninstall failed: ${removed}`);
        }
      },
    ]);
  }
}

export async function runHarness(
  options: { serial: string; avd: string; apk: string; profiles?: readonly KillProfileId[] },
  deps: HarnessDeps,
): Promise<SurvivalReport> {
  const report: SurvivalReport = {
    serial: options.serial,
    avd: options.avd,
    bootProbe: "root-broadcast-excluding-stopped-packages",
    challenge: {
      primaryMs: PRIMARY_WINDOW_MS,
      recoveryMs: RECOVERY_WINDOW_MS,
      clockAdvanceMs: CLOCK_ADVANCE_MS,
      doze: true,
    },
    results: [],
  };
  const device: BootedDevice = { deviceId: options.serial, name: options.avd, platform: "android" };
  try {
    deps.signal?.throwIfAborted();
    const existing = await checkedCommand(deps.shell, `shell pm list packages ${FIXTURE_PACKAGE}`);
    if (packageListingContains(existing, FIXTURE_PACKAGE)) {
      throw new Error(
        "Fixture is already installed; use a dedicated clean emulator to preserve its data",
      );
    }
    const api = await readAndroidDeviceApiLevel(deps.shell);
    if (api === null || api < 33) {
      throw new Error(
        "Scoring every profile requires API 33+ (exact-alarm revocation and POST_NOTIFICATION app-op)",
      );
    }
    if (api !== EXPECTED_SCORES_API_LEVEL) {
      report.noBaseline = `no baseline for API ${api}; expected scores were measured on API ${EXPECTED_SCORES_API_LEVEL}, so nothing is compared`;
    }
    const idle = await checkedCommand(deps.shell, "shell dumpsys deviceidle");
    if (/mForceIdle=true/.test(idle)) {
      throw new Error("Device already has forced Doze; release it before running the harness");
    }
    for (const profile of SURVIVAL_MATRIX.filter(
      (profile) => !options.profiles || options.profiles.includes(profile.id),
    )) {
      deps.signal?.throwIfAborted();
      report.results.push(withBaseline(await runProfile(device, profile, options.apk, deps), api));
    }
  } catch (error) {
    report.aborted = errorMessage(error);
  }
  return report;
}
