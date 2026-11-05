# Android port reverse ownership

`portReverse` (`src/server/portReverseTools.ts`) lets a client own `adb reverse`
mappings for its session. `PortReverseManager`
(`src/features/portReverse/PortReverseManager.ts`) holds the state; the adb
commands and the `adb reverse --list` parser live in one place,
`src/utils/android-cmdline-tools/adbReverse.ts`, which the prototype reverse
manager (#12530) also uses.

## Ownership

- One owner per device port: the routed session UUID, or `sessionless`. State is
  per device serial; operations on one device are serialised. One process-wide
  manager is shared by the tool and the daemon's session cleanup.
- A mapping AutoMobile did not create for this session (another session's, a
  user's, a prototype's), or one of its own that was re-pointed outside
  AutoMobile, is a `port_reverse_conflict` on `ensure`, never overwritten.
  `ensure` judges conflicts on the device as listed, before any restore, so a
  refused request changes nothing. It adds with `--no-rebind`; a refused add
  whose port `--list` then shows is reported as a conflict. A later failed add
  rolls back this call's earlier adds through the same re-checked removal.
- `remove` refuses ports the session does not own, then re-reads `--list` and
  removes a port only while it still maps to the host port AutoMobile set.
  `adb reverse --remove` takes no host argument, so a re-point between that read
  and the removal cannot be detected. Ownership is dropped only once removal
  succeeds or the mapping is gone or re-pointed. `--remove-all` is never used.
- The prototype manager and this one keep separate owner maps. Each treats the
  other's mappings as pre-existing: prototypes skip them (and add with
  `--no-rebind`), and `portReverse` reports them as conflicts.

## Restore

Reverse listeners live in adbd, so an adb server restart, `adb reconnect`, an
adbd restart (`root`/`unroot`) or an emulator restart drops them. Every
`portReverse` call except `remove` re-reads `--list` and re-adds the device's
owned mappings that are missing, reporting the caller's in `restored` or
`restoreFailures`. A failed restore keeps ownership so the next call retries. A
port someone else re-mapped while ours was gone is dropped from ownership and
left in place. `reconcile(deviceId)` runs the same pass for a recovery hook;
transport-recovery paths do not call it yet, so restore happens on the next
call.

## Release

Session release and device unbind remove that session's mappings on the device,
registered as pending device cleanup so the next session waits for it. Device
removal from the pool removes only `sessionless` mappings: Android recovery
removes and re-adds a device while its session stays bound, and that session's
mappings are restored on its next call. A released mapping whose removal fails
(or whose device cannot answer `--list`) leaves `owned`, so it is never restored,
and waits in a pending-removal set: the device's next `--list` retries the
removal while the port still maps to the host port AutoMobile set, and drops it
once the port is gone or re-pointed. When release reports that another device
now answers on the serial (identity replacement), the session's ownership and the
device's pending removals are forgotten without sending any command.

## Policy

Device and host ports must be 1024-65535 and, when
`AUTOMOBILE_PORT_REVERSE_ALLOWED_PORTS` is set, inside its ranges. An invalid
value allows nothing. The host side is always `tcp:<port>` on loopback. Ensure,
remove and restore are audit-logged at info with device and session.
