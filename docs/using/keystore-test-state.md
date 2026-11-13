# Keystore test state

Android Keystore test state is opt-in, disabled by default, and available
only in the AutoMobile SDK debug variant of the app. The app declares an exact
scope name and an explicit set of aliases; prefixes, globs, and cross-app access
are not supported.

Discovery comes from the `secure_state` domain of the
[storage capabilities](storage-capabilities.md) resource.

## Response

The JSON response contains:

| Field                   | Meaning                                       |
| ----------------------- | --------------------------------------------- |
| `capability`, `outcome` | The capability and its result                 |
| `reason`                | Optional stable code (see below)              |
| `bridgeAvailable`       | Whether the app's SDK bridge is reachable     |
| `metadata`              | `supported`                                   |
| `mutation`              | `declared_unsupported`                        |
| `deviceLocked`          | `locked`, `unlocked`, or `unknown`            |
| `scopes`                | Sorted declared scopes (hidden when disabled) |

Branch on `reason`, not on error text: `BRIDGE_NOT_INSTALLED`, `DISABLED`,
`BRIDGE_UNAVAILABLE`, or `DECLARED_UNSUPPORTED`. An old CtrlProxy APK reports
`unsupported` / `DECLARED_UNSUPPORTED`; update the APK to get discovery.

`deviceLocked: locked` reports the device lock state but does not block metadata
reads. Deletion can report per-alias `locked` and `authentication_required` outcomes.

A metadata read checks that each present key created with
`setUserAuthenticationRequired(true)` can still be used. A new fingerprint
enrollment, for example, can permanently invalidate such a key. If a key is
invalidated or needs authentication first, the whole read returns
`authentication_required` / `AUTHENTICATION_REQUIRED` with no `entries`. This holds
even when other aliases in the scope are healthy.

Query one `alias` to find the affected key. Authenticate through the app's normal
flow, or delete and re-create an invalidated key. Other keys, and keys whose
usability AutoMobile cannot check, report presence and category only, so `ok` does
not prove that a key is usable.

## Android scoped deletion

Call `resetKeychain` with `appId`, an explicit device target (`deviceId`, `device`,
or `sessionUuid`), and `scope` and/or `alias`. A scope deletes every exact alias
registered in that scope. An alias alone works when any scope declares it; with
a scope it must belong to that scope. AutoMobile rejects an empty selector.

The app must enable Keystore test state, declare the selected aliases, and enable
both its storage mutation capability and mutation policy. Android needs neither
`confirm` nor a session, but `confirm: false` refuses the reset. A recorded plan
writes `confirm: false`, so its replay stops at this step until you set
`confirm: true`. The reset does not create or re-provision keys.

The result reports `scope: "app"`, `requestedScope`/`requestedAlias`, and
`deletedCount`. It also holds one outcome per attempted alias: `deleted`,
`not_found`, `locked`, `authentication_required`, or `failed`. The reset attempts
every selected alias. Overall `status` is `deleted` when all are deleted, `partial`
when some are deleted, and `failed` when none are deleted, including when all are
absent. The `success` field is true only for `deleted`; partial and failed results
are tool errors. The result holds
only identifiers and counts, never key material.

Request-level refusals have an `outcome` and `reason`, a zero deleted count, and
no per-alias results. They are `disabled` / `DISABLED`, `scope_not_declared` /
`SCOPE_NOT_DECLARED`, `authorization_denied` / `MUTATION_NOT_ALLOWED`,
`invalid_selector` / `EMPTY_SELECTOR`, `unsupported` / `DECLARED_UNSUPPORTED`, or
`unavailable` / `BRIDGE_NOT_INSTALLED` or `BRIDGE_UNAVAILABLE`. Enable the app's
opt-in and mutation policy, correct its declarations, or install/update its debug
bridge and CtrlProxy as indicated. Unlock or use the app's normal authentication
flow for protected keys; AutoMobile does not bypass authentication. A transport
timeout leaves deletion completion uncertain; inspect app state before retrying.

Discovery retains `mutation: "declared_unsupported"` for compatibility; it does
not advertise deletion authorization. `secure_state.read` remains unavailable.
The provider and its discovery/deletion calls are absent from release builds.
Package-data reset remains a separate operation. On iOS Simulator,
`resetKeychain` still requires `confirm: true` and clears every app's Keychain.

## Fault injection

Call `resetKeychain` with `action: "injectFault"`, `appId`, an explicit device
target, `scope` and/or `alias`, and `kind`: `KEY_STORE_EXCEPTION`,
`PROVIDER_EXCEPTION`, `USER_NOT_AUTHENTICATED`, `DELAY`, or
`STRONGBOX_UNAVAILABLE`. Injection deletes nothing. Use exact declared aliases; a
scope selects all its aliases.

For `DELAY`, supply an integer `delayMs` from 1 through 10000. Only `injectFault`
accepts `kind` and `delayMs`. The delay runs before each selected alias's metadata
lookup or deletion operation. The delays in one provider call add up to at most
10000 ms; after that, the call's remaining operations run without delay. A
`resetKeychain` reset waits up to 20 s for the bridge, so injected delay alone does
not make it report `BRIDGE_UNAVAILABLE`.

`KEY_STORE_EXCEPTION`, `PROVIDER_EXCEPTION`, and `USER_NOT_AUTHENTICATED` simulate
the named failure on those same operations.

`STRONGBOX_UNAVAILABLE` affects key generation only, and only in an app that runs
the debug SDK's key-generation check with its key spec immediately before
generating a key ([integration](../how-it-works/plat/android/keystore-strongbox-fault.md)).
When the alias is armed and the spec requests StrongBox, generation fails with
`StrongBoxUnavailableException`, as it does on a device without StrongBox, so the
app's fallback runs. Keys that do not request StrongBox, unarmed aliases, API
levels below 28, and release builds are unaffected. Metadata and deletion ignore
this kind.

Setting a fault replaces the previous fault for each selected alias.

Call `resetKeychain` with `action: "clearFaults"` and `alias` to clear one fault,
or `scope` to clear all faults for that scope. Empty selectors are refused for both
actions. Both are Android-only, keep the reset's selector and `confirm: false`
rules, and require the same app opt-in and mutation policy as deletion. Faults
persist until cleared or the app process restarts; observing disabled or reset
test state clears all faults. Disabled test state never applies faults. The same
debug app provider also accepts these as `injectFault` and `clearFaults` calls on
`content://<appId>.automobile.keystore` with the same extras.

The result has `action`, `success` (true only for outcome `ok`), `scope: "app"`,
`schemaVersion`, `capability: "storage.keystore"`, `bridgeAvailable`, `outcome`,
and any supplied `requestedScope`, `requestedAlias`, and `requestedKind`.
Refusals add `reason`: `disabled` / `DISABLED`, `authorization_denied` /
`MUTATION_NOT_ALLOWED`, `scope_not_declared` / `SCOPE_NOT_DECLARED`,
`invalid_selector` / `EMPTY_SELECTOR` or `INVALID_FAULT`, or `unsupported` /
`DECLARED_UNSUPPORTED` (an app SDK without fault injection). They can also add
`unavailable` / `BRIDGE_NOT_INSTALLED` (no debug SDK provider in the app) or
`BRIDGE_UNAVAILABLE`.
Correct the selector, kind, delay, or app authorization, or install a debug build
with a current SDK, before retrying. Faulted metadata can report
`authentication_required` or `unavailable`; deletion retains its per-alias
failure outcomes. Responses never include exception text or key material.

## iOS Keychain item deletion

`deleteKeychainItem` deletes one app-owned generic-password item through the debug
AutoMobile SDK. It is disabled by default and requires embedded-SDK mode. The app
must opt in with `StorageInspectionConfiguration.allowKeychainDeletion` and
`allowedKeychainDeletionEntries`, declaring each exact service/account/access-group
tuple. Storage mutations and host authorization must also be enabled, with an
authorized active session or a launch-scoped mutation token.

Call with `appId`, `selector: { itemClass: "genericPassword", service, account,
accessGroup }`, and `confirm: true`. All selector fields must be nonempty. Bring the
app to the foreground first. Wildcards, batch deletion, secret export, and
interactive authentication are unavailable.

`deleted` returns the exact `deletedScope`. All other outcomes are tool errors:
`not_found`, `invalid_selector`, `unsupported_item_type`, `confirmation_required`,
`app_id_mismatch`, `scope_not_authorized`, `mutation_not_authorized`,
`protected_data_unavailable`, `user_auth_required`, `entitlement_denied`,
`keychain_error`, or `sdk_unavailable`. Correct the selector, confirmation, app,
SDK configuration or authorization as indicated. Protected-data or authentication
failures require the app's normal user flow; the tool never prompts or bypasses it.
No values or secret bytes leave the app. This operation is separate from the
simulator-wide `resetKeychain` operation and does not enable Keychain inspection.
