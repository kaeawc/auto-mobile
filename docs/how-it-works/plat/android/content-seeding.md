# Android content seeding

`seedContent` is a device control with strict input and output schemas. It is disabled by default,
plan relevant, destructive and non-idempotent: append calls duplicate rows and role grants change
device state. iOS is unsupported.

## Namespace and shell safety

- The caller supplies a namespace matching `[A-Za-z0-9_-]{1,32}`; provider identity is
  `automobile.<namespace>`.
- Android content bindings reject colons in values, so the account tag uses a dot and shell-bound
  text rejects colons.
- The existing shellQuote helper protects each argument and the outer `sh -c` command; the adb
  executor receives argv directly and disables retries for writes.
- No concurrent writer should seed the same namespace on the same device.

## Provisioning the seeder

Contacts, calendar and SMS require the debug-only content-seeder application; call-log-only requests
bypass provisioning.

- The host checks package presence and installs with `-t` when it is missing.
- An installed seeder whose `dumpsys package` requested permissions lack one it is granted is
  upgraded with `install -r -t` first, because `pm grant` refuses an unrequested permission. If the
  upgraded APK still lacks one, the tool refuses before any grant.
- The host then grants the SMS role plus `READ_CALENDAR`, `WRITE_CALENDAR`, `READ_SMS`,
  `READ_CONTACTS` and `WRITE_CONTACTS`. The seeder declares Contacts permissions for photo writes and
  read-back.
- APK lookup uses `AUTOMOBILE_CONTENT_SEEDER_APK_PATH`, then the checkout's
  `android/content-seeder/build/outputs/apk/debug/content-seeder-debug.apk`. A missing-APK error
  names `./gradlew :content-seeder:assembleDebug`.

## Broadcast protocol

- Explicit ordered `SEED` broadcasts carry namespace and kind. Calendar and SMS each send one items
  JSON batch; account, photo and reset use string extras.
- The host converts ISO instants to Unix millisecond `startMillis`/`endMillis`/`dateMillis` values.
- `kind=reset` takes comma-separated calendar/sms kinds. The optional string extra
  `dropAccount=true` removes the shared account after data deletion; with no kinds it performs only
  account removal.
- `kind=account` needs only namespace and returns JSON with `inserted=1` for a newly registered
  account or `0` for an existing one.
- `SeedRequest` validates the complete batch before provider writes.
- `RESULT_OK` data is JSON with inserted and removed counts; `RESULT_CANCELED` carries an error. The
  host reuses the broadcast envelope parser and rejects legacy URI responses.

## Contacts and call logs

- Contacts use raw_contacts with `account_name=automobile.<namespace>` and
  `account_type=dev.jasonpearson.automobile.contentseeder`, then query
  `_id:account_name:account_type` and select the highest ID matching both fields.
- Before inserts, `kind=account` idempotently registers the namespace through the same
  `AccountManager.addAccountExplicitly` path as calendars. ContactsProvider purges raw contacts owned
  by unregistered accounts on account changes, so the registered account type is a persistence
  invariant across namespaces and kinds.
- Non-photo Data rows share one shell batch per contact. Names split at the final space, phones use
  mobile type, emails use home type.
- Call logs batch inserts and carry the tag in `subscription_component_name`.
- Reset scopes provider queries and deletion to the namespace and account type. Contact cleanup also
  includes the legacy `account_type=automobile.<namespace>` while preserving unrelated account types
  with the same name, and uses `caller_is_syncadapter=true` for physical removal. Shell deletions
  return no count, so before/after queries supply counts and confirm absence.

## Contact photos

- Optional `photoPath` is checked through an injected filesystem seam before any device writes:
  regular file, PNG/JPEG extension and magic, and a 524288-byte limit with a bounded read. Relative
  paths resolve against the daemon launch directory.
- The host pushes to `/data/local/tmp/automobile.<namespace>.<rawId>.photo`, then shell pipes the
  bytes to `run-as dev.jasonpearson.automobile.contentseeder sh -c` to create
  `cache/automobile.<namespace>.<rawId>.photo`. The app never directly reads `shell_data_file`, which
  SELinux may deny; `run-as` requires a debuggable APK and creates the file under the app uid with its
  app-data label.
- The photo broadcast carries `kind=photo`, namespace, `rawContactId` and `photoFile` (only the exact
  namespace/id cache filename is accepted). The app verifies raw-contact account ownership, size and
  signature, then inserts a photo Data BLOB through ContentResolver with `caller_is_syncadapter=true`.
  This synchronous insert creates `photo_id`; the provider may also produce `photo_file_id`. App and
  host read-back require one positive photo identifier.
- Both sides delete the staged file after an attempt; host cleanup also runs after cancellation.
  Contact reset verifies absence of namespace photo Data rows after permanent raw-contact deletion and
  removes leftover staging files.
- Dots delimit staging namespace and id because dots are forbidden within a namespace, which keeps
  reset globs namespace-scoped.

## Calendar and SMS

- Calendar accounts are named `automobile.<namespace>` with the registered seeder `ACCOUNT_TYPE`.
  Each requested calendar name identifies a separate calendar within the account.
- All-day boundaries must be UTC midnight, with exclusive `DTEND`; location is preserved.
- Calendar reset deletes events and calendars using the sync-adapter URI and preserves the account by
  default. Only a full namespace reset with no arrays requests account removal, after contact,
  calendar, call-log and SMS deletes finish: removing the shared account during a kind-specific reset
  would purge surviving contacts or calendars.
- SMS rows carry the tag in `service_center` and preserve the read flag. Provider enforcement
  determines SMS write authority; default-package/settings lookups are not reliable role oracles.

## Reset, verification and cleanup

- Reset operates on the supplied kinds, including empty arrays, or all four when arrays are omitted.
  Every reset completes before any insertion begins.
- Contacts and call logs compare tagged row counts before insertion and after all provider writes,
  requiring growth by the requested count. Calendar and SMS query the inserted IDs before returning
  their verified counts; the host rejects counts that differ from the batch size.
- Counts describe confirmed rows. Operations across providers are not transactional, so a failure
  can leave partial data; callers retry with reset.
- There is no automatic namespace cleanup on release: session dispatch journals an opaque persistent
  mutation and uses baseline fallback for cleanup.
