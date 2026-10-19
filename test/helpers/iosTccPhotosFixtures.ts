import { readFileSync } from "node:fs";
import {
  SimulatorTccSqliteClient,
  tccServiceForPermission,
  type TccPermissionReader,
} from "../../src/utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import { FakeHostCommandExecutor } from "../fakes/FakeHostCommandExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { createExecResult } from "../../src/utils/execResult";

export const photosTccCases = ["none", "addonly", "full", "revoked", "full2"] as const;
export type PhotosTccCase = (typeof photosTccCases)[number];
export const photosTccCases265 = [
  "none",
  "addonly",
  "full",
  "fullclean",
  "fulladd",
  "revoked",
] as const;
export type PhotosTccCase265 = (typeof photosTccCases265)[number];
export type PhotosTccRuntime = "ios27.0" | "ios26.5";
type Probe = {
  addOnly: { name: "authorized" | "denied" | "notDetermined"; rawValue: number };
  readWrite: { name: string; rawValue: number };
  observedAt: string;
};
const loadCapture = (name: PhotosTccCase | PhotosTccCase265, runtime: PhotosTccRuntime) => {
  const directory = runtime === "ios26.5" ? "ios26.5/" : "";
  return {
    text: readFileSync(
      new URL(`../fixtures/ios-tcc-photos/${directory}${name}-tcc.json`, import.meta.url),
      "utf8",
    ),
    probe: JSON.parse(
      readFileSync(
        new URL(`../fixtures/ios-tcc-photos/${directory}${name}-probe.json`, import.meta.url),
        "utf8",
      ),
    ) as Probe,
  };
};
const captures = new Map(photosTccCases.map((name) => [name, loadCapture(name, "ios27.0")]));

/** Exercise the production schema and row parser without touching sqlite or disk. */
export async function loadPhotosTccCase(
  name: PhotosTccCase | PhotosTccCase265,
  runtime: PhotosTccRuntime = "ios27.0",
) {
  const capture =
    runtime === "ios26.5" ? loadCapture(name, runtime) : captures.get(name as PhotosTccCase)!;
  const executor = new FakeHostCommandExecutor();
  executor.setCommandResponse(
    "pragma table_info(access);",
    createExecResult(
      JSON.stringify(["service", "client", "auth_version", "auth_value"].map((name) => ({ name }))),
      "",
    ),
  );
  executor.setDefaultResponse(createExecResult(capture.text, ""));
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
  constructor(
    private readonly name: PhotosTccCase | PhotosTccCase265,
    private readonly runtime: PhotosTccRuntime = "ios27.0",
  ) {}
  async readPermissions(deviceId: string, appId: string, permissions?: string[]) {
    this.calls.push({ deviceId, appId, permissions });
    const { rows } = await loadPhotosTccCase(this.name, this.runtime);
    const services = permissions?.map(tccServiceForPermission);
    return services?.length ? rows.filter((row) => services.includes(row.service)) : rows;
  }
}
