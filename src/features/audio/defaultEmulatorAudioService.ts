import { readFile, stat } from "node:fs/promises";
import { EmulatorAudioClient } from "../../utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioClient";
import { createGrpcAuthorizer } from "../../utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcAuth";
import { FileEmulatorGrpcDiscovery } from "../../utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import { Http2GrpcTransport } from "../../utils/android-cmdline-tools/emulatorGrpc/grpcTransport";
import { DefaultFileSystem } from "../../utils/filesystem/DefaultFileSystem";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import { EmulatorAudioService } from "./EmulatorAudioService";

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
    readFile: (path) => readFile(path),
    fileSize: async (path) => (await stat(path)).size,
    ids: defaultIdGenerator,
  });
}

/** One per process, so a stop or a session release finds injections any tool call started. */
export const defaultEmulatorAudioService = createEmulatorAudioService();
