import type { BootedDevice } from "../../../models";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import { errorMessage } from "../../../utils/describeUnknownError";
import { isIosSimulatorDevice } from "../../action/IosSimulatorPermissions";
import {
  IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS,
  iosNotifyutilGetCommand,
  iosNotifyutilRegisteredSetReadPostCommand,
  parseNotifyutilState,
} from "../../../utils/ios-cmdline-tools/notifyutil";
import {
  IOS_BIOMETRIC_ENROLLMENT_NOTIFICATION,
  IOS_BIOMETRICS_UNSUPPORTED_ERROR,
  type BiometricEnrollment,
  type BiometricEnrollmentState,
} from "./BiometricState";
import type { IosSimulatorClient } from "./DeviceStateTypes";

interface BiometricOperationsDependencies {
  device: () => BootedDevice;
  simctl: () => IosSimulatorClient | null;
}

export class BiometricOperations {
  constructor(private readonly dependencies: BiometricOperationsDependencies) {}

  async getBiometricEnrollmentState(): Promise<BiometricEnrollmentState> {
    if (
      this.dependencies.device().platform !== "ios" ||
      !isIosSimulatorDevice(this.dependencies.device())
    ) {
      return { supported: false, error: IOS_BIOMETRICS_UNSUPPORTED_ERROR };
    }
    const simctl = this.dependencies.simctl() ?? new SimCtlClient(this.dependencies.device());
    try {
      const result = await simctl.executeCommand(
        iosNotifyutilGetCommand(
          this.dependencies.device().deviceId,
          IOS_BIOMETRIC_ENROLLMENT_NOTIFICATION,
        ),
      );
      const stderr = result.stderr?.trim();
      if (stderr) {
        return {
          supported: true,
          method: "ios_simulator_notifyutil",
          error: `notifyutil failed: ${stderr}`,
        };
      }
      const enrolled = parseNotifyutilState(result.stdout);
      if (enrolled === null) {
        return {
          supported: true,
          method: "ios_simulator_notifyutil",
          error: "Could not parse iOS Simulator biometric enrollment state from notifyutil.",
        };
      }
      return {
        supported: true,
        enrollment: enrolled ? "enrolled" : "not_enrolled",
        method: "ios_simulator_notifyutil",
        verified: true,
      };
    } catch (error) {
      return {
        supported: true,
        method: "ios_simulator_notifyutil",
        error: errorMessage(error),
      };
    }
  }

  async setBiometricEnrollmentState(
    enrollment: BiometricEnrollment,
  ): Promise<BiometricEnrollmentState> {
    if (
      this.dependencies.device().platform !== "ios" ||
      !isIosSimulatorDevice(this.dependencies.device())
    ) {
      return {
        supported: false,
        enrollment,
        verified: false,
        error: IOS_BIOMETRICS_UNSUPPORTED_ERROR,
      };
    }
    const simctl = this.dependencies.simctl() ?? new SimCtlClient(this.dependencies.device());
    try {
      const result = await simctl.executeCommand(
        iosNotifyutilRegisteredSetReadPostCommand(
          this.dependencies.device().deviceId,
          IOS_BIOMETRIC_ENROLLMENT_NOTIFICATION,
          enrollment === "enrolled" ? "1" : "0",
        ),
        IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS,
      );
      const stderr = result.stderr?.trim();
      if (stderr) {
        return {
          supported: true,
          enrollment,
          method: "ios_simulator_notifyutil",
          verified: false,
          error: `notifyutil failed: ${stderr}`,
        };
      }
      const enrolled = parseNotifyutilState(result.stdout);
      const verified = enrolled === (enrollment === "enrolled");
      return {
        supported: true,
        ...(enrolled === null ? {} : { enrollment: enrolled ? "enrolled" : "not_enrolled" }),
        method: "ios_simulator_notifyutil",
        verified,
        ...(verified
          ? {}
          : {
              error: `iOS Simulator biometric enrollment did not verify: expected ${enrollment}.`,
            }),
      };
    } catch (error) {
      return {
        supported: true,
        enrollment,
        method: "ios_simulator_notifyutil",
        verified: false,
        error: errorMessage(error),
      };
    }
  }
}
