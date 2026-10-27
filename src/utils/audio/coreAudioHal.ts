import { errorMessage } from "../../models/describeUnknownError";
import { logger } from "../logger";
import type { CoreAudioHal, RawAudioDevice } from "./hostAudio";

/** The bun:ffi surface needed for the HAL queries, resolved lazily like the sysctl reader. */
interface FfiModule {
  FFIType: { ptr: number; u32: number; i32: number; i64: number; bool: number; void: number };
  ptr(buffer: Uint32Array | Uint8Array | BigUint64Array): number;
  dlopen<T extends Record<string, { args: number[]; returns: number }>>(
    path: string,
    symbols: T,
  ): { symbols: Record<keyof T, (...args: unknown[]) => unknown> };
}

const COREAUDIO_PATH = "/System/Library/Frameworks/CoreAudio.framework/CoreAudio";
const COREFOUNDATION_PATH = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const SYSTEM_OBJECT = 1;
const UTF8 = 0x08000100;
const NAME_BUFFER_BYTES = 256;

function fourCC(code: string): number {
  return (
    ((code.charCodeAt(0) << 24) |
      (code.charCodeAt(1) << 16) |
      (code.charCodeAt(2) << 8) |
      code.charCodeAt(3)) >>>
    0
  );
}

function codeString(value: number): string {
  return String.fromCharCode(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

const DEFAULT_DEVICE_SELECTOR = { input: fourCC("dIn "), output: fourCC("dOut") } as const;

/**
 * The real CoreAudio HAL binding. Only property queries on the system object and the default
 * devices, so it needs no GUI session or microphone permission. Throws when CoreAudio cannot be
 * loaded; the caller treats that as "no probe".
 */
export function loadCoreAudioHal(): CoreAudioHal {
  const { dlopen, ptr, FFIType } = require("bun:ffi") as FfiModule;
  const audio = dlopen(COREAUDIO_PATH, {
    AudioObjectGetPropertyDataSize: {
      args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    AudioObjectGetPropertyData: {
      args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  }).symbols;
  const foundation = dlopen(COREFOUNDATION_PATH, {
    CFStringGetCString: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.u32],
      returns: FFIType.bool,
    },
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
  }).symbols;

  const address = (selector: string | number, scope: string) =>
    new Uint32Array([typeof selector === "string" ? fourCC(selector) : selector, fourCC(scope), 0]);

  const readU32 = (object: number, selector: string | number, scope = "glob") => {
    const out = new Uint32Array(1);
    const size = new Uint32Array([4]);
    const status = audio.AudioObjectGetPropertyData(
      object,
      ptr(address(selector, scope)),
      0,
      null,
      ptr(size),
      ptr(out),
    );
    return status === 0 ? out[0] : undefined;
  };

  const streamCount = (object: number, scope: "inpt" | "outp") => {
    const size = new Uint32Array(1);
    const status = audio.AudioObjectGetPropertyDataSize(
      object,
      ptr(address("stm#", scope)),
      0,
      null,
      ptr(size),
    );
    // Each stream id is a 4-byte AudioStreamID.
    return status === 0 ? size[0] / 4 : 0;
  };

  const readName = (object: number) => {
    const out = new BigUint64Array(1);
    const size = new Uint32Array([8]);
    const status = audio.AudioObjectGetPropertyData(
      object,
      ptr(address("lnam", "glob")),
      0,
      null,
      ptr(size),
      ptr(out),
    );
    if (status !== 0 || out[0] === 0n) {
      return undefined;
    }
    const ref = Number(out[0]);
    const buffer = new Uint8Array(NAME_BUFFER_BYTES);
    try {
      const ok = foundation.CFStringGetCString(ref, ptr(buffer), NAME_BUFFER_BYTES, UTF8);
      return ok ? new TextDecoder().decode(buffer.subarray(0, buffer.indexOf(0))) : undefined;
    } finally {
      foundation.CFRelease(ref);
    }
  };

  return {
    defaultDeviceId(direction) {
      // kAudioObjectUnknown (0) means there is no default device in that direction.
      const id = readU32(SYSTEM_OBJECT, DEFAULT_DEVICE_SELECTOR[direction]);
      return id ? id : undefined;
    },
    describe(deviceId): RawAudioDevice | undefined {
      try {
        const transport = readU32(deviceId, "tran");
        return {
          name: readName(deviceId),
          transportCode: transport === undefined ? undefined : codeString(transport),
          inputStreams: streamCount(deviceId, "inpt"),
          outputStreams: streamCount(deviceId, "outp"),
        };
      } catch (error) {
        logger.warn(`CoreAudio describe failed for device ${deviceId}: ${errorMessage(error)}`);
        return undefined;
      }
    },
  };
}
