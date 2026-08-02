import { BootedDevice, ExecResult, AndroidUser, DeviceLockState } from "../../../models";
import type { Readable, Writable } from "node:stream";

/** The intentionally small process surface exposed by ADB streaming commands. */
export interface AdbProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "spawn", listener: () => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(event: "spawn", listener: () => void): this;
  removeListener(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
}

export interface AdbExecuteOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  noRetry?: boolean;
  signal?: AbortSignal;
  /**
   * Runs after ADB path resolution and immediately before a subprocess dispatch.
   * Receives the remaining command budget, if one was supplied.
   */
  beforeDispatch?: (remainingTimeoutMs?: number) => Promise<void>;
}

export interface AdbSpawnOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type DeviceTimestampSource = "device-ms" | "device-seconds" | "host";

export interface DeviceTimestampResult {
  timestampMs: number;
  source: DeviceTimestampSource;
}

/** A raw row from `adb devices`, including devices that are not online yet. */
export interface AdbDeviceState {
  deviceId: string;
  state: string;
}

/**
 * Interface for executing ADB commands
 * Enables dependency injection and testing with fakes
 */
export interface AdbExecutor {
  /** Execute argv directly. Device selection and executable lookup stay internal. */
  execute(args: string[], options?: AdbExecuteOptions): Promise<ExecResult>;

  /** Spawn a long-lived ADB command. Spawned commands deliberately never retry. */
  spawn(args: string[], options?: AdbSpawnOptions): Promise<AdbProcess>;
  /**
   * Execute an ADB command
   * @param command - The ADB command to execute (without "adb -s <device>" prefix)
   * @param timeoutMs - Optional timeout in milliseconds
   * @param maxBuffer - Optional maximum buffer size for command output
   * @param noRetry - Optional flag to disable retry logic
   * @returns Promise with command output
   */
  executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal
  ): Promise<ExecResult>;

  /**
   * Get the device time in milliseconds since the Unix epoch.
   * Falls back to the host time when device time cannot be retrieved.
   */
  getDeviceTimestampMs(): Promise<number>;

  /**
   * Get the device time with the clock source used to derive it.
   * Host fallback is retained for callers that accept a best-effort timestamp.
   */
  getDeviceTimestampMsWithSource(): Promise<DeviceTimestampResult>;

  /**
   * Get the list of booted Android devices
   * @returns Promise with array of booted devices
   */
  getBootedAndroidDevices(options?: { bypassCache?: boolean }): Promise<BootedDevice[]>;

  /** Return raw ADB device states, including `offline` and `unauthorized` rows. */
  getDeviceStates?(): Promise<AdbDeviceState[]>;

  /**
   * Check if the device screen is currently on
   * @returns Promise<boolean> - true if screen is on (Awake), false otherwise
   */
  isScreenOn(): Promise<boolean>;

  /**
   * Get the device wakefulness state
   * @returns Promise with wakefulness state: "Awake", "Asleep", "Dozing", or null if unknown
   */
  getWakefulness(): Promise<"Awake" | "Asleep" | "Dozing" | null>;

  /**
   * Get the device lock state (keyguard showing / secure vs swipe).
   * @returns Promise with a {@link DeviceLockState}, or null when the lock state
   *          could not be read (the caller then leaves `deviceLock` unset).
   */
  getDeviceLock(signal?: AbortSignal): Promise<DeviceLockState | null>;

  /**
   * List all Android users on the device (personal, work profiles, etc.)
   * @returns Promise with array of Android users
   */
  listUsers(signal?: AbortSignal): Promise<AndroidUser[]>;

  /**
   * Get the current foreground app package name and user ID
   * @returns Promise with { packageName: string, userId: number } or null if no app in foreground
   */
  getForegroundApp(signal?: AbortSignal): Promise<{ packageName: string; userId: number } | null>;

  /** Get device time in milliseconds. */
  getDeviceTimestampMs(): Promise<number>;

  /**
   * Resolve and return the path to the `adb` binary without executing a command.
   * Used by diagnostics (doctor) to surface the detected path.
   */
  getAdbPathOnly(): Promise<string>;
}
