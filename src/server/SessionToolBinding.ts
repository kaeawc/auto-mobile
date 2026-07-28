export class SessionToolBinding {
  private readonly boundDeviceSessions = new Map<string, string>();

  effectiveSessionUuid(mcpSessionId: string | undefined, params?: unknown): string | undefined {
    const explicit = params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>).sessionUuid
      : undefined;
    return typeof explicit === "string"
      ? explicit
      : mcpSessionId
        ? this.boundDeviceSessions.get(mcpSessionId)
        : undefined;
  }

  bind(mcpSessionId: string | undefined, sessionUuid: string | undefined): boolean {
    if (!mcpSessionId || !sessionUuid || this.boundDeviceSessions.get(mcpSessionId) === sessionUuid) {
      return false;
    }
    this.boundDeviceSessions.set(mcpSessionId, sessionUuid);
    return true;
  }
}
