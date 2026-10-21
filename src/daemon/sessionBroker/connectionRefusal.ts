import { ActionableError } from "../../models/ActionableError";

/**
 * Typed refusal for a broker connection (a proxy launched with `--session-config`) that tried
 * to control, start, provision or delete anything outside its own initialized grants (#11178). Reads
 * stay open everywhere (owner decision Q6); only control and lifecycle are refused. Not retryable:
 * the connection's binding set is fixed for its lifetime.
 */
export const DEVICE_OUTSIDE_BROKER_GRANT_CODE = "device_outside_broker_grant";

/**
 * `device`: the target device is not one of the connection's granted devices. `session`: the call
 * named a session that is not one of the connection's granted sessions. `tool`: the tool acquires,
 * starts, stops, provisions or deletes devices, which a broker connection leaves to binding
 * acquisition and release; with a `deviceLabel`, a plan device label that would need a device from
 * outside the connection's grants (#11397). `scope`: a reset does not name exactly its own scope.
 * `host`: the action changes state shared by every connection of the daemon.
 */
export type BrokerConnectionRefusalReason = "device" | "session" | "tool" | "host";

export class DeviceOutsideBrokerGrantError extends ActionableError {
  readonly code = DEVICE_OUTSIDE_BROKER_GRANT_CODE;
  readonly retryable = false;

  constructor(
    readonly action: string,
    readonly reason: BrokerConnectionRefusalReason,
    readonly scopeKey: string,
    readonly target: {
      deviceId?: string;
      sessionUuid?: string;
      deviceLabel?: string;
      platform?: string;
    } = {},
  ) {
    super(
      `${action} refused: this broker connection controls only its own granted devices ` +
        `(code ${DEVICE_OUTSIDE_BROKER_GRANT_CODE}). ` +
        brokerConnectionRefusalDetail(reason, target) +
        " Reads stay open; use a separate MCP connection for anything else.",
    );
    this.name = "DeviceOutsideBrokerGrantError";
  }

  /** The wire evidence: the refused target and scope, never another binding's session. */
  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      action: this.action,
      reason: this.reason,
      scopeKey: this.scopeKey,
      ...(this.target.deviceId === undefined ? {} : { deviceId: this.target.deviceId }),
      ...(this.target.sessionUuid === undefined ? {} : { sessionUuid: this.target.sessionUuid }),
      ...(this.target.deviceLabel === undefined ? {} : { deviceLabel: this.target.deviceLabel }),
      ...(this.target.platform === undefined ? {} : { platform: this.target.platform }),
      retryable: false,
    };
  }
}

function brokerConnectionRefusalDetail(
  reason: BrokerConnectionRefusalReason,
  target: { deviceId?: string; sessionUuid?: string; deviceLabel?: string; platform?: string },
): string {
  switch (reason) {
    case "host":
      return "It changes state shared by every connection of this daemon.";
    case "device":
      return target.deviceId === undefined && target.platform !== undefined
        ? `None of its granted devices is an ${target.platform} device; name a device by deviceId to read one outside its grants.`
        : `Device '${target.deviceId}' is not one of its granted devices.`;
    case "session":
      return `Session ${target.sessionUuid} is not one of its granted sessions.`;
    case "tool":
      return (
        (target.deviceLabel === undefined
          ? ""
          : `Device label '${target.deviceLabel}' needs a device its grants do not provide. `) +
        "Granted devices are acquired, started, stopped and deleted only by broker binding " +
        "acquisition and release."
      );
  }
}
