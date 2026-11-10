import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AdbComplicationProviderLister,
  COMPLICATION_PROVIDER_ACTION,
  parseComplicationProviders,
} from "../../../src/features/wear/ComplicationProviders";
import { ActionableError, type ExecResult } from "../../../src/models";
import type { AdbCommandRunner } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";

/** `cmd package query-services -a <action>` from the API 37 Wear emulator (#17521), verbatim. */
const CAPTURED = readFileSync(
  join(import.meta.dir, "../../fixtures/wear/surface/complication-providers-query-services.txt"),
  "utf8",
);
const SYSUI = "com.google.android.clockwork.sysui";
const CONTACTS =
  "com.google.android.contacts/com.google.android.wearable.contacts.complications.ContactsComplicationProviderService";

class FakeQueryServicesAdb implements AdbCommandRunner {
  readonly calls: string[] = [];
  constructor(private readonly error?: Error) {}

  async executeCommand(command: string): Promise<ExecResult> {
    this.calls.push(command);
    if (this.error) {
      throw this.error;
    }
    return createExecResult(CAPTURED, "");
  }
}

describe("parseComplicationProviders", () => {
  test("pairs each service name with its package and skips ApplicationInfo rows", () => {
    const providers = parseComplicationProviders(CAPTURED);
    expect(providers).toHaveLength(14);
    expect(providers.filter((p) => p.packageName === SYSUI)).toHaveLength(11);
    expect(providers.find((p) => p.component === CONTACTS)).toEqual({
      component: CONTACTS,
      packageName: "com.google.android.contacts",
      className:
        "com.google.android.wearable.contacts.complications.ContactsComplicationProviderService",
    });
    expect(providers.at(-1)?.component).toBe(
      "com.google.android.wearable.media.sessions/com.google.android.clockwork.media.complication.ComplicationProviderService",
    );
  });

  test("no services is an empty list", () => {
    expect(parseComplicationProviders("No services found\n")).toEqual([]);
  });
});

describe("AdbComplicationProviderLister", () => {
  test("queries the support-library complication action", async () => {
    const adb = new FakeQueryServicesAdb();
    expect(await new AdbComplicationProviderLister(adb).list()).toHaveLength(14);
    expect(adb.calls).toEqual([
      `shell cmd package query-services -a ${COMPLICATION_PROVIDER_ACTION}`,
    ]);
  });

  test("an adb failure is an ActionableError", async () => {
    const lister = new AdbComplicationProviderLister(
      new FakeQueryServicesAdb(new Error("offline")),
    );
    await expect(lister.list()).rejects.toBeInstanceOf(ActionableError);
  });
});
