# Release notes draft: host-wide device claims table

Tracking issue: #11811. For the release notes of the first release that contains migrations
`2026_10_26_014_device_claims` and `2026_10_27_015_device_claims_metadata`.

## What changes

The host binding registry database gains a `device_claims` table: one row per claimed device.
For Android and iOS the table decides allocation: a daemon claims a device with an atomic write
that succeeds only while no live daemon holds the row, and writes no allocation claim file. Claim
files are still read, and still written for watchOS and tvOS (the table does not admit those
platforms yet) and whenever no registry can decide (none open, a files-only daemon, a failed write).

## Mixed versions are unsupported

Every daemon that shares an adb server must run this release or later. An older daemon reads
only the allocation claim files, so it does not see a device a newer daemon claimed in the table
and can allocate it too. Upgrade all daemons on a host together, then restart them.

## Older daemons run files-only after the upgrade

The first daemon of this release to open the registry runs the two migrations. A daemon
that does not know those migrations runs generic acquisition in files-only mode: allocation
claim files alone decide ownership. Managed bindings are not enforced by files-only
daemons, so they can allocate a device held only by a managed binding. The device-claims
mirror skips reads, writes, opens and retries until restart. A warning names the registry
and unknown migrations once per process per registry path. Registry writers and ownership readers that
require current evidence still refuse with non-retryable `registry_schema_unsupported`.

Upgrade the daemons sharing managed devices to a release that includes these migrations.
The exclusion diagnostic exposes the degraded mode and remedy.

## Verification

Live multi-daemon acceptance on a shared adb server is tracked in #15542 (`needs-device-verify`).

## Known limits

- Files-only daemons do not enforce managed bindings: they can allocate a device held
  only by a managed binding because allocation claim files alone decide ownership.
  Allocation claim files guard active executions, but idle bindings do not retain them.
  Upgrade the daemons sharing managed devices to a release that includes these migrations.
  The mirror remains skipped until restart.

- A local daemon never creates the registry. If it starts without one, claim and release writes
  probe for it on their retry ladder (1 s, 5 s, 30 s, 2 min, 5 min). Once the file appears, a
  post-bind background open backfills held claims with their original claim time and owed releases.
  A file created after the last step (about 7.6 minutes after the last write) is picked up by the next
  claim or release, or at the next daemon start.
- A row without a recorded control socket (written by an early build or while no socket was bound) is
  judged by its owner's PID alone, so a live owner whose release write was lost keeps the device
  refused until it exits.
