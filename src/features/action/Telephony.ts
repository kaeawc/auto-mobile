import { errorMessage } from "../../utils/describeUnknownError";
import {
  BootedDevice,
  PhoneCallAction,
  PhoneCallResult,
  SendSmsResult
} from "../../models";
import {
  EmulatorConsoleClient,
  RealEmulatorConsoleClient,
  FileEmulatorConsoleAuthTokenReader,
  NetEmulatorConsoleTransport,
  consolePortFromSerial
} from "../../utils/android-cmdline-tools/EmulatorConsoleClient";
import { AdbClientFactory, defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";

/**
 * Factory for building an EmulatorConsoleClient for a specific emulator console port.
 * Injectable so tests can substitute a fake without hitting the network.
 */
export type EmulatorConsoleClientFactory = (port: number) => EmulatorConsoleClient;

export const defaultEmulatorConsoleClientFactory: EmulatorConsoleClientFactory = (port: number) =>
  new RealEmulatorConsoleClient(
    port,
    new NetEmulatorConsoleTransport(),
    new FileEmulatorConsoleAuthTokenReader()
  );

export interface PhoneCallOptions {
  action: PhoneCallAction;
  phoneNumber?: string;
}

export interface SendSmsOptions {
  phoneNumber: string;
  message: string;
}

export class Telephony {
  private readonly adb: AdbExecutor;

  constructor(
    private readonly device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = defaultAdbClientFactory,
    private readonly consoleFactory: EmulatorConsoleClientFactory = defaultEmulatorConsoleClientFactory
  ) {
    if (adbFactoryOrExecutor && typeof (adbFactoryOrExecutor as AdbClientFactory).create === "function") {
      this.adb = (adbFactoryOrExecutor as AdbClientFactory).create(device);
    } else if (adbFactoryOrExecutor) {
      this.adb = adbFactoryOrExecutor as AdbExecutor;
    } else {
      this.adb = defaultAdbClientFactory.create(device);
    }
  }

  async phoneCall(options: PhoneCallOptions): Promise<PhoneCallResult> {
    const platformError = this.requireAndroid<PhoneCallResult>(() => ({
      success: false,
      action: options.action,
      phoneNumber: options.phoneNumber,
      supported: false,
      error: "Emulator telephony is only supported on Android emulators"
    }));
    if (platformError) { return platformError; }

    if (options.action !== "hold" && !options.phoneNumber) {
      return {
        success: false,
        action: options.action,
        supported: true,
        error: `phoneNumber is required for action '${options.action}'`
      };
    }

    const client = await this.resolveClient<PhoneCallResult>(() => ({
      success: false,
      action: options.action,
      phoneNumber: options.phoneNumber,
      supported: false,
      error: this.unsupportedDeviceMessage()
    }));
    if ("error" in client) { return client.error; }

    try {
      switch (options.action) {
        case "call":   await client.value.gsmCall(options.phoneNumber!);   break;
        case "accept": await client.value.gsmAccept(options.phoneNumber!); break;
        case "cancel": await client.value.gsmCancel(options.phoneNumber!); break;
        case "busy":   await client.value.gsmBusy(options.phoneNumber!);   break;
        case "hold":   await client.value.gsmHold();                       break;
      }
      return {
        success: true,
        action: options.action,
        phoneNumber: options.phoneNumber,
        supported: true,
        message: this.phoneCallSuccessMessage(options)
      };
    } catch (error) {
      return {
        success: false,
        action: options.action,
        phoneNumber: options.phoneNumber,
        supported: true,
        error: errorMessage(error)
      };
    }
  }

  async sendSms(options: SendSmsOptions): Promise<SendSmsResult> {
    const platformError = this.requireAndroid<SendSmsResult>(() => ({
      success: false,
      phoneNumber: options.phoneNumber,
      messageLength: options.message?.length ?? 0,
      supported: false,
      error: "Emulator telephony is only supported on Android emulators"
    }));
    if (platformError) { return platformError; }

    const client = await this.resolveClient<SendSmsResult>(() => ({
      success: false,
      phoneNumber: options.phoneNumber,
      messageLength: options.message?.length ?? 0,
      supported: false,
      error: this.unsupportedDeviceMessage()
    }));
    if ("error" in client) { return client.error; }

    try {
      await client.value.smsSend(options.phoneNumber, options.message);
      return {
        success: true,
        phoneNumber: options.phoneNumber,
        messageLength: options.message.length,
        supported: true,
        message: `Delivered simulated SMS from ${options.phoneNumber} (${options.message.length} chars)`
      };
    } catch (error) {
      return {
        success: false,
        phoneNumber: options.phoneNumber,
        messageLength: options.message.length,
        supported: true,
        error: errorMessage(error)
      };
    }
  }

  private requireAndroid<T>(build: () => T): T | null {
    if (this.device.platform !== "android") {
      return build();
    }
    return null;
  }

  private async resolveClient<T>(buildError: () => T): Promise<{ value: EmulatorConsoleClient } | { error: T }> {
    const port = consolePortFromSerial(this.device.deviceId);
    if (port === null) {
      return { error: buildError() };
    }
    const isEmulator = await this.isEmulator();
    if (!isEmulator) {
      return { error: buildError() };
    }
    return { value: this.consoleFactory(port) };
  }

  private async isEmulator(): Promise<boolean> {
    try {
      const result = await this.adb.executeCommand("shell getprop ro.kernel.qemu");
      return result.stdout.trim() === "1";
    } catch (error) {
      logger.warn(`Telephony: failed to probe emulator state for ${this.device.deviceId}: ${error}`);
      return false;
    }
  }

  private unsupportedDeviceMessage(): string {
    return (
      `Device '${this.device.deviceId}' does not appear to be an Android emulator. ` +
      `Emulator console telephony (gsm/sms) is only available on emulators with serials of the form 'emulator-<port>'.`
    );
  }

  private phoneCallSuccessMessage(options: PhoneCallOptions): string {
    switch (options.action) {
      case "call":   return `Simulated incoming call from ${options.phoneNumber}`;
      case "accept": return `Accepted call ${options.phoneNumber}`;
      case "cancel": return `Cancelled call ${options.phoneNumber}`;
      case "busy":   return `Rejected call ${options.phoneNumber} with busy signal`;
      case "hold":   return "Put active call on hold";
    }
  }
}
