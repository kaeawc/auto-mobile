/** Replaces a credential in a copy of tool arguments; never shows the length or any characters. */
export const TOOL_SECRET_PLACEHOLDER = "<redacted>";

type SecretRedactor = (args: Record<string, unknown>) => Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replace the named string fields of `record` (only those present) with the placeholder. */
function redactFields(record: Record<string, unknown>, fields: readonly string[]) {
  const present = fields.filter((field) => typeof record[field] === "string");
  return present.length === 0
    ? record
    : {
        ...record,
        ...Object.fromEntries(present.map((field) => [field, TOOL_SECRET_PLACEHOLDER])),
      };
}

/** installApp `bundle.keystore.storePassword` / `keyPassword`. */
const redactInstallAppKeystore: SecretRedactor = (args) => {
  const bundle = args.bundle;
  if (!isRecord(bundle) || !isRecord(bundle.keystore)) {
    return args;
  }
  const keystore = redactFields(bundle.keystore, ["storePassword", "keyPassword"]);
  return keystore === bundle.keystore ? args : { ...args, bundle: { ...bundle, keystore } };
};

/** setDeviceState `screenLock.credential` / `currentCredential` (lock-screen PIN, password or pattern). */
const redactSetDeviceStateScreenLock: SecretRedactor = (args) => {
  const screenLock = args.screenLock;
  if (!isRecord(screenLock)) {
    return args;
  }
  const redacted = redactFields(screenLock, ["credential", "currentCredential"]);
  return redacted === screenLock ? args : { ...args, screenLock: redacted };
};

const SECRET_REDACTORS: ReadonlyMap<string, SecretRedactor> = new Map([
  ["installApp", redactInstallAppKeystore],
  ["setDeviceState", redactSetDeviceStateScreenLock],
]);

/**
 * Return a copy of a tool call's arguments with credentials (keystore passwords) replaced by
 * {@link TOOL_SECRET_PLACEHOLDER}; anything else, including non-object arguments and tools that
 * take no credentials, is returned unchanged (the same reference). Unlike typed text, a secret is
 * redacted from every sink, functional recordings included: a replay must be given it again.
 */
export function redactToolSecrets(
  toolName: string | undefined,
  args: Record<string, unknown>,
): Record<string, unknown>;
export function redactToolSecrets(toolName: string | undefined, args: unknown): unknown;
export function redactToolSecrets(toolName: string | undefined, args: unknown): unknown {
  const redactor = toolName === undefined ? undefined : SECRET_REDACTORS.get(toolName);
  return redactor && isRecord(args) ? redactor(args) : args;
}
