/** QR records retain their payload for reporting; injection always uses the generated PNG. */
export type IosCameraPoster =
  | { kind: "image"; path: string }
  | { kind: "qr"; text: string; path: string };

export interface IosCameraPosterRegistry {
  set(udid: string, poster: IosCameraPoster): void;
  get(udid: string): IosCameraPoster | undefined;
  clear(udid: string): void;
}

export class InMemoryIosCameraPosterRegistry implements IosCameraPosterRegistry {
  private readonly posters = new Map<string, IosCameraPoster>();

  set(udid: string, poster: IosCameraPoster): void {
    this.posters.set(udid, { ...poster });
  }

  get(udid: string): IosCameraPoster | undefined {
    const poster = this.posters.get(udid);
    return poster ? { ...poster } : undefined;
  }

  clear(udid: string): void {
    this.posters.delete(udid);
  }
}

export const iosCameraPosterRegistry: IosCameraPosterRegistry =
  new InMemoryIosCameraPosterRegistry();
