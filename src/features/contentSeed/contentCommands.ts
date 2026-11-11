import { ActionableError } from "../../models/ActionableError";
import { shellQuote } from "../../utils/shellQuote";
import type { SeedContentInput } from "./seedContentInput";

export const RAW_CONTACTS = "content://com.android.contacts/raw_contacts";
export const CALLS = "content://call_log/calls";
export const ACCOUNT_TYPE = "dev.jasonpearson.automobile.contentseeder";
export const insertCommand = (uri: string, bindings: string[]): string =>
  `content insert --uri ${shellQuote(uri)} ${bindings.map((value) => `--bind ${shellQuote(value)}`).join(" ")}`;

export function contactDataCommands(
  contact: NonNullable<SeedContentInput["contacts"]>[number],
  id: number,
): string[] {
  const name = contact.name.trim();
  const lastSpace = name.lastIndexOf(" ");
  const given = lastSpace < 0 ? name : name.slice(0, lastSpace);
  const family = lastSpace < 0 ? "" : name.slice(lastSpace + 1);
  const row = (mime: string, bindings: string[]) =>
    insertCommand("content://com.android.contacts/data", [
      `raw_contact_id:l:${id}`,
      `mimetype:s:vnd.android.cursor.item/${mime}`,
      ...bindings,
    ]);
  return [
    row("name", [
      `data1:s:${contact.name}`,
      `data2:s:${given}`,
      ...(family ? [`data3:s:${family}`] : []),
    ]),
    ...(contact.phones ?? []).map((phone) => row("phone_v2", [`data1:s:${phone}`, "data2:i:2"])),
    ...(contact.emails ?? []).map((email) => row("email_v2", [`data1:s:${email}`, "data2:i:1"])),
  ];
}

export function highestRawContactId(output: string, tag: string): number {
  const ids = [
    ...output.matchAll(
      /^Row: \d+ _id=(\d+), account_name=([^,\r\n]+), account_type=([^\r\n]+)\r?$/gm,
    ),
  ]
    .filter((match) => match[2] === tag && match[3] === ACCOUNT_TYPE)
    .map((match) => Number(match[1]));
  const id = Math.max(...ids);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ActionableError(
      "Cannot read back the inserted raw contact; inspect the Contacts provider before retrying with reset.",
    );
  }
  return id;
}

export function contentRowCount(output: string): number {
  if (output.trim() === "No result found.") {
    return 0;
  }
  const rows = output.trim().split("\n");
  if (!rows.every((row) => /^Row: \d+ _id=\d+(?:,|$)/.test(row.trim()))) {
    throw new ActionableError(
      "Cannot count namespace rows; inspect the provider before resetting.",
    );
  }
  return rows.length;
}
