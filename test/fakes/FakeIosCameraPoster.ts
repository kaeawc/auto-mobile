import type {
  IosCameraPoster,
  IosCameraPosterRegistry,
} from "../../src/features/utility/ios/IosCameraPosterRegistry";
import type { IosCameraPosterDylibProvider } from "../../src/features/utility/ios/IosCameraPosterDylibProvider";

export class FakeIosCameraPosterRegistry implements IosCameraPosterRegistry {
  readonly posters = new Map<string, IosCameraPoster>();
  set(udid: string, poster: IosCameraPoster): void {
    this.posters.set(udid, { ...poster });
  }
  get(udid: string): IosCameraPoster | undefined {
    return this.posters.get(udid);
  }
  clear(udid: string): void {
    this.posters.delete(udid);
  }
}

export class FakeIosCameraPosterDylibProvider implements IosCameraPosterDylibProvider {
  calls = 0;
  path = "/camera/libAMCameraPoster.dylib";
  error?: Error;
  async ensure(): Promise<string> {
    this.calls++;
    if (this.error) {
      throw this.error;
    }
    return this.path;
  }
}
