import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { ActionableError } from "../../models/ActionableError";
import { EmulatorAudioClient } from "../../utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioClient";
import { createGrpcAuthorizer } from "../../utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcAuth";
import { FileEmulatorGrpcDiscovery } from "../../utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import { Http2GrpcTransport } from "../../utils/android-cmdline-tools/emulatorGrpc/grpcTransport";
import { DefaultFileSystem } from "../../utils/filesystem/DefaultFileSystem";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import { audioSourceTooLarge, EmulatorAudioService } from "./EmulatorAudioService";

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Reads a regular file of at most `maxBytes`. The cap applies to the bytes actually read, so a
 * file that grows after it is opened cannot exceed it; device files are refused outright.
 */
function notRegularFile(path: string): ActionableError {
  return new ActionableError(`Audio file ${path} is not a regular file.`);
}

export async function readRegularFileCapped(path: string, maxBytes: number): Promise<Uint8Array> {
  // Check the type before opening: opening a FIFO with no writer blocks. Non-blocking open and a
  // second check on the handle cover a path swapped for a special file in between.
  if (!(await stat(path)).isFile()) {
    throw notRegularFile(path);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) {
      throw notRegularFile(path);
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const chunk = new Uint8Array(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
      if (length > maxBytes) {
        throw audioSourceTooLarge(path, maxBytes);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, length);
  } finally {
    await handle.close();
  }
}

/** The service over each emulator's real gRPC endpoint, as discovered on this host. */
export function createEmulatorAudioService(): EmulatorAudioService {
  const fs = new DefaultFileSystem();
  return new EmulatorAudioService({
    discovery: new FileEmulatorGrpcDiscovery(fs),
    createSession: (endpoint) =>
      new EmulatorAudioClient(
        new Http2GrpcTransport(endpoint.address),
        createGrpcAuthorizer(endpoint.auth, fs),
      ),
    readFile: readRegularFileCapped,
    ids: defaultIdGenerator,
  });
}

/** One per process, so a stop or a session release finds injections any tool call started. */
export const defaultEmulatorAudioService = createEmulatorAudioService();
