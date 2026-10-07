import { errorMessage } from "../../utils/describeUnknownError";
import { BootedDevice, PhoneCallAction, PhoneCallResult, SendSmsResult } from "../../models";
import {
  EmulatorConsoleClient,
  RealEmulatorConsoleClient,
  FileEmulatorConsoleAuthTokenReader,
  NetEmulatorConsoleTransport,
  consolePortFromSerial,
} from "../../utils/android-cmdline-tools/EmulatorConsoleClient";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import {
  defaultIosSdkTriggerSenderFactory,
  describeIosSdkTriggerFailure,
  type IosSdkTriggerSenderFactory,
} from "./IosSdkTrigger";
import type { CtrlProxySdkTriggerResult } from "../observe/ios/types";

/**
 * Factory for building an EmulatorConsoleClient for a specific emulator console port.
 * Injectable so tests can substitute a fake without hitting the network.
 */
export type EmulatorConsoleClientFactory = (port: number) => EmulatorConsoleClient;

export const defaultEmulatorConsoleClientFactory: EmulatorConsoleClientFactory = (port: number) =>
  new RealEmulatorConsoleClient(
    port,
    new NetEmulatorConsoleTransport(),
    new FileEmulatorConsoleAuthTokenReader(),
  );

/** iOS SDK trigger modules that stand in for the Android emulator console (#1580). */
export const IOS_CALLKIT_MODULE = "callkit";
export const IOS_MESSAGES_MODULE = "messages";

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
    private readonly consoleFactory: EmulatorConsoleClientFactory = defaultEmulatorConsoleClientFactory,
    private readonly iosSdkTriggers: IosSdkTriggerSenderFactory = defaultIosSdkTriggerSenderFactory,
  ) {
    if (
      adbFactoryOrExecutor &&
      typeof (adbFactoryOrExecutor as AdbClientFactory).create === "function"
    ) {
      this.adb = (adbFactoryOrExecutor as AdbClientFactory).create(device);
    } else if (adbFactoryOrExecutor) {
      this.adb = adbFactoryOrExecutor as AdbExecutor;
    } else {
      this.adb = defaultAdbClientFactory.create(device);
    }
  }

  async phoneCall(options: PhoneCallOptions): Promise<PhoneCallResult> {
    if (this.device.platform === "ios") {
      return this.phoneCallIos(options);
    }
    const platformError = this.requireAndroid<PhoneCallResult>(() => ({
      success: false,
      action: options.action,
      phoneNumber: options.phoneNumber,
      supported: false,
      error: "Emulator telephony is only supported on Android emulators",
    }));
    if (platformError) {
      return platformError;
    }

    if (options.action !== "hold" && !options.phoneNumber) {
      return {
        success: false,
        action: options.action,
        supported: true,
        error: `phoneNumber is required for action '${options.action}'`,
      };
    }

    const client = await this.resolveClient<PhoneCallResult>(() => ({
      success: false,
      action: options.action,
      phoneNumber: options.phoneNumber,
      supported: false,
      error: this.unsupportedDeviceMessage(),
    }));
    if ("error" in client) {
      return client.error;
    }

    try {
      switch (options.action) {
        case "call":
          await client.value.gsmCall(options.phoneNumber!);
          break;
        case "accept":
          await client.value.gsmAccept(options.phoneNumber!);
          break;
        case "cancel":
          await client.value.gsmCancel(options.phoneNumber!);
          break;
        case "busy":
          await client.value.gsmBusy(options.phoneNumber!);
          break;
        case "hold":
          await client.value.gsmHold();
          break;
      }
      return {
        success: true,
        action: options.action,
        phoneNumber: options.phoneNumber,
        supported: true,
        message: this.phoneCallSuccessMessage(options),
      };
    } catch (error) {
      logger.warn(`[Telephony] Simulated phone call failed: ${errorMessage(error)}`);
      return {
        success: false,
        action: options.action,
        phoneNumber: options.phoneNumber,
        supported: true,
        error: errorMessage(error),
      };
    }
  }

  async sendSms(options: SendSmsOptions): Promise<SendSmsResult> {
    if (this.device.platform === "ios") {
      return this.sendSmsIos(options);
    }
    const platformError = this.requireAndroid<SendSmsResult>(() => ({
      success: false,
      phoneNumber: options.phoneNumber,
      messageLength: options.message?.length ?? 0,
      supported: false,
      error: "Emulator telephony is only supported on Android emulators",
    }));
    if (platformError) {
      return platformError;
    }

    const client = await this.resolveClient<SendSmsResult>(() => ({
      success: false,
      phoneNumber: options.phoneNumber,
      messageLength: options.message?.length ?? 0,
      supported: false,
      error: this.unsupportedDeviceMessage(),
    }));
    if ("error" in client) {
      return client.error;
    }

    try {
      await client.value.smsSend(options.phoneNumber, options.message);
      return {
        success: true,
        phoneNumber: options.phoneNumber,
        messageLength: options.message.length,
        supported: true,
        message: `Delivered simulated SMS from ${options.phoneNumber} (${options.message.length} chars)`,
      };
    } catch (error) {
      logger.warn(`[Telephony] Simulated SMS delivery failed: ${errorMessage(error)}`);
      return {
        success: false,
        phoneNumber: options.phoneNumber,
        messageLength: options.message.length,
        supported: true,
        error: errorMessage(error),
      };
    }
  }

  /**
   * iOS has no telephony injection API, so the call is reported through CallKit by the
   * app's in-app AutoMobile SDK (`callkit` trigger module). Trigger names match the
   * tool's actions one to one.
   */
  private async phoneCallIos(options: PhoneCallOptions): Promise<PhoneCallResult> {
    const base = { action: options.action, phoneNumber: options.phoneNumber };
    if (options.action !== "hold" && !options.phoneNumber) {
      return {
        ...base,
        success: false,
        supported: true,
        error: `phoneNumber is required for action '${options.action}'`,
      };
    }
    const request = {
      module: IOS_CALLKIT_MODULE,
      trigger: options.action,
      ...(options.phoneNumber ? { payload: { phoneNumber: options.phoneNumber } } : {}),
    };
    const result = await this.sendIosTrigger(request);
    if (!result.success) {
      return {
        ...base,
        success: false,
        supported: result.available,
        error: describeIosSdkTriggerFailure(result, request, "phoneCall"),
      };
    }
    return {
      ...base,
      success: true,
      supported: true,
      message: `${this.phoneCallSuccessMessage(options)} through CallKit in the app's AutoMobile SDK`,
    };
  }

  /** iOS: the app's in-app SDK posts an SMS-style local notification (`messages` module). */
  private async sendSmsIos(options: SendSmsOptions): Promise<SendSmsResult> {
    const base = { phoneNumber: options.phoneNumber, messageLength: options.message.length };
    const request = {
      module: IOS_MESSAGES_MODULE,
      trigger: "sms",
      payload: { phoneNumber: options.phoneNumber, message: options.message },
    };
    const result = await this.sendIosTrigger(request);
    if (!result.success) {
      return {
        ...base,
        success: false,
        supported: result.available,
        error: describeIosSdkTriggerFailure(result, request, "sendSms"),
      };
    }
    return {
      ...base,
      success: true,
      supported: true,
      message:
        `Posted an SMS-style notification from ${options.phoneNumber} ` +
        `(${options.message.length} chars) through the app's AutoMobile SDK`,
    };
  }

  private async sendIosTrigger(request: {
    module: string;
    trigger: string;
    payload?: Record<string, unknown>;
  }): Promise<CtrlProxySdkTriggerResult> {
    try {
      return await this.iosSdkTriggers(this.device).requestSdkTrigger(request);
    } catch (error) {
      logger.warn(
        `[Telephony] iOS SDK trigger ${request.module}.${request.trigger} failed: ${errorMessage(error)}`,
      );
      return { success: false, available: true, totalTimeMs: 0, error: errorMessage(error) };
    }
  }

  private requireAndroid<T>(build: () => T): T | null {
    if (this.device.platform !== "android") {
      return build();
    }
    return null;
  }

  private async resolveClient<T>(
    buildError: () => T,
  ): Promise<{ value: EmulatorConsoleClient } | { error: T }> {
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
      logger.warn(
        `Telephony: failed to probe emulator state for ${this.device.deviceId}: ${error}`,
      );
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
      case "call":
        return `Simulated incoming call from ${options.phoneNumber}`;
      case "accept":
        return `Accepted call ${options.phoneNumber}`;
      case "cancel":
        return `Cancelled call ${options.phoneNumber}`;
      case "busy":
        return `Rejected call ${options.phoneNumber} with busy signal`;
      case "hold":
        return "Put active call on hold";
    }
  }
}
