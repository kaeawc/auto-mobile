/**
 * Turns a remote device reservation into a usable adb device (#14468): reserve, connect adb,
 * reinstall CtrlProxy (remote sessions are wiped), read the device's identity, and release the
 * session on every failure path and on shutdown so nothing is left billing.
 *
 * The adb connection is behind {@link RemoteAdbTransport}; Device Streaming's implementation is
 * the `AdbConnect` bridge (#14464).
 */
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type { RemoteDeviceCostEstimate } from "./remoteDeviceCostPolicy";
import {
  remainingSessionMs,
  type RemoteDeviceProvider,
  type RemoteDeviceRequest,
  type RemoteDeviceSession,
} from "./remoteDeviceProvider";

/** An adb connection to a reserved device. */
export interface RemoteAdbConnection {
  /** The serial adb addresses the device by, e.g. `127.0.0.1:<port>`. */
  serial: string;
  /** Disconnects adb; closing an already-closed connection succeeds. */
  close(): Promise<void>;
}

export interface RemoteAdbTransport {
  /** Connects adb to an active session. */
  connect(session: RemoteDeviceSession, signal?: AbortSignal): Promise<RemoteAdbConnection>;
}

/** The identity a partner-lab device reports, so callers can tell OEMs apart. */
export interface RemoteDeviceIdentity {
  manufacturer: string | null;
  brand: string | null;
  model: string | null;
}

/** Device preparation that has to run on every new connection. */
export interface RemoteDeviceConnectSetup {
  /** Installs and enables CtrlProxy. Remote sessions start wiped, so this always reinstalls. */
  installCtrlProxy(serial: string, signal?: AbortSignal): Promise<void>;
  readIdentity(serial: string): Promise<RemoteDeviceIdentity>;
}

export interface RemoteDeviceLease {
  sessionId: string;
  serial: string;
  /** Null fields when the identity could not be read; it is descriptive only. */
  identity: RemoteDeviceIdentity;
  /** Cost of the reserved minutes. */
  cost: RemoteDeviceCostEstimate;
  expireTimeMs?: number;
}

export interface RemoteDeviceLeaseSummary extends RemoteDeviceIdentity {
  sessionId: string;
  serial: string;
  cost: RemoteDeviceCostEstimate;
  /** Whole minutes left, rounded down; absent when the provider gave no end time. */
  remainingMinutes?: number;
}

export interface RemoteDeviceAcquisitionOptions {
  provider: RemoteDeviceProvider;
  transport: RemoteAdbTransport;
  setup: RemoteDeviceConnectSetup;
  timer: Pick<Timer, "now">;
}

const UNKNOWN_IDENTITY: RemoteDeviceIdentity = { manufacturer: null, brand: null, model: null };
const MINUTE_MS = 60_000;

interface HeldLease {
  lease: RemoteDeviceLease;
  connection: RemoteAdbConnection;
}

export class RemoteDeviceAcquisition {
  private readonly held = new Map<string, HeldLease>();

  constructor(private readonly options: RemoteDeviceAcquisitionOptions) {}

  async acquire(request: RemoteDeviceRequest, signal?: AbortSignal): Promise<RemoteDeviceLease> {
    const { session, cost } = await this.options.provider.reserve(request, signal);
    let connection: RemoteAdbConnection | undefined;
    try {
      connection = await this.options.transport.connect(session, signal);
      await this.options.setup.installCtrlProxy(connection.serial, signal);
      const identity = await this.readIdentity(connection.serial);
      const lease: RemoteDeviceLease = {
        sessionId: session.id,
        serial: connection.serial,
        identity,
        cost,
        expireTimeMs: session.expireTimeMs,
      };
      this.held.set(session.id, { lease, connection });
      return lease;
    } catch (error) {
      throw await this.abandon(session.id, connection, error);
    }
  }

  /** Disconnects adb and ends the session. Releasing an unknown or released session only ends it. */
  async release(sessionId: string): Promise<void> {
    const held = this.held.get(sessionId);
    if (held) {
      await this.closeQuietly(held.connection);
    }
    await this.options.provider.release(sessionId);
    // Kept until the provider confirms, so a failed release is retried by releaseAll.
    this.held.delete(sessionId);
  }

  /**
   * Releases every held session, for session end and daemon shutdown. One failure does not stop
   * the rest; the ids that could not be released are returned after each is logged.
   */
  async releaseAll(): Promise<string[]> {
    const ids = [...this.held.keys()];
    const results = await Promise.allSettled(ids.map((id) => this.release(id)));
    return ids.filter((id, index) => {
      const result = results[index];
      if (result?.status !== "rejected") {
        return false;
      }
      logger.warn(`Failed to release remote session ${id}; it may still be billing`, result.reason);
      return true;
    });
  }

  heldSessionIds(): string[] {
    return [...this.held.keys()];
  }

  /** Cost and remaining time, for tool responses. */
  summarize(lease: RemoteDeviceLease): RemoteDeviceLeaseSummary {
    const remainingMs = remainingSessionMs(
      { state: "active", expireTimeMs: lease.expireTimeMs },
      this.options.timer.now(),
    );
    return {
      sessionId: lease.sessionId,
      serial: lease.serial,
      ...lease.identity,
      cost: lease.cost,
      remainingMinutes: remainingMs === undefined ? undefined : Math.floor(remainingMs / MINUTE_MS),
    };
  }

  private async readIdentity(serial: string): Promise<RemoteDeviceIdentity> {
    try {
      return await this.options.setup.readIdentity(serial);
    } catch (error) {
      // The identity is descriptive; a failed read leaves it unknown rather than the device unusable.
      logger.warn(`Remote device ${serial} identity unavailable: ${errorMessage(error)}`, error);
      return UNKNOWN_IDENTITY;
    }
  }

  /** Undoes a partial acquisition and returns the error to throw. */
  private async abandon(
    sessionId: string,
    connection: RemoteAdbConnection | undefined,
    error: unknown,
  ): Promise<unknown> {
    if (connection) {
      await this.closeQuietly(connection);
    }
    try {
      await this.options.provider.release(sessionId);
      return error;
    } catch (releaseError) {
      logger.warn(
        `Failed to release remote session ${sessionId} after a failed connect`,
        releaseError,
      );
      return new ActionableError(
        `${errorMessage(error)}. Releasing remote session ${sessionId} also failed ` +
          `(${errorMessage(releaseError)}); cancel it in the Google Cloud console so it stops billing.`,
        { cause: error },
      );
    }
  }

  private async closeQuietly(connection: RemoteAdbConnection): Promise<void> {
    try {
      await connection.close();
    } catch (error) {
      // The session is released next, which drops the device whatever adb's state.
      logger.warn(`Failed to close adb connection ${connection.serial}`, error);
    }
  }
}
