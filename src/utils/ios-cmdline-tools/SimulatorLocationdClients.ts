import * as os from "node:os";
import { join } from "node:path";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { PlistClient } from "./PlistClient";
import { defaultDeviceSetRoot } from "./SimulatorTccSqliteClient";
import { parsePlist } from "./XctestrunPlist";

/**
 * Reads a simulator app's location authorization. The simulator keeps it in locationd's
 * `clients.plist`, not in TCC.db, so a TCC read never sees a location grant (#19370).
 */
export interface SimulatorLocationAuthorizationReader {
  /** locationd's `Authorization` value for the bundle, or null when none is recorded. */
  readLocationAuthorization(deviceId: string, bundleId: string): Promise<number | null>;
}

export interface SimulatorLocationdClientsDeps {
  /** Run `plutil -convert xml1 -o - -- <path>` and return the XML. */
  plutilToXml(path: string): Promise<string>;
  /** Absolute path of a simulator device root (…/CoreSimulator/Devices/<udid>). */
  deviceDataRoot(udid: string): string;
}

/**
 * The `Authorization` integer under `i<bundleId>:` in the `clients.plist` XML, or null when the
 * bundle has no entry or the entry has no `Authorization` (`simctl privacy reset` removes it).
 */
export async function parseLocationdAuthorization(
  xml: string,
  bundleId: string,
): Promise<number | null> {
  const root = await parsePlist(xml);
  if (!(root instanceof Map)) {
    return null;
  }
  const client = root.get(`i${bundleId}:`);
  if (!(client instanceof Map)) {
    return null;
  }
  const value = client.get("Authorization");
  return typeof value === "number" ? value : null;
}

export class SimulatorLocationdClientsReader implements SimulatorLocationAuthorizationReader {
  constructor(private readonly deps: SimulatorLocationdClientsDeps) {}

  async readLocationAuthorization(deviceId: string, bundleId: string): Promise<number | null> {
    const path = join(
      this.deps.deviceDataRoot(deviceId),
      "data/Library/Caches/locationd/clients.plist",
    );
    let xml: string;
    try {
      xml = await this.deps.plutilToXml(path);
    } catch (error) {
      // locationd writes no clients.plist until a client is recorded, so nothing is decided yet.
      logger.debug(`[iOS] No locationd clients.plist (${path}): ${errorMessage(error)}`);
      return null;
    }
    return parseLocationdAuthorization(xml, bundleId);
  }
}

/** Wire the real deps: host `plutil` and the CoreSimulator device set. */
export function defaultSimulatorLocationAuthorizationReader(): SimulatorLocationAuthorizationReader {
  const plist = new PlistClient();
  return new SimulatorLocationdClientsReader({
    plutilToXml: (path) => plist.readXmlFile(path),
    deviceDataRoot: (udid) => join(defaultDeviceSetRoot(os.homedir()), udid),
  });
}
