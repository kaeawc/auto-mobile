# Device availability and capacity

This page covers why AutoMobile may not hand you a device yet, and what to do.
For who may control a held device, see [Device ownership](device-ownership.md).

## Retryable acquisition refusals

AutoMobile refuses an acquisition it cannot grant yet with a typed, retryable
code. Wait and retry:

| Code                            | Meaning and next step                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `device_cleanup_in_progress`    | The device is still being released. `retryAfterMs` says how long cleanup can take. The CLI and MCP proxy poll this for you. |
| `device_owned_by_other_daemon`  | Another daemon holds the device.                                                                                            |
| `device_shutting_down`          | The device is stopping.                                                                                                     |
| `device_offline`                | An exact Android device stayed `offline` or `unauthorized` after a short wait.                                              |
| `session_rebinding`             | A kill raced the session's own rebind.                                                                                      |
| `device_unhealthy`              | A health marker refuses the device; see below.                                                                              |
| `orphan_recorder_active`        | A leftover screen recorder could not be confirmed stopped. Retry, or stop it by recording id.                               |
| `device_owned_by_other_session` | From `setActiveDevice` on a device another request is still preparing; carries `retryAfterMs: 2000`.                        |

`device_unhealthy` lists each unhealthy candidate in `devices`, with its
`deviceId`, `reason` and `recovering` state. While `retryable` and `recovering`
are true, wait, honouring `retryAfterMs` when present. When recovery ends with
the marker kept, the refusal is non-retryable: replace the device with
`killDevice` then `startDevice`. Reads stay allowed on marked devices.

A kill naming a device the session has already left returns
`session_no_longer_owns_device` (`retryable: false`). Check who holds the device
before killing it.

## Device status in listings

`listDevices` and the device resources report one status per device. A device
that cannot be lent out is `assigned`, not `idle`. That covers a device that:

- has a session, or is shutting down or still becoming ready;
- a broker binding or another daemon holds;
- is idle with an unhealthy marker.

A device in error stays `error`. `idle + assigned + error` equals the total.

## Boot capacity

AutoMobile admits cold boots against host capacity, with a limit on booted
devices per platform:

| Platform | Limit                                                                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android  | The smaller of half the host RAM divided by the measured per-device memory, and half the CPU cores                                                                                                          |
| iOS      | The smaller of 60% of host RAM divided by the measured per-simulator footprint (about 2.4 GiB; 2.5 GiB when unmeasured) and a settled-CPU budget (about 0.1 core per simulator, half the cores); at least 1 |

Every booted emulator or simulator counts, including ones started outside
AutoMobile. Adopting an already-running device never hits the limit.

AutoMobile does not queue a boot over the limit. It fails at once with the
retryable `capacity_exhausted`, which carries:

| Field                         | Meaning                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `retryAfterMs`                | How long to wait before retrying                                                                                                |
| `limit`, `booted`, `platform` | The limit and current count for the platform                                                                                    |
| `externalDevices`             | When relevant: running devices AutoMobile did not start                                                                         |
| `heldDevices`                 | When relevant: iOS simulators held by AutoMobile sessions or bindings; release the session first rather than shutting them down |

`listDevices` reports `capacity` per platform as `{ limit, booted, inFlight }`.
If AutoMobile cannot read the booted count, it refuses the boot with
`discovery_incomplete`. See
[environment variables](environment-variables.md#boot-capacity) for the opt-out
and per-platform overrides.

## A device that drops off

An Android device that `adb` still lists as `offline` stays held for up to 60
seconds before it counts as lost. It still appears in `listDevices` with its
session and connection state. AutoMobile releases a physical USB device that
vanishes from `adb devices` at once.

A phone reachable over both USB and Wi-Fi is one device. A call may name it by
either endpoint, or an emulator by its `localhost:<port>` address. AutoMobile
judges it exactly as if it named the canonical id.

- If a transport cannot be identified and a held device could be its alias, a
  control call gets `device_owned_by_other_session`. Address the device by its
  USB serial or `emulator-NNNN` id.
- If the `adb devices` listing itself fails, a control call naming a wireless
  address AutoMobile has not seen gets the retryable `discovery_incomplete`.

### Transient Android transport failures

An `adb` transport failure on a session-owned device returns
`device_transport_unavailable` with `retryable: true`, `retryAfterMs`, `deviceId`
and `dispatched`.

- `dispatched: false`: `adb` refused the command before dispatch. AutoMobile
  already retried briefly; retrying is safe.
- `dispatched: "unknown"`: the transport dropped after dispatch, so the command
  may have run. Observe before reissuing a non-idempotent action, especially an
  `openLink` with a single-use sign-in link.

## Cold iOS observe freshness

With more simultaneous cold iOS observes than the configured launch concurrency,
a queued or running launch can outlast the read budget. `observe` keeps that
budget and reports the pending state. The result has no hierarchy, and carries:

- `ok: true`, `freshness.isFresh: false` and
  `freshness.unavailableReason: "runner_launch_queued"`;
- the queue position when queued, or a note that the runner is still starting in
  the background;
- any captured screenshot.

The start continues for up to 60 seconds after its launch leaves the queue.
Waiting in the queue has its own bound of 5 minutes. A retry joins that same
start. While it runs it holds the device's readiness lock, so a concurrent
`startDevice` or session upgrade for that simulator waits within its own
deadline. Retry the observe shortly. A warm retry can complete in about 1.4
seconds; timing depends on the device and host.

## Rolling back a provisioned AVD

Suppose `provisionDevice` created an Android AVD and never attempted to boot it.
While the request holds the lifecycle reservation, an unrelated unnamed sibling
emulator does not block its rollback. If AutoMobile refuses the rollback before
changing the device, the response keeps the original failure's retryability. It
reports the retained device in `lifecycle`. Follow `recovery.nextAction`, which
permits reacquiring an intact retained device when the original failure is
retryable.

## Several daemons on one host

Every daemon that shares an adb server must run the same release or later. An
older daemon cannot see a device that a newer daemon claimed in the shared claims
table.

A daemon warning about unknown registry migrations means a newer release has
updated shared ownership data. Until restart, that daemon decides ownership from
its own allocation claim files only. In this `files_only` mode it does not
enforce managed bindings, so it can allocate a device held only by a managed
binding. The warning names writer versions when recorded. Upgrade the daemons
sharing managed devices to a release that includes these migrations, then
restart older daemons.

A strict ownership read that finds unknown migrations returns
`registry_schema_unsupported`, which is not retryable. Its `dbPath`,
`unknownMigrations` and `writerVersions` fields identify the registry and the
builds that wrote it.
The `writerVersions` field maps migration names to the builds that applied them; it leaves
out older migrations without a recorded writer.

To check versions, run `auto-mobile --daemon capabilities --json`. In
session-broker mode, an already-open registry adds `bindingRegistry`:

| Field                | Meaning                                           |
| -------------------- | ------------------------------------------------- |
| `schemaVersion`      | Latest recorded migration                         |
| `knownSchemaVersion` | Latest migration this daemon knows                |
| `supported`          | Whether this daemon knows all recorded migrations |
| `writerVersion`      | The build that recorded the latest migration      |

A null version means it is unknown. The block is absent when no registry is
open or a read fails unexpectedly. Use these versions to choose an upgrade that
understands every recorded migration.
