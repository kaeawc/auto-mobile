import { readFileSync } from "node:fs";
import {
  SimulatorTccSqliteClient,
  tccServiceForPermission,
  type TccPermissionReader,
} from "../../src/utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import { FakeHostCommandExecutor } from "../fakes/FakeHostCommandExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

export const photosTccCases = ["none", "addonly", "full", "revoked", "full2"] as const;
export type PhotosTccCase = (typeof photosTccCases)[number];
type Probe = {
  addOnly: { name: "authorized" | "denied" | "notDetermined"; rawValue: number };
  readWrite: { name: string; rawValue: number };
  observedAt: string;
};
const captures = new Map(
  photosTccCases.map((name) => [
    name,
    {
      text: readFileSync(
        new URL(`../fixtures/ios-tcc-photos/${name}-tcc.json`, import.meta.url),
        "utf8",
      ),
      probe: JSON.parse(
        readFileSync(
          new URL(`../fixtures/ios-tcc-photos/${name}-probe.json`, import.meta.url),
          "utf8",
        ),
      ) as Probe,
    },
  ]),
);

/** Exercise the production schema and row parser without touching sqlite or disk. */
export async function loadPhotosTccCase(name: PhotosTccCase) {
  const capture = captures.get(name)!;
  const executor = new FakeHostCommandExecutor();
  executor.setCommandResponse("pragma table_info(access);", {
    stdout: JSON.stringify(
      ["service", "client", "auth_version", "auth_value"].map((name) => ({ name })),
    ),
    stderr: "",
  });
  executor.setDefaultResponse({ stdout: capture.text, stderr: "" });
  const client = new SimulatorTccSqliteClient({
    executor,
    fileSystem: { stat: async () => ({ isFile: () => true }) },
    timer: new FakeTimer(),
    deviceSetRoot: "/fixture/devices",
    environment: {},
    resolveKind: () => "simulator",
  });
  return {
    rows: await client.readPermissions("fixture-device", "dev.jasonpearson.automobile.Playground"),
    probe: capture.probe,
  };
}

export class FixtureTccReader implements TccPermissionReader {
  readonly calls: Array<{ deviceId: string; appId: string; permissions?: string[] }> = [];
  constructor(private readonly name: PhotosTccCase) {}
  async readPermissions(deviceId: string, appId: string, permissions?: string[]) {
    this.calls.push({ deviceId, appId, permissions });
    const { rows } = await loadPhotosTccCase(this.name);
    const services = permissions?.map(tccServiceForPermission);
    return services?.length ? rows.filter((row) => services.includes(row.service)) : rows;
  }
}
