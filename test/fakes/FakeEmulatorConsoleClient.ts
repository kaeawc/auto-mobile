import { EmulatorConsoleClient } from "../../src/utils/android-cmdline-tools/EmulatorConsoleClient";

export interface RecordedConsoleCall {
  method: "gsmCall" | "gsmAccept" | "gsmCancel" | "gsmBusy" | "gsmHold" | "smsSend";
  args: string[];
}

export class FakeEmulatorConsoleClient implements EmulatorConsoleClient {
  public readonly calls: RecordedConsoleCall[] = [];
  public failures: Map<RecordedConsoleCall["method"], Error> = new Map();

  failNext(method: RecordedConsoleCall["method"], error: Error): void {
    this.failures.set(method, error);
  }

  private record(method: RecordedConsoleCall["method"], args: string[]): Promise<void> {
    this.calls.push({ method, args });
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      return Promise.reject(failure);
    }
    return Promise.resolve();
  }

  gsmCall(phoneNumber: string): Promise<void> {
    return this.record("gsmCall", [phoneNumber]);
  }
  gsmAccept(phoneNumber: string): Promise<void> {
    return this.record("gsmAccept", [phoneNumber]);
  }
  gsmCancel(phoneNumber: string): Promise<void> {
    return this.record("gsmCancel", [phoneNumber]);
  }
  gsmBusy(phoneNumber: string): Promise<void> {
    return this.record("gsmBusy", [phoneNumber]);
  }
  gsmHold(): Promise<void> {
    return this.record("gsmHold", []);
  }
  smsSend(phoneNumber: string, message: string): Promise<void> {
    return this.record("smsSend", [phoneNumber, message]);
  }
}
