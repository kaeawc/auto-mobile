interface SyncableFile {
  sync(): Promise<void>;
}

export const noOpSnapshotDirectorySync = async (_dirPath: string): Promise<void> => {};

export const noOpSnapshotFileSync = async (_file: SyncableFile): Promise<void> => {};
