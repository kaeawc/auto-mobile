/** A file `heapDump` has put, or is about to put, on a device. */
export interface DeviceFileRecord {
  deviceId: string;
  sessionId?: string;
  remotePath: string;
}

/** Everything one session left on one device. */
export interface SessionProfilingState {
  deviceFiles: DeviceFileRecord[];
}

/**
 * In-memory record of the device-side files of in-flight heap dumps (#14113), so a released
 * session's leftovers are removed. Like the other restore registries it is never persisted; a
 * daemon restart loses it.
 */
export class ProfilingRegistry {
  private readonly deviceFiles = new Map<string, DeviceFileRecord>();

  addDeviceFile(record: DeviceFileRecord): void {
    this.deviceFiles.set(`${record.deviceId}\0${record.remotePath}`, record);
  }

  removeDeviceFile(deviceId: string, remotePath: string): void {
    this.deviceFiles.delete(`${deviceId}\0${remotePath}`);
  }

  /** Remove and return what `sessionId` left on `deviceId`; empty when it left nothing. */
  takeOwnedBy(deviceId: string, sessionId: string): SessionProfilingState {
    const deviceFiles = [...this.deviceFiles.values()].filter(
      (file) => file.deviceId === deviceId && file.sessionId === sessionId,
    );
    deviceFiles.forEach((file) => this.removeDeviceFile(file.deviceId, file.remotePath));
    return { deviceFiles };
  }
}

export const defaultProfilingRegistry = new ProfilingRegistry();
