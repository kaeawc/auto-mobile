import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SeedContent,
  type SeedContentDependencies,
  parseSeedBroadcast,
  withoutProviderRows,
} from "../../../src/features/contentSeed/SeedContent";
import {
  ACCOUNT_TYPE,
  highestRawContactId,
  contentRowCount,
} from "../../../src/features/contentSeed/contentCommands";
import { seedContentInput } from "../../../src/features/contentSeed/seedContentInput";
import { parseBroadcastOutput } from "../../../src/features/intent/SendBroadcast";
import { shellQuote } from "../../../src/utils/shellQuote";
import type {
  AdbExecutor,
  AdbExecuteOptions,
} from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../../src/models";

const fixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/android/content-seed/${name}.txt`, import.meta.url), "utf8");
const captured = Object.fromEntries(
  [
    "query-raw-contacts",
    "broadcast-sms-result",
    "insert-colon-binding-error",
    "delete-raw-contacts",
    "delete-call-log",
  ].map((name) => [name, fixture(name)]),
);
const PACKAGE = "dev.jasonpearson.automobile.contentseeder";
const date = "2026-11-11T10:00:00-06:00";
const success = (inserted = 1, removed = 0) =>
  `Broadcast completed: result=-1, data="${JSON.stringify({ inserted, removed })}"`;
class FakeAdb implements Pick<AdbExecutor, "execute"> {
  calls: string[][] = [];
  options: (AdbExecuteOptions | undefined)[] = [];
  installed = true;
  rows = { contacts: 2, calls: 2 };
  accountName = "automobile.ns1";
  reply?: (args: string[]) => string | undefined;
  private respond(args: string[]): string {
    const command = args.join(" ");
    if (args[0] === "install") {
      return "Success";
    }
    if (command.includes("pm list packages")) {
      return this.installed ? `package:${PACKAGE}` : "";
    }
    if (command.includes("am broadcast")) {
      return command.includes("reset")
        ? success(0, command.includes("dropAccount") ? 0 : 3)
        : success();
    }
    if (command.includes("content query") && command.includes("contacts/data")) {
      return "No result found.";
    }
    const provider = command.includes("raw_contacts") ? "contacts" : "calls";
    if (command.includes("content delete")) {
      this.rows[provider] = 0;
    }
    if (command.includes("content insert") && !command.includes("contacts/data")) {
      this.rows[provider] += command.match(/content insert/g)?.length ?? 0;
    }
    if (!command.includes("content query")) {
      return "";
    }
    if (!this.rows[provider]) {
      return "No result found.";
    }
    // Fake provider state, not a device capture. Real captures remain unchanged.
    return Array.from(
      { length: this.rows[provider] },
      (_, index) =>
        `Row: ${index} _id=${index + 1}${
          command.includes("_id:account_name:account_type")
            ? `, account_name=${this.accountName}, account_type=${ACCOUNT_TYPE}`
            : ""
        }`,
    ).join("\n");
  }
  async execute(args: string[], options?: AdbExecuteOptions): Promise<ExecResult> {
    this.calls.push(args);
    this.options.push(options);
    const stdout = this.reply?.(args) ?? this.respond(args);
    return {
      stdout,
      stderr: "",
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (value) => stdout.includes(value),
    };
  }
}
const client = (adb: FakeAdb) => new SeedContent({ adb, exists: async () => false });

type PhotoFiles = NonNullable<SeedContentDependencies["photoFiles"]>;
class FakePhotoFiles implements PhotoFiles {
  bytes = Buffer.from("89504e470d0a1a0a", "hex");
  size = this.bytes.length;
  missing = false;
  regular = true;
  reads: string[] = [];
  async stat(_path: string) {
    if (this.missing) {
      throw new Error("ENOENT");
    }
    return { size: this.size, mtimeMs: 0, isFile: () => this.regular };
  }
  async readFileHead(path: string, length: number) {
    this.reads.push(path);
    return this.bytes.subarray(0, length);
  }
}

describe("contact photos", () => {
  const input = { namespace: "ns1", contacts: [{ name: "Ada", photoPath: "/host/Ada.png" }] };
  test("rejects bad extensions, signatures, missing files and oversized photos before resets", async () => {
    for (const problem of ["extension", "magic", "missing", "oversize", "grew", "directory"]) {
      const adb = new FakeAdb();
      const photoFiles = new FakePhotoFiles();
      if (problem === "magic") {
        photoFiles.bytes = Buffer.from("not an image");
      }
      if (problem === "missing") {
        photoFiles.missing = true;
      }
      if (problem === "oversize") {
        photoFiles.size = 512 * 1024 + 1;
      }
      if (problem === "grew") {
        photoFiles.bytes = Buffer.alloc(512 * 1024 + 1);
      }
      if (problem === "directory") {
        photoFiles.regular = false;
      }
      await expect(
        new SeedContent({ adb, photoFiles }).seed({
          ...input,
          reset: true,
          contacts: [
            { name: "Ada", photoPath: problem === "extension" ? "/host/a.gif" : "/host/Ada.png" },
          ],
        }),
      ).rejects.toThrow(/photoPath/);
      expect(adb.calls).toEqual([]);
    }
  });

  test("pushes then copies through run-as before photo broadcast, verifies and cleans up", async () => {
    const adb = new FakeAdb();
    adb.reply = (args) => (args.join(" ").includes("photo_id") ? "Row: 0 _id=90" : undefined);
    const photoFiles = new FakePhotoFiles();
    const result = await new SeedContent({ adb, photoFiles }).seed(input);
    expect(result.inserted.contacts).toBe(1);
    const push = adb.calls.findIndex((args) => args[0] === "push");
    expect(adb.calls[push]).toEqual([
      "push",
      "/host/Ada.png",
      "/data/local/tmp/automobile.ns1.3.photo",
    ]);
    const commands = adb.calls.map((args) => args.join(" "));
    const copy = commands.findIndex(
      (command) => command.includes("run-as") && command.includes("cat >"),
    );
    const broadcast = commands.findIndex(
      (command) => command.includes("am broadcast") && command.includes("rawContactId"),
    );
    expect(push).toBeGreaterThan(0);
    expect(copy).toBeGreaterThan(push);
    expect(broadcast).toBeGreaterThan(copy);
    expect(commands[broadcast]).toContain(`${PACKAGE}.SEED`);
    expect(commands[broadcast]).toContain("photo");
    expect(commands[broadcast]).toContain("photoFile");
    expect(commands[broadcast]).toContain("automobile.ns1.3.photo");
    expect(
      commands.some(
        (command) => command.includes("rm -f") && command.includes("cache/automobile.ns1.3.photo"),
      ),
    ).toBe(true);
    expect(commands.at(-1)).toContain("photo_id");
    expect(commands.at(-1)).toContain("automobile.ns1");
    expect(photoFiles.reads).toEqual(["/host/Ada.png"]);
  });

  test("accepts JPEG and the exact size cap, resolving relative paths against launch cwd", async () => {
    const adb = new FakeAdb();
    adb.reply = (args) => (args.join(" ").includes("photo_id") ? "Row: 0 _id=90" : undefined);
    const photoFiles = new FakePhotoFiles();
    photoFiles.bytes = Buffer.alloc(512 * 1024);
    photoFiles.bytes.set([0xff, 0xd8, 0xff]);
    photoFiles.size = photoFiles.bytes.length;
    await new SeedContent({
      adb,
      photoFiles,
      env: { AUTOMOBILE_DAEMON_LAUNCH_CWD: "/launch" },
    }).seed({
      namespace: "ns1",
      contacts: [{ name: "Ada", photoPath: "Ada.JPEG" }],
    });
    expect(adb.calls.find((args) => args[0] === "push")?.[1]).toBe(
      path.resolve("/launch/Ada.JPEG"),
    );
  });

  test("missing photo read-back fails with recovery guidance", async () => {
    const adb = new FakeAdb();
    adb.reply = (args) => (args.join(" ").includes("photo_id") ? "No result found." : undefined);
    await expect(
      new SeedContent({ adb, photoFiles: new FakePhotoFiles() }).seed(input),
    ).rejects.toThrow("photo read-back failed");
  });

  test("rejects an unconfirmed photo broadcast and removes the staged file", async () => {
    const adb = new FakeAdb();
    adb.reply = (args) => (args.join(" ").includes("rawContactId") ? success(0) : undefined);
    await expect(
      new SeedContent({ adb, photoFiles: new FakePhotoFiles() }).seed(input),
    ).rejects.toThrow("did not confirm the contact photo");
    expect(adb.calls.at(-1)?.join(" ")).toContain("rm -f");
  });

  test("cleans staged files even if push or broadcast fails, without reusing an aborted signal", async () => {
    for (const stage of ["push", "copy", "broadcast", "cancel"]) {
      const adb = new FakeAdb();
      const controller = new AbortController();
      adb.reply = (args) => {
        const command = args.join(" ");
        const fails =
          stage === "push"
            ? args[0] === "push"
            : stage === "copy"
              ? command.includes("cat >")
              : command.includes("rawContactId");
        if (!fails) {
          return undefined;
        }
        if (stage === "cancel") {
          controller.abort();
        }
        return "Error: rejected photo";
      };
      await expect(
        new SeedContent({ adb, photoFiles: new FakePhotoFiles() }).seed(input, controller.signal),
      ).rejects.toThrow("rejected photo");
      expect(adb.calls.at(-1)?.join(" ")).toContain("rm -f");
      expect(adb.options.at(-1)?.signal).toBeUndefined();
      if (stage === "cancel") {
        expect(controller.signal.aborted).toBe(true);
      }
    }
  });

  test("contact reset checks photo cascade and removes only namespace staged files", async () => {
    const adb = new FakeAdb();
    adb.reply = (args) =>
      args.join(" ").includes("contacts/data") ? "No result found." : undefined;
    await client(adb).seed({ namespace: "ns1", reset: true, contacts: [] });
    const commands = adb.calls.map((args) => args.join(" "));
    expect(
      commands.some(
        (command) => command.includes("contacts/data") && command.includes("automobile.ns1"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) => command.includes("rm -f") && command.includes("automobile.ns1.*.photo"),
      ),
    ).toBe(true);
    adb.reply = (args) => (args.join(" ").includes("contacts/data") ? "Row: 0 _id=90" : undefined);
    await expect(client(adb).seed({ namespace: "ns1", reset: true, contacts: [] })).rejects.toThrow(
      "photo rows remain",
    );
  });
});

describe("seedContent", () => {
  test("namespace validation rejects shell syntax before any adb access", async () => {
    const adb = new FakeAdb();
    for (const namespace of ["", "a:b", "a b", "' ; rm", "a".repeat(33)]) {
      await expect(client(adb).seed({ namespace })).rejects.toThrow("Invalid seedContent input");
    }
    expect(adb.calls).toEqual([]);
    expect(seedContentInput.safeParse({ namespace: "A_9-z" }).success).toBe(true);
  });

  test("captured legacy contacts are rejected by the registered-account selector", () => {
    expect(() => highestRawContactId(captured["query-raw-contacts"]!, "automobile.ns1")).toThrow(
      "Cannot read back",
    );
  });

  test("fake query chooses highest ID for both registered account fields", () => {
    const row = (id: number, name: string, type: string) =>
      `Row: 0 _id=${id}, account_name=${name}, account_type=${type}\n`;
    const query =
      row(2, "automobile.ns1", ACCOUNT_TYPE) +
      row(9, "automobile.ns1", ACCOUNT_TYPE) +
      row(99, "automobile.other", ACCOUNT_TYPE) +
      row(100, "automobile.ns1", "automobile.ns1");
    expect(highestRawContactId(query, "automobile.ns1")).toBe(9);
    expect(() => highestRawContactId(query, "automobile.missing")).toThrow("Cannot read back");
  });

  test("contacts batch quoted name/phone/email bindings after raw-id readback", async () => {
    const adb = new FakeAdb();
    const name = "Ada O'Neil $(nope)";
    const result = await client(adb).seed({
      namespace: "ns1",
      contacts: [{ name, phones: ["+1555"], emails: ["a@example.org"] }],
    });
    expect(result.inserted.contacts).toBe(1);
    const commands = adb.calls.map((args) => args.join(" "));
    const accountIndex = commands.findIndex(
      (command) => command.includes("am broadcast") && command.includes("account"),
    );
    const rawIndex = commands.findIndex(
      (command) => command.includes("content insert") && command.includes("raw_contacts"),
    );
    expect(accountIndex).toBeGreaterThan(-1);
    expect(accountIndex).toBeLessThan(rawIndex);
    expect(commands[rawIndex]).toContain(`account_type:s:${ACCOUNT_TYPE}`);
    expect(commands[rawIndex]).toContain("account_name:s:automobile.ns1");
    const data = commands.find(
      (command) => command.includes("content insert") && command.includes("contacts/data"),
    )!;
    expect(data).toContain(shellQuote(shellQuote(`data1:s:${name}`)).slice(1, -1));
    expect(data.match(/content insert/g)).toHaveLength(3);
    expect(data).toContain("data2:i:2");
    expect(data).toContain("data2:i:1");
    expect(adb.options.every((options) => options?.noRetry)).toBe(true);
  });

  test("reset scopes deletes to tag and finishes all deletes before batched inserts", async () => {
    const adb = new FakeAdb();
    const result = await client(adb).seed({
      namespace: "ns1",
      reset: true,
      contacts: [{ name: "Ada" }],
      callLog: [
        { number: "555", type: "missed", date },
        { number: "556", type: "incoming", date, durationSec: 7 },
      ],
    });
    expect(result.removed).toEqual({ contacts: 2, callLog: 2, calendarEvents: 0, smsInbox: 0 });
    const commands = adb.calls.map((args) => args.join(" "));
    const deletes = commands.filter((command) => command.includes("content delete"));
    expect(deletes).toHaveLength(2);
    expect(deletes[0]).toContain("caller_is_syncadapter=true");
    expect(deletes[0]).toContain("account_name=");
    expect(deletes[0]).toContain(`account_type=`);
    expect(deletes[0]).toContain(ACCOUNT_TYPE);
    expect(deletes[0]).toContain("OR account_type=");
    expect(deletes[1]).toContain("subscription_component_name=");
    expect(deletes.every((command) => command.includes("automobile.ns1"))).toBe(true);
    expect(commands.findLastIndex((command) => command.includes("content delete"))).toBeLessThan(
      commands.findIndex((command) => command.includes("content insert")),
    );
    const last = commands.find(
      (command) => command.includes("content insert") && command.includes("call_log"),
    )!;
    expect(last.match(/content insert/g)).toHaveLength(2);
    expect(last).toContain(`date:l:${Date.parse(date)}`);
    expect(last).toContain("duration:i:7");
    expect(last).toContain("type:i:3");
  });

  test("reset without arrays removes all four kinds without inserting", async () => {
    const adb = new FakeAdb();
    const result = await client(adb).seed({ namespace: "ns1", reset: true });
    expect(result.removed).toEqual({ contacts: 2, callLog: 2, calendarEvents: 3, smsInbox: 3 });
    expect(Object.values(result.inserted)).toEqual([0, 0, 0, 0]);
    expect(adb.calls.some((args) => args[1]?.includes("content insert"))).toBe(false);
    const commands = adb.calls.map((args) => args.join(" "));
    expect(commands.at(-1)).toContain("dropAccount");
    expect(commands.filter((command) => command.includes("dropAccount"))).toHaveLength(1);
    expect(
      commands.slice(0, -1).some((command) => command.includes("reset") && command.includes("sms")),
    ).toBe(true);
  });

  test("installs missing app, grants roles/permissions in manual-script order, broadcasts one JSON batch per kind", async () => {
    const adb = new FakeAdb();
    adb.installed = false;
    const seed = new SeedContent({
      adb,
      apkPath: "/tmp/seeder's debug.apk",
      exists: async () => true,
    });
    await seed.seed({
      namespace: "ns1",
      calendarEvents: [
        {
          title: "Owner's meeting",
          start: date,
          end: "2026-11-11T11:00:00-06:00",
          location: "Meeting room",
          calendar: "Work",
        },
      ],
      smsInbox: [{ address: "555", body: "Hi 'there'", date, read: true }],
    });
    expect(adb.calls[1]).toEqual(["install", "-t", "/tmp/seeder's debug.apk"]);
    const grants = adb.calls[2]![1]!;
    expect(grants.indexOf("add-role-holder")).toBeLessThan(grants.indexOf("READ_CALENDAR"));
    expect(grants.indexOf("READ_CALENDAR")).toBeLessThan(grants.indexOf("WRITE_CALENDAR"));
    expect(grants.indexOf("WRITE_CALENDAR")).toBeLessThan(grants.indexOf("READ_SMS"));
    expect(adb.calls.filter((args) => args[1]?.includes("am broadcast"))).toHaveLength(2);
    expect(adb.calls.at(-1)![1]).toContain('"read":true');
  });

  test("each kind-specific reset preserves the shared account, including explicitly supplied all-kind arrays", async () => {
    for (const arrays of [
      { contacts: [] },
      { calendarEvents: [] },
      { smsInbox: [] },
      { callLog: [] },
      { contacts: [], calendarEvents: [], smsInbox: [], callLog: [] },
    ]) {
      const adb = new FakeAdb();
      await client(adb).seed({ namespace: "ns1", reset: true, ...arrays });
      expect(adb.calls.every((args) => !args.join(" ").includes("dropAccount"))).toBe(true);
      expect(adb.calls.every((args) => !args.join(" ").includes("remove-account"))).toBe(true);
    }
  });

  test("account refusal stops contact writes", async () => {
    const adb = new FakeAdb();
    adb.reply = (args) =>
      args.join(" ").includes("am broadcast")
        ? 'Broadcast completed: result=0, data="Could not create the seeder account"'
        : undefined;
    await expect(
      client(adb).seed({ namespace: "ns1", contacts: [{ name: "Ada" }] }),
    ).rejects.toThrow("Could not create");
    expect(adb.calls.some((args) => args.join(" ").includes("content insert"))).toBe(false);
  });

  test("final contact read-back rejects a purge caused by a later calendar operation", async () => {
    const adb = new FakeAdb();
    adb.reply = (args) => {
      const command = args.join(" ");
      if (command.includes("am broadcast") && command.includes('"startMillis"')) {
        adb.rows.contacts = 0;
        return success();
      }
      return undefined;
    };
    await expect(
      client(adb).seed({
        namespace: "ns1",
        contacts: [{ name: "Ada" }],
        calendarEvents: [{ title: "A", start: date, end: "2026-11-11T11:00:00-06:00" }],
      }),
    ).rejects.toThrow("expected at least 3 namespace rows, found 0");
    expect(adb.calls.at(-1)?.join(" ")).toContain(ACCOUNT_TYPE);
  });

  test("read-back checks growth over existing rows for both shell providers", async () => {
    for (const provider of ["contacts", "calls"] as const) {
      const adb = new FakeAdb();
      adb.reply = (args) => {
        const command = args.join(" ");
        // Simulate an accepted insert that did not persist, with old rows still present.
        return command.includes("content insert") &&
          command.includes(provider === "contacts" ? "raw_contacts" : "call_log")
          ? ""
          : undefined;
      };
      await expect(
        client(adb).seed({
          namespace: "ns1",
          ...(provider === "contacts"
            ? { contacts: [{ name: "Ada" }] }
            : { callLog: [{ number: "555", type: "incoming" as const, date }] }),
        }),
      ).rejects.toThrow("expected at least 3 namespace rows, found 2");
    }
  });

  test("incomplete calendar and SMS confirmations fail instead of reporting fewer inserts", async () => {
    for (const items of [
      { calendarEvents: [{ title: "A", start: date, end: "2026-11-11T11:00:00-06:00" }] },
      { smsInbox: [{ address: "555", body: "hi", date }] },
    ]) {
      const adb = new FakeAdb();
      adb.reply = (args) => (args.join(" ").includes("am broadcast") ? success(0) : undefined);
      await expect(client(adb).seed({ namespace: "ns1", ...items })).rejects.toThrow("expected 1");
    }
  });

  test("missing APK blocks contacts, calendar and SMS before writes; call log works without it", async () => {
    const adb = new FakeAdb();
    adb.installed = false;
    for (const input of [
      { contacts: [{ name: "Ada" }] },
      { reset: true, contacts: [] },
      { smsInbox: [{ address: "555", body: "hi", date }] },
      { calendarEvents: [{ title: "A", start: date, end: "2026-11-11T11:00:00-06:00" }] },
      {
        contacts: [{ name: "Ada" }],
        callLog: [{ number: "555", type: "incoming" as const, date }],
      },
    ]) {
      adb.calls = [];
      await expect(client(adb).seed({ namespace: "ns1", ...input })).rejects.toThrow(
        "./gradlew :content-seeder:assembleDebug",
      );
      expect(adb.calls).toHaveLength(1);
    }
    adb.calls = [];
    await client(adb).seed({
      namespace: "ns1",
      callLog: [{ number: "555", type: "outgoing", date }],
    });
    expect(adb.calls.every((args) => !args.join(" ").includes("pm list packages"))).toBe(true);
  });

  test("finds the debug APK under the package root without an override", async () => {
    const adb = new FakeAdb();
    adb.installed = false;
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const apk = path.join(
      root,
      "android",
      "content-seeder",
      "build",
      "outputs",
      "apk",
      "debug",
      "content-seeder-debug.apk",
    );
    const seed = new SeedContent({
      adb,
      exists: async (candidate) =>
        candidate === path.join(root, "package.json") || candidate === apk,
    });
    await seed.seed({ namespace: "ns1", smsInbox: [{ address: "555", body: "hi", date }] });
    expect(adb.calls[1]).toEqual(["install", "-t", apk]);
  });

  test("all app resets finish before any insert; JSON payloads contain epoch milliseconds", async () => {
    const adb = new FakeAdb();
    await client(adb).seed({
      namespace: "ns1",
      reset: true,
      calendarEvents: [{ title: "A", start: date, end: "2026-11-11T11:00:00-06:00" }],
      smsInbox: [{ address: "555", body: "hi", date }],
    });
    const broadcasts = adb.calls.filter((args) => args[1]?.includes("am broadcast"));
    expect(broadcasts).toHaveLength(4);
    expect(broadcasts.slice(0, 2).every((args) => args[1]?.includes("reset"))).toBe(true);
    expect(broadcasts[2]![1]).toContain(`"startMillis":${Date.parse(date)}`);
    expect(broadcasts[3]![1]).toContain(`"dateMillis":${Date.parse(date)}`);
    expect(broadcasts.every((args) => args[1]?.includes("ns1"))).toBe(true);
  });

  test("refuses unsuccessful grants, installs and unconfirmed reset before subsequent writes", async () => {
    const adb = new FakeAdb();
    adb.reply = (args) =>
      args.join(" ").includes("add-role-holder") ? "Error: role unavailable" : `package:${PACKAGE}`;
    await expect(
      client(adb).seed({ namespace: "ns1", smsInbox: [{ address: "555", body: "hi", date }] }),
    ).rejects.toThrow("role unavailable");
    expect(adb.calls.some((args) => args[1]?.includes("am broadcast"))).toBe(false);
    const resetAdb = new FakeAdb();
    resetAdb.reply = (args) =>
      args.join(" ").includes("content query") ? "Row: 0 _id=1" : undefined;
    await expect(
      client(resetAdb).seed({ namespace: "ns1", reset: true, contacts: [] }),
    ).rejects.toThrow("rows remain");
  });

  test("ISO validation checks timezone, range and UTC all-day exclusive end", () => {
    for (const event of [
      { title: "a", start: "tomorrow", end: date },
      { title: "a", start: date, end: date },
      { title: "a", start: date, end: "2026-11-12T00:00:00Z", allDay: true },
    ]) {
      expect(
        seedContentInput.safeParse({ namespace: "ns1", calendarEvents: [event] }).success,
      ).toBe(false);
    }
    expect(
      seedContentInput.safeParse({
        namespace: "ns1",
        calendarEvents: [
          { title: "a", start: "2026-11-11T00:00:00Z", end: "2026-11-12T00:00:00Z", allDay: true },
        ],
      }).success,
    ).toBe(true);
  });

  test("broadcast parser uses captured envelope, rejects old APK URI and handles JSON counts/refusals", () => {
    expect(parseBroadcastOutput(captured["broadcast-sms-result"]!)).toMatchObject({
      delivered: true,
      resultCode: -1,
      resultData: "content://sms/2",
    });
    expect(() => parseSeedBroadcast(captured["broadcast-sms-result"]!)).toThrow("rebuild");
    expect(parseSeedBroadcast(success(2, 4))).toEqual({ inserted: 2, removed: 4 });
    expect(
      parseSeedBroadcast(
        `Broadcast completed: result=-1, data="${JSON.stringify({ inserted: 0 })}"`,
      ),
    ).toEqual({ inserted: 0, removed: 0 });
    for (const output of [
      'Broadcast completed: result=0, data="Grant SMS role"',
      "Broadcast completed: result=0",
      "",
      success(-1),
    ]) {
      expect(() => parseSeedBroadcast(output)).toThrow();
    }
  });

  test("provider rows naming exception/error are data, not shell failures", async () => {
    const adb = new FakeAdb();
    adb.accountName = "automobile.exception_error";
    const result = await client(adb).seed({
      namespace: "exception_error",
      contacts: [{ name: "Ada" }],
    });
    expect(result.inserted.contacts).toBe(1);
    expect(withoutProviderRows("Row: 0 _id=1, account_name=a.exception\nError: real")).toBe(
      "Error: real",
    );
  });

  test("relative APK override resolves against the daemon launch directory", async () => {
    const adb = new FakeAdb();
    adb.installed = false;
    const launch = path.resolve("/launch-dir");
    const apk = path.join(launch, "seeder.apk");
    const seed = new SeedContent({
      adb,
      env: {
        AUTOMOBILE_CONTENT_SEEDER_APK_PATH: "seeder.apk",
        AUTOMOBILE_DAEMON_LAUNCH_CWD: launch,
      },
      exists: async (candidate) => candidate === apk,
    });
    await seed.seed({ namespace: "ns1", smsInbox: [{ address: "555", body: "hi", date }] });
    expect(adb.calls[1]).toEqual(["install", "-t", apk]);
  });

  test("content usage failures are surfaced, not reported as inserts", async () => {
    const adb = new FakeAdb();
    adb.reply = () => captured["insert-colon-binding-error"]!;
    await expect(
      client(adb).seed({ namespace: "ns1", callLog: [{ number: "555", date, type: "incoming" }] }),
    ).rejects.toThrow("command failed");
    expect(
      seedContentInput.safeParse({ namespace: "ns1", contacts: [{ name: "Name: suffix" }] })
        .success,
    ).toBe(false);
  });

  test("reset counts query rows because captured successful deletions are silent", () => {
    for (const name of ["delete-raw-contacts", "delete-call-log"]) {
      expect(captured[name]).toBe("");
    }
    expect(contentRowCount(fixture("query-call-log-empty"))).toBe(0);
    expect(contentRowCount(captured["query-raw-contacts"]!)).toBe(1);
    expect(contentRowCount(fixture("query-call-log"))).toBe(1);
    expect(contentRowCount("Row: 0 _id=1\r\nRow: 1 _id=2\r\n")).toBe(2);
    expect(() => contentRowCount("")).toThrow();
  });
});
