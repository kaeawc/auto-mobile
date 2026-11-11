import { ENV, readEnvTrimmed } from "../../config/env";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  outputLooksLikeShellFailure,
  packageListingContains,
} from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { pathExists } from "../../utils/filesystem/DefaultFileSystem";
import { shellQuote } from "../../utils/shellQuote";
import { parseBroadcastOutput } from "../intent/SendBroadcast";
import { z } from "zod/v4";
import {
  CALLS,
  ACCOUNT_TYPE,
  RAW_CONTACTS,
  contactDataCommands,
  contentRowCount,
  highestRawContactId,
  insertCommand,
} from "./contentCommands";
import {
  CONTENT_KINDS,
  emptyContentCounts,
  seedContentInput,
  type SeedContentInput,
  type SeedContentResult,
  type ContentKind,
} from "./seedContentInput";

const PACKAGE = "dev.jasonpearson.automobile.contentseeder";
const countsSchema = z
  .object({
    inserted: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative().default(0),
  })
  .strict();
export interface SeedContentDependencies {
  adb: Pick<AdbExecutor, "execute">;
  apkPath?: string;
  exists?: (path: string) => Promise<boolean>;
}

interface NamespaceReadBack {
  kind: "contacts" | "callLog";
  uri: string;
  where: string;
  before: number;
}

export function parseSeedBroadcast(output: string): z.output<typeof countsSchema> {
  const reply = parseBroadcastOutput(output);
  if (!reply.delivered || reply.resultCode !== -1 || !reply.resultData) {
    throw new ActionableError(
      `Content seeder broadcast failed: ${reply.delivered ? (reply.resultData ?? output) : reply.error}. Check the SMS role and calendar/SMS permission grants.`,
    );
  }
  try {
    return countsSchema.parse(JSON.parse(reply.resultData));
  } catch (error) {
    throw toActionableError(
      error,
      "Content seeder returned an incompatible result; rebuild with ./gradlew :content-seeder:assembleDebug and reinstall the debug APK",
    );
  }
}

/** One instance per invocation; never retries writes that may already have landed. */
export class SeedContent {
  constructor(private readonly deps: SeedContentDependencies) {}

  async seed(input: SeedContentInput, signal?: AbortSignal): Promise<SeedContentResult> {
    const parsed = seedContentInput.strict().safeParse(input);
    if (!parsed.success) {
      throw new ActionableError(`Invalid seedContent input: ${parsed.error.message}`);
    }
    const request = parsed.data;
    const tag = `automobile.${request.namespace}`;
    const resetKinds = this.resetKinds(request);
    const appNeeded = (["contacts", "calendarEvents", "smsInbox"] as const).some(
      (kind) => request[kind]?.length || resetKinds.includes(kind),
    );
    if (appNeeded) {
      await this.prepareApp(signal);
    }
    const result: SeedContentResult = {
      namespace: request.namespace,
      inserted: emptyContentCounts(),
      removed: emptyContentCounts(),
    };
    // Finish every reset before starting any insert, including across providers.
    for (const kind of resetKinds) {
      result.removed[kind] = await this.reset(kind, request.namespace, tag, signal);
    }
    if (request.reset && CONTENT_KINDS.every((kind) => request[kind] === undefined)) {
      // Drop the shared account only after all four providers have been cleared.
      await this.broadcast("reset", request.namespace, { dropAccount: "true" }, signal);
    }
    const readBack = await this.prepareReadBack(request, tag, signal);
    result.inserted.contacts = await this.insertContacts(request.contacts ?? [], tag, signal);
    result.inserted.callLog = await this.insertCalls(request.callLog ?? [], tag, signal);
    for (const kind of ["calendarEvents", "smsInbox"] as const) {
      result.inserted[kind] = await this.insertAppKind(kind, request, signal);
    }
    // Read after every provider write: account changes must not purge earlier contacts.
    for (const check of readBack) {
      await this.verifyRows(check, result.inserted[check.kind], signal);
    }
    return result;
  }

  private async prepareReadBack(
    request: SeedContentInput,
    tag: string,
    signal?: AbortSignal,
  ): Promise<NamespaceReadBack[]> {
    if (request.contacts?.length) {
      await this.broadcast("account", request.namespace, {}, signal);
    }
    const providers = [
      {
        kind: "contacts",
        uri: RAW_CONTACTS,
        where: `account_name='${tag}' AND account_type='${ACCOUNT_TYPE}'`,
      },
      { kind: "callLog", uri: CALLS, where: `subscription_component_name='${tag}'` },
    ] as const;
    const checks: NamespaceReadBack[] = [];
    for (const provider of providers) {
      if (request[provider.kind]?.length) {
        checks.push({
          ...provider,
          before: await this.countRows(provider.uri, provider.where, signal),
        });
      }
    }
    return checks;
  }

  private async countRows(uri: string, where: string, signal?: AbortSignal): Promise<number> {
    return contentRowCount(
      await this.shell(
        [
          `content query --uri ${shellQuote(uri)} --projection ${shellQuote("_id")} --where ${shellQuote(where)}`,
        ],
        signal,
      ),
    );
  }

  private async verifyRows(
    check: NamespaceReadBack,
    inserted: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const after = await this.countRows(check.uri, check.where, signal);
    const expected = check.before + inserted;
    if (after < expected) {
      throw new ActionableError(
        `seedContent read-back failed for ${check.uri}: expected at least ${expected} namespace rows, found ${after}. Check the registered seeder account and provider permissions; partial writes may remain. Retry with reset.`,
      );
    }
  }

  private resetKinds(request: SeedContentInput): ContentKind[] {
    if (!request.reset) {
      return [];
    }
    const supplied = CONTENT_KINDS.filter((kind) => request[kind] !== undefined);
    return supplied.length ? supplied : [...CONTENT_KINDS];
  }

  private async insertCalls(
    calls: NonNullable<SeedContentInput["callLog"]>,
    tag: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const callCommands = calls.map((call) =>
      insertCommand(CALLS, [
        `number:s:${call.number}`,
        `type:i:${{ incoming: 1, outgoing: 2, missed: 3 }[call.type]}`,
        `date:l:${Date.parse(call.date)}`,
        `duration:i:${call.durationSec ?? 0}`,
        "new:i:1",
        `subscription_component_name:s:${tag}`,
      ]),
    );
    await this.shell(callCommands, signal);
    return callCommands.length;
  }

  private async insertAppKind(
    kind: "calendarEvents" | "smsInbox",
    request: SeedContentInput,
    signal?: AbortSignal,
  ): Promise<number> {
    const items =
      kind === "calendarEvents"
        ? request.calendarEvents?.map(({ start, end, ...event }) => ({
            ...event,
            startMillis: Date.parse(start),
            endMillis: Date.parse(end),
          }))
        : request.smsInbox?.map(({ date, ...message }) => ({
            ...message,
            dateMillis: Date.parse(date),
          }));
    if (!items?.length) {
      return 0;
    }
    const result = await this.broadcast(
      kind === "calendarEvents" ? "calendar" : "sms",
      request.namespace,
      { items: JSON.stringify(items) },
      signal,
    );
    if (result.inserted !== items.length) {
      throw new ActionableError(
        `Content seeder confirmed ${result.inserted} ${kind} rows, expected ${items.length}. Rebuild and reinstall the seeder APK, check provider permissions and retry with reset.`,
      );
    }
    return result.inserted;
  }

  private async insertContacts(
    contacts: NonNullable<SeedContentInput["contacts"]>,
    tag: string,
    signal?: AbortSignal,
  ): Promise<number> {
    for (const contact of contacts) {
      await this.shell(
        [insertCommand(RAW_CONTACTS, [`account_name:s:${tag}`, `account_type:s:${ACCOUNT_TYPE}`])],
        signal,
      );
      const output = await this.shell(
        [
          `content query --uri ${shellQuote(RAW_CONTACTS)} --projection ${shellQuote("_id:account_name:account_type")}`,
        ],
        signal,
      );
      const id = highestRawContactId(output, tag);
      await this.shell(contactDataCommands(contact, id), signal);
    }
    return contacts.length;
  }

  private async run(args: string[], signal?: AbortSignal): Promise<string> {
    try {
      const reply = await this.deps.adb.execute(args, {
        noRetry: true,
        signal,
        timeoutMs: 120_000,
      });
      const output = `${reply.stdout}\n${reply.stderr}`.trim();
      if (
        reply.error ||
        outputLooksLikeShellFailure(reply.stdout, reply.stderr) ||
        /(?:^|\n)usage: adb shell content|Error while accessing provider|Failure \[/i.test(output)
      ) {
        throw new ActionableError(
          `seedContent command failed: ${reply.error ?? output}. Check provider availability, permissions and the seeder APK; partial writes may remain. Retry with reset to replace this namespace.`,
        );
      }
      return output;
    } catch (error) {
      throw toActionableError(
        error,
        "seedContent adb command failed; partial writes may remain. Check device access and retry with reset",
      );
    }
  }

  private async shell(commands: string[], signal?: AbortSignal): Promise<string> {
    if (!commands.length) {
      return "";
    }
    // argv preserves the outer quote layer; sh -c parses the individually quoted values.
    return this.run(["shell", `sh -c ${shellQuote(`set -e; ${commands.join("; ")}`)}`], signal);
  }

  private async resolveApkPath(): Promise<string> {
    const exists = this.deps.exists ?? pathExists;
    let apk = this.deps.apkPath ?? readEnvTrimmed(ENV.CONTENT_SEEDER_APK_PATH);
    if (!apk) {
      let root = dirname(fileURLToPath(import.meta.url));
      while (!(await exists(join(root, "package.json"))) && dirname(root) !== root) {
        root = dirname(root);
      }
      apk = join(root, "android/content-seeder/build/outputs/apk/debug/content-seeder-debug.apk");
    }
    if (!(await exists(apk))) {
      throw new ActionableError(
        `Contacts/Calendar/SMS seeding requires the content seeder debug APK. Run ./gradlew :content-seeder:assembleDebug from the Android project, or set AUTOMOBILE_CONTENT_SEEDER_APK_PATH. APK not found: ${apk}`,
      );
    }
    return apk;
  }

  private async prepareApp(signal?: AbortSignal): Promise<void> {
    const listing = await this.shell([`pm list packages --user 0 ${shellQuote(PACKAGE)}`], signal);
    if (!packageListingContains(listing, PACKAGE)) {
      const apk = await this.resolveApkPath();
      const output = await this.run(["install", "-t", apk], signal);
      if (!/\bSuccess\b/.test(output)) {
        throw new ActionableError(`Could not install the content seeder APK: ${output}`);
      }
    }
    await this.shell(
      [
        `cmd role add-role-holder --user 0 android.app.role.SMS ${shellQuote(PACKAGE)}`,
        ...["READ_CALENDAR", "WRITE_CALENDAR", "READ_SMS"].map(
          (permission) =>
            `pm grant --user 0 ${shellQuote(PACKAGE)} ${shellQuote(`android.permission.${permission}`)}`,
        ),
      ],
      signal,
    );
  }

  private async broadcast(
    kind: string,
    namespace: string,
    extras: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<z.output<typeof countsSchema>> {
    const args = Object.entries({ kind, namespace, ...extras })
      .map(([key, value]) => `--es ${shellQuote(key)} ${shellQuote(value)}`)
      .join(" ");
    return parseSeedBroadcast(
      await this.shell(
        [
          `am broadcast -W --user 0 -a ${shellQuote(`${PACKAGE}.SEED`)} -n ${shellQuote(`${PACKAGE}/.SeedReceiver`)} ${args}`,
        ],
        signal,
      ),
    );
  }

  private async reset(
    kind: ContentKind,
    namespace: string,
    tag: string,
    signal?: AbortSignal,
  ): Promise<number> {
    if (kind === "calendarEvents" || kind === "smsInbox") {
      return (
        await this.broadcast(
          "reset",
          namespace,
          { kinds: kind === "calendarEvents" ? "calendar" : "sms" },
          signal,
        )
      ).removed;
    }
    const uri = kind === "contacts" ? `${RAW_CONTACTS}?caller_is_syncadapter=true` : CALLS;
    // Include the old unregistered type for bounded cleanup of legacy contacts.
    const where = shellQuote(
      kind === "contacts"
        ? `account_name='${tag}' AND (account_type='${ACCOUNT_TYPE}' OR account_type='${tag}')`
        : `subscription_component_name='${tag}'`,
    );
    const before = contentRowCount(
      await this.shell(
        [
          `content query --uri ${shellQuote(uri)} --projection ${shellQuote("_id")} --where ${where}`,
        ],
        signal,
      ),
    );
    await this.shell([`content delete --uri ${shellQuote(uri)} --where ${where}`], signal);
    const after = contentRowCount(
      await this.shell(
        [
          `content query --uri ${shellQuote(uri)} --projection ${shellQuote("_id")} --where ${where}`,
        ],
        signal,
      ),
    );
    if (after !== 0) {
      throw new ActionableError(
        "Namespace rows remain after deletion; check the provider permissions before retrying reset.",
      );
    }
    return before;
  }
}
