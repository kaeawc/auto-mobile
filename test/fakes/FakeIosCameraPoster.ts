import type {
  IosCameraPoster,
  IosCameraPosterRegistry,
} from "../../src/features/utility/ios/IosCameraPosterRegistry";
import type { IosCameraPosterDylibProvider } from "../../src/features/utility/ios/IosCameraPosterDylibProvider";
import type {
  IosCameraPosterActivation,
  IosCameraPosterActivationStore,
} from "../../src/features/utility/ios/IosCameraPosterActivationStore";
import type { SimulatorBootEnvironment } from "../../src/features/utility/ios/SimulatorBootEnvironment";

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

export class FakeIosCameraPosterActivationStore implements IosCameraPosterActivationStore {
  readonly records = new Map<string, IosCameraPosterActivation>();
  readonly installed: string[] = [];
  stableGate = "/data/ios-camera-poster-active/libAMCameraPosterGate.dylib";
  read(udid: string): IosCameraPosterActivation | undefined {
    return this.records.get(udid);
  }
  write(udid: string, activation: IosCameraPosterActivation): void {
    this.records.set(udid, { ...activation });
  }
  remove(udid: string): void {
    this.records.delete(udid);
  }
  list(): string[] {
    return [...this.records.keys()];
  }
  installGate(built: string): string {
    this.installed.push(built);
    return this.stableGate;
  }
}

export class FakeSimulatorBootEnvironment implements SimulatorBootEnvironment {
  value = "";
  async dyldInsertLibraries(): Promise<string> {
    return this.value;
  }
}
