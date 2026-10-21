import type { HostChildProcess as ChildProcess } from "../HostCommandExecutor";
import { ActionableError, type BootedDevice } from "../../models";
import { logger } from "../logger";
import { PortManager, type PortAvailabilityChecker } from "../PortManager";
import { raceWithDeadline } from "../raceWithDeadline";
import type { Timer } from "../SystemTimer";
import type { AdbClientFactory } from "./AdbClientFactory";
import { ENV, readEnvRaw, readEnvTrimmed } from "../../config/env";
import { EmulatorConsolePortExcludedError } from "./EmulatorConsolePortExcludedError";

const MIN_EMULATOR_CONSOLE_PORT = 5554;
const MAX_EMULATOR_CONSOLE_PORT = 5682;
const EMULATOR_CONSOLE_PORT_STEP = 2;
const TERMINAL_RESERVATION_TTL_MS = 30_000;

function isValidEmulatorConsolePort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= MIN_EMULATOR_CONSOLE_PORT &&
    port <= MAX_EMULATOR_CONSOLE_PORT &&
    port % EMULATOR_CONSOLE_PORT_STEP === 0
  );
}

/** Resolve at launch time so invalid configuration never fails during module loading. */
export function resolveExcludedEmulatorConsolePorts(env: NodeJS.ProcessEnv): ReadonlySet<number> {
  const raw = readEnvRaw(ENV.EMULATOR_EXCLUDED_CONSOLE_PORTS, env);
  if (raw === undefined) {
    return new Set(
      readEnvTrimmed(ENV.SESSION_BROKER_CONFIG, env) ? [MIN_EMULATOR_CONSOLE_PORT] : [],
    );
  }
  const ports = new Set<number>();
  for (const entry of raw.split(/[,\s]+/).filter(Boolean)) {
    const digits = /^(?:emulator-)?(\d+)$/.exec(entry)?.[1];
    const port = Number(digits);
    if (!digits || !isValidEmulatorConsolePort(port)) {
      throw new ActionableError(
        `${ENV.EMULATOR_EXCLUDED_CONSOLE_PORTS.name} has invalid entry '${entry}'; ` +
          `use even console ports from ${MIN_EMULATOR_CONSOLE_PORT} through ${MAX_EMULATOR_CONSOLE_PORT} or emulator-<port> serials.`,
      );
    }
    ports.add(port);
  }
  return ports;
}

export type EmulatorPortPair = {
  readonly consolePort: number;
  readonly adbPort: number;
};

export type EmulatorConsolePortArgument = {
  readonly option: "-port" | "-ports";
  readonly value: string | undefined;
  readonly consumesFollowingArgument: boolean;
};

function emulatorConsolePortArgument(
  args: readonly string[],
  index: number,
): EmulatorConsolePortArgument | undefined {
  const argument = args[index];
  if (argument === "-port" || argument === "-ports") {
    return {
      option: argument,
      value: args[index + 1],
      consumesFollowingArgument: true,
    };
  }
  const match = argument.match(/^-(port|ports)=(.*)$/);
  return match
    ? {
        option: `-${match[1]}` as "-port" | "-ports",
        value: match[2],
        consumesFollowingArgument: false,
      }
    : undefined;
}

function parseEmulatorConsolePort(
  consolePortText: string | undefined,
  option: EmulatorConsolePortArgument["option"],
): number {
  const consolePort = Number(consolePortText);
  if (!consolePortText || !isValidEmulatorConsolePort(consolePort)) {
    throw new ActionableError(
      `Emulator ${option} must specify an even console port from ` +
        `${MIN_EMULATOR_CONSOLE_PORT} through ${MAX_EMULATOR_CONSOLE_PORT}`,
    );
  }
  return consolePort;
}

function parseEmulatorAdbPort(
  adbPortText: string | undefined,
  additionalValues: readonly string[],
): number {
  const adbPort = Number(adbPortText);
  if (
    !adbPortText ||
    additionalValues.length > 0 ||
    !Number.isInteger(adbPort) ||
    adbPort < 1 ||
    adbPort > 65_535
  ) {
    throw new ActionableError("Emulator -ports must specify distinct console and ADB TCP ports");
  }
  return adbPort;
}

function parseEmulatorPortPair(argument: EmulatorConsolePortArgument): EmulatorPortPair {
  const [consolePortText, adbPortText, ...additionalValues] = argument.value?.split(",") ?? [];
  const consolePort = parseEmulatorConsolePort(consolePortText, argument.option);
  if (argument.option === "-port") {
    return { consolePort, adbPort: consolePort + 1 };
  }

  const adbPort = parseEmulatorAdbPort(adbPortText, additionalValues);
  if (adbPort === consolePort) {
    throw new ActionableError("Emulator -ports must specify distinct console and ADB TCP ports");
  }
  return { consolePort, adbPort };
}

function emulatorPortsForDeviceId(deviceId: string | undefined): EmulatorPortPair | undefined {
  if (!deviceId?.startsWith("emulator-")) {
    return undefined;
  }
  const consolePort = Number(deviceId.slice("emulator-".length));
  if (!isValidEmulatorConsolePort(consolePort)) {
    throw new ActionableError(
      `Expected emulator device ID '${deviceId}' must use an even console port from ` +
        `${MIN_EMULATOR_CONSOLE_PORT} through ${MAX_EMULATOR_CONSOLE_PORT}`,
    );
  }
  return { consolePort, adbPort: consolePort + 1 };
}

function observedEmulatorPorts(deviceId: string): EmulatorPortPair | undefined {
  if (!deviceId.startsWith("emulator-")) {
    return undefined;
  }
  const consolePort = Number(deviceId.slice("emulator-".length));
  if (!Number.isInteger(consolePort) || consolePort < 1 || consolePort >= 65_535) {
    return undefined;
  }
  return { consolePort, adbPort: consolePort + 1 };
}

function emulatorDeviceIdForConsolePort(consolePort: number): string {
  return `emulator-${consolePort}`;
}

/**
 * Whether a spawned emulator child is still running. A ChildProcess reports a
 * code or a signal once it has exited and leaves both unset until then, so this
 * is the guard that stops a reservation whose `exit` event never arrived from
 * blocking every later launch of that AVD.
 */
function isLaunchChildAlive(child: ChildProcess): boolean {
  return (child.exitCode ?? null) === null && (child.signalCode ?? null) === null;
}

function configuredEmulatorPorts(args: readonly string[]): EmulatorPortPair | undefined {
  let configuredPorts: EmulatorPortPair | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = emulatorConsolePortArgument(args, index);
    if (!argument) {
      continue;
    }
    if (argument.consumesFollowingArgument) {
      index += 1;
    }
    const ports = parseEmulatorPortPair(argument);
    if (
      configuredPorts &&
      (configuredPorts.consolePort !== ports.consolePort ||
        configuredPorts.adbPort !== ports.adbPort)
    ) {
      throw new ActionableError("Emulator arguments specify multiple different port pairs");
    }
    configuredPorts = ports;
  }
  return configuredPorts;
}

export type EmulatorDeviceIdReservation = {
  readonly deviceId: string;
  readonly ports: EmulatorPortPair;
  readonly appendPort: boolean;
  /**
   * The AVD this reservation was taken for. A reservation is the only host-side
   * fact that ties a console port to an AVD NAME while the runtime is still
   * mid-boot and answers the scan as `Unknown (<serial>)` (#6407).
   */
  readonly avdName: string;
};

export type TerminalEmulatorReservation = {
  readonly generation: number;
  readonly ports: EmulatorPortPair;
  readonly releasedAt: number;
};

export type EmulatorDeviceIdSnapshot = {
  readonly deviceIds: ReadonlySet<string>;
  readonly isComplete: boolean;
};

/** Process-wide launch-guard records, shared by every client in the daemon. */
interface ReservationState {
  readonly reservedLaunchDeviceIds: Map<ChildProcess, EmulatorDeviceIdReservation>;
  readonly pendingLaunchDeviceIds: Map<string, EmulatorDeviceIdReservation>;
  readonly terminalReservedDeviceIds: Map<string, TerminalEmulatorReservation>;
  /**
   * AVDs whose launch this PROCESS has claimed and not yet finished. An in-flight launch is
   * invisible to every host-side signal for seconds (adb has no serial yet, then the serial has no
   * name), so the claim, not the name label, is what makes a concurrent second launch of the same
   * AVD impossible in-process (#6407). Ownership hands off to the console-port reservation once the
   * process has spawned.
   */
  readonly inFlightAvdLaunches: Set<string>;
  /**
   * AVD name of every launch child this process spawned WITHOUT a console-port reservation. That
   * happens whenever the pre-launch device snapshot came back incomplete, and it leaves the AVD with
   * no serial to correlate against the scan, so the live child itself is the only evidence that this
   * AVD is already coming up (#6407).
   */
  readonly unreservedLaunchAvdNames: Map<ChildProcess, string>;
  terminalReservationGeneration: number;
}

// startDevice creates a fresh client per request, so reservations must cover every client in the
// daemon rather than one client instance.
const state: ReservationState = {
  reservedLaunchDeviceIds: new Map(),
  pendingLaunchDeviceIds: new Map(),
  terminalReservedDeviceIds: new Map(),
  inFlightAvdLaunches: new Set(),
  unreservedLaunchAvdNames: new Map(),
  terminalReservationGeneration: 0,
};

/** Drop every process-wide launch reservation. Test seam. */
export function resetEmulatorLaunchReservations(): void {
  state.reservedLaunchDeviceIds.clear();
  state.pendingLaunchDeviceIds.clear();
  state.terminalReservedDeviceIds.clear();
  state.inFlightAvdLaunches.clear();
  state.unreservedLaunchAvdNames.clear();
  state.terminalReservationGeneration = 0;
}

export interface EmulatorPortReservationDeps {
  timer: () => Timer;
  adbFactory: () => AdbClientFactory;
  hostPortAvailabilityChecker: () => PortAvailabilityChecker;
  excludedConsolePorts?: () => ReadonlySet<number>;
}

/**
 * Console-port and device-id reservations for emulator launches: which ports a launch may take,
 * which serial it will appear as, and the guards that stop a second launch of the same AVD.
 */
export interface EmulatorPortReservations {
  capturePreLaunchEmulatorDeviceIds(
    capture: boolean,
    signal?: AbortSignal,
  ): Promise<EmulatorDeviceIdSnapshot | undefined>;
  addReservedEmulatorPort(
    args: string[],
    avdName: string,
    preLaunchSnapshot: EmulatorDeviceIdSnapshot | undefined,
    expectedDeviceId?: string,
    signal?: AbortSignal,
  ): Promise<EmulatorDeviceIdReservation | undefined>;
  findReservedLaunchSerial(
    avdName: string,
    runningEmulators: readonly BootedDevice[],
    isUnknownEmulatorName: (name: string, deviceId: string) => boolean,
  ): string | undefined;
  findLiveReservationAwaitingAdb(
    avdName: string,
    runningEmulators: readonly BootedDevice[],
  ): string | undefined;
  hasLiveUnreservedLaunch(avdName: string): boolean;
  releaseLaunchChild(childProcess?: ChildProcess | null): void;
  releasePendingEmulatorDeviceId(reservation: EmulatorDeviceIdReservation): void;
  /** Move a pending reservation onto its spawned child. */
  recordReservedEmulatorDeviceId(
    childProcess: ChildProcess,
    reservation: EmulatorDeviceIdReservation,
  ): void;
  /** Remember a reservation-less launch child so it still counts as the AVD coming up. */
  trackUnreservedLaunch(childProcess: ChildProcess, avdName: string): void;
  hasInFlightLaunch(avdName: string): boolean;
  claimInFlightLaunch(avdName: string): void;
  releaseInFlightLaunch(avdName: string): void;
}

export class DefaultEmulatorPortReservations implements EmulatorPortReservations {
  constructor(private readonly deps: EmulatorPortReservationDeps) {}

  private excludedConsolePorts(): ReadonlySet<number> {
    return this.deps.excludedConsolePorts?.() ?? resolveExcludedEmulatorConsolePorts(process.env);
  }

  hasInFlightLaunch(avdName: string): boolean {
    return state.inFlightAvdLaunches.has(avdName);
  }

  claimInFlightLaunch(avdName: string): void {
    state.inFlightAvdLaunches.add(avdName);
  }

  releaseInFlightLaunch(avdName: string): void {
    state.inFlightAvdLaunches.delete(avdName);
  }

  trackUnreservedLaunch(childProcess: ChildProcess, avdName: string): void {
    state.unreservedLaunchAvdNames.set(childProcess, avdName);
  }

  recordReservedEmulatorDeviceId(
    childProcess: ChildProcess,
    reservation: EmulatorDeviceIdReservation,
  ): void {
    this.releasePendingEmulatorDeviceId(reservation);
    state.reservedLaunchDeviceIds.set(childProcess, reservation);
  }

  async capturePreLaunchEmulatorDeviceIds(
    capture: boolean,
    signal?: AbortSignal,
  ): Promise<EmulatorDeviceIdSnapshot | undefined> {
    if (!capture) {
      return undefined;
    }
    const terminalReservationsAtSnapshot = new Map(state.terminalReservedDeviceIds);
    let deviceIds: Set<string> | undefined;
    try {
      const adb = this.deps.adbFactory().create(null);
      const devices = await adb.getBootedAndroidDevices({
        bypassCache: true,
        throwOnMissingAdb: true,
        signal,
      });
      deviceIds = new Set(
        devices
          .map((device) => device.deviceId)
          .filter((deviceId): deviceId is string => deviceId.startsWith("emulator-")),
      );
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Android emulator reservation snapshot was cancelled");
      }
      if (!adb.getDeviceStates) {
        return { deviceIds, isComplete: false };
      }
      const deviceStates = await adb.getDeviceStates({ signal });
      for (const { deviceId } of deviceStates) {
        if (deviceId.startsWith("emulator-")) {
          deviceIds.add(deviceId);
        }
      }
      this.releaseAbsentTerminalReservations(deviceIds, terminalReservationsAtSnapshot);
      return { deviceIds, isComplete: true };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      if (deviceIds) {
        logger.debug(`Could not capture all pre-launch emulator device IDs: ${error}`);
        return { deviceIds, isComplete: false };
      }
      // Without a current device list, do not select a port that could belong to
      // another local emulator. Readiness can still use a captured serial or an
      // exact AVD-name match.
      logger.debug(`Could not capture pre-launch emulator device IDs: ${error}`);
      return undefined;
    }
  }

  private async allocateReservedEmulatorPorts(
    avdName: string,
    preLaunchSnapshot: EmulatorDeviceIdSnapshot,
    signal?: AbortSignal,
  ): Promise<EmulatorDeviceIdReservation> {
    this.pruneExpiredTerminalReservations(preLaunchSnapshot);
    const preexistingDeviceIds = preLaunchSnapshot.deviceIds;
    const unavailablePorts = this.unavailableEmulatorPorts(preexistingDeviceIds);
    const excludedPorts = this.excludedConsolePorts();
    for (
      let port = MIN_EMULATOR_CONSOLE_PORT;
      port <= MAX_EMULATOR_CONSOLE_PORT;
      port += EMULATOR_CONSOLE_PORT_STEP
    ) {
      const ports = { consolePort: port, adbPort: port + 1 };
      if (
        !excludedPorts.has(port) &&
        !unavailablePorts.has(ports.consolePort) &&
        !unavailablePorts.has(ports.adbPort) &&
        (await this.areEmulatorPortsAvailableOnHost(ports, signal))
      ) {
        this.pruneExpiredTerminalReservations(preLaunchSnapshot);
        const currentUnavailablePorts = this.unavailableEmulatorPorts(preexistingDeviceIds);
        if (
          !currentUnavailablePorts.has(ports.consolePort) &&
          !currentUnavailablePorts.has(ports.adbPort)
        ) {
          return this.reservePendingEmulatorDeviceId(avdName, ports, true);
        }
      }
    }
    throw new ActionableError(
      `Cannot safely launch an Android emulator: all console ports from ` +
        `${MIN_EMULATOR_CONSOLE_PORT} through ${MAX_EMULATOR_CONSOLE_PORT} are in use; ` +
        `excluded console ports: ${[...excludedPorts].sort((a, b) => a - b).join(", ") || "none"} ` +
        `(${ENV.EMULATOR_EXCLUDED_CONSOLE_PORTS.name})`,
    );
  }

  private unavailableEmulatorPorts(
    preexistingDeviceIds: ReadonlySet<string> | undefined,
  ): Set<number> {
    const unavailablePorts = new Set<number>();
    const reservePorts = (ports: EmulatorPortPair) => {
      unavailablePorts.add(ports.consolePort);
      unavailablePorts.add(ports.adbPort);
    };
    for (const deviceId of preexistingDeviceIds ?? []) {
      const ports = observedEmulatorPorts(deviceId);
      if (ports) {
        reservePorts(ports);
      }
    }
    for (const reservation of state.reservedLaunchDeviceIds.values()) {
      reservePorts(reservation.ports);
    }
    for (const reservation of state.pendingLaunchDeviceIds.values()) {
      reservePorts(reservation.ports);
    }
    for (const reservation of state.terminalReservedDeviceIds.values()) {
      reservePorts(reservation.ports);
    }
    return unavailablePorts;
  }

  private async areEmulatorPortsAvailableOnHost(
    ports: EmulatorPortPair,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const availability = Promise.resolve([
      PortManager.isPortAvailable(ports.consolePort, this.deps.hostPortAvailabilityChecker()),
      PortManager.isPortAvailable(ports.adbPort, this.deps.hostPortAvailabilityChecker()),
    ]);
    if (!signal) {
      return (await availability).every(Boolean);
    }
    if (signal.aborted) {
      throw new ActionableError("Android emulator launch was cancelled while checking host ports");
    }
    try {
      return (
        await raceWithDeadline(availability, {
          timer: this.deps.timer(),
          signal,
          label: "Android emulator host port check",
        })
      ).every(Boolean);
    } catch (error) {
      if (signal.aborted) {
        throw new ActionableError(
          "Android emulator launch was cancelled while checking host ports",
        );
      }
      throw error;
    }
  }

  private assertEmulatorPortsNotReserved(
    ports: EmulatorPortPair,
    preexistingDeviceIds: ReadonlySet<string> | undefined,
    preLaunchSnapshot?: EmulatorDeviceIdSnapshot,
  ): void {
    this.pruneExpiredTerminalReservations(preLaunchSnapshot);
    const unavailablePorts = this.unavailableEmulatorPorts(preexistingDeviceIds);
    if (unavailablePorts.has(ports.consolePort) || unavailablePorts.has(ports.adbPort)) {
      throw new ActionableError(
        `Cannot safely launch an Android emulator: console port ` +
          `${ports.consolePort} is already in use`,
      );
    }
  }

  private async assertEmulatorPortsAvailable(
    ports: EmulatorPortPair,
    preexistingDeviceIds: ReadonlySet<string> | undefined,
    signal?: AbortSignal,
    preLaunchSnapshot?: EmulatorDeviceIdSnapshot,
  ): Promise<void> {
    if (this.excludedConsolePorts().has(ports.consolePort)) {
      throw new EmulatorConsolePortExcludedError(ports.consolePort);
    }
    this.assertEmulatorPortsNotReserved(ports, preexistingDeviceIds, preLaunchSnapshot);
    if (!(await this.areEmulatorPortsAvailableOnHost(ports, signal))) {
      throw new ActionableError(
        `Cannot safely launch an Android emulator: emulator port pair ` +
          `${ports.consolePort}/${ports.adbPort} is already in use`,
      );
    }
    this.assertEmulatorPortsNotReserved(ports, preexistingDeviceIds, preLaunchSnapshot);
  }

  private reservePendingEmulatorDeviceId(
    avdName: string,
    ports: EmulatorPortPair,
    appendPort: boolean,
  ): EmulatorDeviceIdReservation {
    const reservation = {
      deviceId: emulatorDeviceIdForConsolePort(ports.consolePort),
      ports,
      appendPort,
      avdName,
    };
    state.pendingLaunchDeviceIds.set(reservation.deviceId, reservation);
    return reservation;
  }

  private async reserveEmulatorDeviceId(
    avdName: string,
    preLaunchSnapshot: EmulatorDeviceIdSnapshot | undefined,
    args: readonly string[],
    expectedDeviceId?: string,
    signal?: AbortSignal,
  ): Promise<EmulatorDeviceIdReservation | undefined> {
    const expectedEmulatorPorts = emulatorPortsForDeviceId(expectedDeviceId);
    if (expectedDeviceId && !expectedEmulatorPorts) {
      return undefined;
    }
    const configuredPorts = configuredEmulatorPorts(args);
    if (
      expectedEmulatorPorts &&
      configuredPorts &&
      expectedEmulatorPorts.consolePort !== configuredPorts.consolePort
    ) {
      throw new ActionableError(
        `Expected emulator device ID '${expectedDeviceId}' conflicts with configured ` +
          `console port ${configuredPorts.consolePort}`,
      );
    }
    const ports = configuredPorts ?? expectedEmulatorPorts;
    if (ports) {
      this.pruneExpiredTerminalReservations(preLaunchSnapshot);
      await this.assertEmulatorPortsAvailable(
        ports,
        preLaunchSnapshot?.deviceIds,
        signal,
        preLaunchSnapshot,
      );
      return this.reservePendingEmulatorDeviceId(avdName, ports, configuredPorts === undefined);
    }
    return this.reserveAutomaticEmulatorDeviceId(avdName, preLaunchSnapshot, signal);
  }

  private reserveAutomaticEmulatorDeviceId(
    avdName: string,
    snapshot: EmulatorDeviceIdSnapshot | undefined,
    signal?: AbortSignal,
  ): Promise<EmulatorDeviceIdReservation | undefined> {
    if (snapshot?.isComplete) {
      return this.allocateReservedEmulatorPorts(avdName, snapshot, signal);
    }
    const exclusions = this.excludedConsolePorts();
    if (exclusions.size > 0) {
      throw new ActionableError(
        `Cannot safely enforce ${ENV.EMULATOR_EXCLUDED_CONSOLE_PORTS.name} without a complete ` +
          `emulator device snapshot; restore device discovery or specify an allowed -port.`,
      );
    }
    return Promise.resolve(undefined);
  }

  async addReservedEmulatorPort(
    args: string[],
    avdName: string,
    preLaunchSnapshot: EmulatorDeviceIdSnapshot | undefined,
    expectedDeviceId?: string,
    signal?: AbortSignal,
  ): Promise<EmulatorDeviceIdReservation | undefined> {
    const reservation = await this.reserveEmulatorDeviceId(
      avdName,
      preLaunchSnapshot,
      args,
      expectedDeviceId,
      signal,
    );
    if (reservation?.appendPort) {
      args.push("-port", String(reservation.ports.consolePort));
    }
    return reservation;
  }

  /**
   * The serial of an emulator THIS process is launching for `avdName`, found by
   * correlating the console-port reservations it holds against the scan.
   *
   * A mid-boot emulator answers the scan as `Unknown (<serial>)` for seconds
   * (minutes on a cold boot), so the name label cannot answer "is this AVD
   * already up" (#6407). The reservation can: it was taken for this AVD, and it
   * fixes the console port the serial is derived from. Only a placeholder name
   * counts — a serial that has resolved to some OTHER AVD is a stale
   * reservation, never evidence about this one.
   */
  findReservedLaunchSerial(
    avdName: string,
    runningEmulators: readonly BootedDevice[],
    isUnknownEmulatorName: (name: string, deviceId: string) => boolean,
  ): string | undefined {
    const reservedSerials = new Set<string>();
    const reservations = [
      ...state.pendingLaunchDeviceIds.values(),
      ...state.reservedLaunchDeviceIds.values(),
    ];
    for (const reservation of reservations) {
      if (reservation.avdName === avdName) {
        reservedSerials.add(reservation.deviceId);
      }
    }
    return runningEmulators.find(
      (emulator) =>
        reservedSerials.has(emulator.deviceId) &&
        isUnknownEmulatorName(emulator.name, emulator.deviceId),
    )?.deviceId;
  }

  /**
   * The serial this process reserved for `avdName` whose emulator is alive but
   * has NOT appeared in the adb scan yet.
   *
   * Startup validation resolves off the first emulator output marker, which the
   * emulator prints seconds before adb lists the runtime, and the name-level
   * in-flight claim is dropped at that point. In that gap
   * `findReservedLaunchSerial` has nothing in the scan to correlate against, so
   * the reservation — held only from the spawn until the child exits — is the
   * one piece of evidence that this AVD is already coming up (#6407).
   *
   * A reserved serial the scan DOES list is deliberately not handled here: it
   * is either the mid-boot placeholder `findReservedLaunchSerial` already
   * matches, or a serial that has resolved to some other AVD, which makes the
   * reservation stale rather than evidence about this one.
   */
  findLiveReservationAwaitingAdb(
    avdName: string,
    runningEmulators: readonly BootedDevice[],
  ): string | undefined {
    const scannedDeviceIds = new Set(runningEmulators.map((emulator) => emulator.deviceId));
    for (const [child, reservation] of state.reservedLaunchDeviceIds) {
      if (
        reservation.avdName === avdName &&
        !scannedDeviceIds.has(reservation.deviceId) &&
        isLaunchChildAlive(child)
      ) {
        return reservation.deviceId;
      }
    }
    return undefined;
  }

  /**
   * Whether this process still holds a live launch child for `avdName` that
   * reserved no console port.
   *
   * The name-level in-flight claim is released as soon as startup validation
   * resolves off the first emulator output marker, seconds before adb lists the
   * runtime. With a reservation, `findLiveReservationAwaitingAdb` covers that
   * gap; without one there is no serial to correlate, so the running child is
   * the claim. Callers reach this only after the scan failed to show the AVD by
   * name, and an exited child is both pruned here and ignored, so a missed
   * `exit` event cannot block later launches of the AVD forever.
   */
  hasLiveUnreservedLaunch(avdName: string): boolean {
    let live = false;
    for (const [child, launchedAvdName] of [...state.unreservedLaunchAvdNames]) {
      if (!isLaunchChildAlive(child)) {
        state.unreservedLaunchAvdNames.delete(child);
        continue;
      }
      live ||= launchedAvdName === avdName;
    }
    return live;
  }

  /** Drop every launch-guard record this process holds for an exited child. */
  releaseLaunchChild(childProcess?: ChildProcess | null): void {
    if (!childProcess) {
      return;
    }
    state.unreservedLaunchAvdNames.delete(childProcess);
    this.releaseReservedEmulatorDeviceId(childProcess);
  }

  releasePendingEmulatorDeviceId(reservation: EmulatorDeviceIdReservation): void {
    if (state.pendingLaunchDeviceIds.get(reservation.deviceId) === reservation) {
      state.pendingLaunchDeviceIds.delete(reservation.deviceId);
    }
  }

  private releaseReservedEmulatorDeviceId(childProcess?: ChildProcess | null): void {
    if (!childProcess) {
      return;
    }
    const reservation = state.reservedLaunchDeviceIds.get(childProcess);
    if (reservation) {
      state.reservedLaunchDeviceIds.delete(childProcess);
      // ADB can retain an exited emulator briefly. Keep its port unavailable
      // until a complete snapshot confirms disappearance or its bounded TTL expires.
      state.terminalReservedDeviceIds.set(reservation.deviceId, {
        generation: ++state.terminalReservationGeneration,
        ports: reservation.ports,
        releasedAt: this.deps.timer().now(),
      });
    }
  }

  private pruneExpiredTerminalReservations(snapshot: EmulatorDeviceIdSnapshot | undefined): void {
    const now = this.deps.timer().now();
    for (const [deviceId, reservation] of state.terminalReservedDeviceIds) {
      if (snapshot?.isComplete && snapshot.deviceIds.has(deviceId)) {
        continue;
      }
      if (now - reservation.releasedAt > TERMINAL_RESERVATION_TTL_MS) {
        state.terminalReservedDeviceIds.delete(deviceId);
      }
    }
  }

  private releaseAbsentTerminalReservations(
    deviceIds: ReadonlySet<string>,
    terminalReservationsAtSnapshot: ReadonlyMap<string, TerminalEmulatorReservation>,
  ): void {
    for (const [deviceId, reservation] of terminalReservationsAtSnapshot) {
      if (
        !deviceIds.has(deviceId) &&
        state.terminalReservedDeviceIds.get(deviceId)?.generation === reservation.generation
      ) {
        state.terminalReservedDeviceIds.delete(deviceId);
      }
    }
  }
}
