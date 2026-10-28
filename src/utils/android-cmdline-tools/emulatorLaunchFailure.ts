import type { LaunchFailureCategory } from "./EmulatorLaunchSupport";

/** Pure classifiers over captured emulator stdout/stderr. No I/O, no client state. */

export function detectArchitecturePanic(output: string): {
  isPanic: boolean;
  message?: string;
  hostArch?: string;
  avdArch?: string;
} {
  // Look for the specific PANIC message about architecture compatibility
  const panicMatch = output.match(
    /PANIC: Avd's CPU Architecture '(\w+)' is not supported by the QEMU2 emulator on (\w+) host/,
  );

  if (panicMatch) {
    const avdArch = panicMatch[1];
    const hostArch = panicMatch[2];
    return {
      isPanic: true,
      message: `AVD architecture '${avdArch}' is not supported on ${hostArch} host`,
      hostArch,
      avdArch,
    };
  }

  // Check for other PANIC messages that might be architecture-related
  if (
    output.includes("PANIC:") &&
    (output.includes("architecture") || output.includes("CPU") || output.includes("QEMU"))
  ) {
    return {
      isPanic: true,
      message: "Emulator PANIC detected (possibly architecture-related)",
    };
  }

  return { isPanic: false };
}

export function detectSandboxMprotect(output: string): {
  isSandboxError: boolean;
  message?: string;
  suggestion?: string;
} {
  const mprotectFailure = /qemu_mprotect__osdep:\s*mprotect failed:\s*permission denied/i.test(
    output,
  );
  const hvfFailure =
    /hvf is not enabled on this aarch64 host|HVF error:\s*HV_(?:UNSUPPORTED|ERROR)|failed to initialize HVF:\s*Invalid argument/i.test(
      output,
    );
  if (!mprotectFailure && !hvfFailure) {
    return { isSandboxError: false };
  }

  return {
    isSandboxError: true,
    message: "Emulator hypervisor initialization failed (mprotect/HVF is unavailable)",
    suggestion:
      "Run the emulator outside the restrictive sandbox or grant the host hypervisor/JIT entitlement required by QEMU.",
  };
}

export function detectCorruptImage(output: string): {
  isCorrupt: boolean;
  message?: string;
  suggestion?: string;
} {
  // qcow2 corruption: "qcow2: Image is corrupt; cannot be opened read/write"
  const qcow2Match = output.match(/qcow2:\s*(.*corrupt[^"\n]*)/i);
  if (qcow2Match) {
    return {
      isCorrupt: true,
      message: `Disk image is corrupt: ${qcow2Match[1].trim()}`,
      suggestion:
        "Delete the corrupt userdata overlay to force a fresh image:\n  rm ~/.android/avd/<AVD_NAME>.avd/userdata-qcow2.img\n  rm ~/.android/avd/<AVD_NAME>.avd/userdata-qcow2.img.qcow2\nThe emulator will recreate it on next boot. All emulator data (installed apps, settings) will be lost.",
    };
  }

  // Generic disk image errors
  const diskErrorMatch = output.match(
    /(cannot open disk image|disk image .* is (?:corrupt|invalid|damaged)|failed to open .*\.img)/i,
  );
  if (diskErrorMatch) {
    return {
      isCorrupt: true,
      message: `Disk image error: ${diskErrorMatch[1].trim()}`,
      suggestion:
        "Try deleting corrupt overlay files in ~/.android/avd/<AVD_NAME>.avd/ and restarting the emulator.",
    };
  }

  // QEMU abnormal exit with corruption context
  if (
    output.includes("QEMU main loop exits abnormally") &&
    (output.includes("corrupt") || output.includes("qcow2"))
  ) {
    return {
      isCorrupt: true,
      message: "QEMU exited abnormally due to disk image corruption",
      suggestion:
        "Delete the corrupt userdata overlay to force a fresh image:\n  rm ~/.android/avd/<AVD_NAME>.avd/userdata-qcow2.img\n  rm ~/.android/avd/<AVD_NAME>.avd/userdata-qcow2.img.qcow2\nThe emulator will recreate it on next boot.",
    };
  }

  return { isCorrupt: false };
}

export function detectDisplayError(output: string): {
  isDisplayError: boolean;
  message?: string;
  suggestion?: string;
} {
  const noDisplay = /could not connect to display/i.test(output);
  const qtPlugin = /could not load the Qt platform plugin/i.test(output);

  if (noDisplay || qtPlugin) {
    return {
      isDisplayError: true,
      message: "Emulator could not connect to a display (Qt 'xcb' platform plugin failed to load)",
      suggestion:
        "Run the emulator headless by setting AUTOMOBILE_EMULATOR_HEADLESS=true " +
        "(adds -no-window; audio stays on), or start an X server / export DISPLAY before launching. " +
        "Do not add -no-audio (AUTOMOBILE_EMULATOR_AUDIO=false) when tests record or play audio: " +
        "it disables emulator audio, so audio tests cannot pass.",
    };
  }

  return { isDisplayError: false };
}

export function launchFailureCategory(output: string): LaunchFailureCategory | undefined {
  if (/error while loading shared libraries/i.test(output)) {
    return "missing_shared_library";
  }
  if (
    /ProbeKVM[\s\S]*(?:permission denied|operation not permitted)/i.test(output) ||
    /\/dev\/kvm[\s\S]*(?:permission denied|operation not permitted)/i.test(output) ||
    /permissions? to use KVM/i.test(output)
  ) {
    return "kvm_permission_denied";
  }
  return undefined;
}

export function accelerationCheckCategory(output: string): LaunchFailureCategory | undefined {
  const kvmCategory = launchFailureCategory(output);
  if (kvmCategory) {
    return kvmCategory;
  }
  if (
    /(?:acceleration|KVM|hypervisor)/i.test(output) &&
    /(?:not available|unavailable|not supported|not enabled|cannot use|disabled)/i.test(output)
  ) {
    return "hardware_acceleration_unavailable";
  }
  return undefined;
}

export function detectDeviceIdFromEmulatorOutput(output: string): string | undefined {
  const explicitDeviceId = output.match(/\bemulator-(\d{4,5})\b/);
  if (explicitDeviceId) {
    return `emulator-${explicitDeviceId[1]}`;
  }

  const consolePort = output.match(/\bconsole(?:\s+on)?\s+port\s*(?:=|:|\s)\s*(\d{4,5})\b/i);
  if (!consolePort) {
    return undefined;
  }

  const port = Number.parseInt(consolePort[1], 10);
  if (port < 5554 || port % 2 !== 0) {
    return undefined;
  }

  return `emulator-${port}`;
}
