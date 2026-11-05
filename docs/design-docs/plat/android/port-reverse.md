# Android port reverse ownership

`portReverse` (`src/server/portReverseTools.ts`) lets a client own `adb reverse`
mappings for its session. `PortReverseManager`
(`src/features/portReverse/PortReverseManager.ts`) holds the state; the adb
commands and the `adb reverse --list` parser live in one place,
`src/utils/android-cmdline-tools/adbReverse.ts`, which the prototype reverse
manager (#12530) also uses.

## Ownership

- One owner per device port: the session UUID, or `sessionless`. State is per
  device serial; operations on one device are serialised.
- A mapping AutoMobile did not create for this session (another session's, a
  user's, a prototype's) is a `port_reverse_conflict` on `ensure`, never
  overwritten. `ensure` checks every requested port before adding any, adds with
  `--no-rebind` so a mapping made after the `--list` read is refused, and rolls
  back its own adds if a later add fails.
- `remove` refuses ports the session does not own, then re-reads `--list` and
  removes a port only while it still maps to the host port AutoMobile set.
  `--remove-all` is never used.
- The prototype manager and this one keep separate owner maps. Each treats the
  other's mappings as pre-existing: prototypes skip them, and `portReverse`
  reports them as conflicts.

## Restore

Reverse listeners live in adbd, so an adb server restart, `adb reconnect`, an
adbd restart (`root`/`unroot`) or an emulator restart drops them. Every
`portReverse` call first re-reads `--list` and re-adds the device's owned
mappings that are missing, reporting the caller's in `restored` or
`restoreFailures`. A failed restore keeps ownership so the next call retries. A
port someone else re-mapped while ours was gone is dropped from ownership and
left in place. `reconcile(deviceId)` runs the same pass for a recovery hook;
transport-recovery paths do not call it yet, so restore happens on the next
call.

## Release

Session release removes that session's mappings; device removal removes all
owned mappings on the device. A device that cannot answer `--list` during
release is assumed gone: ownership is dropped and the failure logged at debug.

## Policy

Device and host ports must be 1024-65535 and, when
`AUTOMOBILE_PORT_REVERSE_ALLOWED_PORTS` is set, inside its ranges. An invalid
value allows nothing. The host side is always `tcp:<port>` on loopback. Ensure,
remove and restore are audit-logged at info with device and session.
