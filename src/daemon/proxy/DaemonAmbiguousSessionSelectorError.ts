/** A platform-only control selector matches several sessions this connection holds. */
export class DaemonAmbiguousSessionSelectorError extends Error {
  constructor(
    readonly platform: "android" | "ios",
    readonly candidates: ReadonlyArray<{ sessionUuid: string; deviceId?: string }>,
  ) {
    const sessions = candidates
      .map(({ sessionUuid, deviceId }) =>
        deviceId === undefined ? sessionUuid : `${sessionUuid} (device '${deviceId}')`,
      )
      .join(", ");
    super(
      `Platform '${platform}' alone matches ${candidates.length} device sessions this MCP connection holds: ` +
        `${sessions}. Name one with sessionUuid or deviceId.`,
    );
    this.name = "DaemonAmbiguousSessionSelectorError";
  }
}
