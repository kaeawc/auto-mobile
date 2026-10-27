# Release notes draft: host-wide device claims table

Tracking issue: #11811. For the release notes of the first release that contains migrations
`2026_10_26_014_device_claims` and `2026_10_27_015_device_claims_metadata`.

## What changes

The host binding registry database gains a `device_claims` table: one row per claimed device,
written beside the allocation claim files and read as an extra source of device ownership. The
claim files still decide when the table cannot be read.

## Older daemons refuse the registry after the upgrade

The first daemon of this release to open the registry runs the two migrations. A daemon from an
earlier release that opens the registry afterwards sees migrations it does not know and refuses it
(`BindingRegistrySchemaUnsupportedError`), the same behaviour earlier registry migrations had. Such a
daemon keeps honouring the claim files, so devices an older and a newer daemon share stay exclusive,
but it cannot use the registry (session broker bindings, execution owners) until it is upgraded.

Upgrade every daemon on a host together. `auto-mobile doctor` from an older release reads a migrated
registry as unreadable and reports no exec owners rather than failing.

## Verification

Live multi-daemon acceptance on a shared adb server is tracked in #15542 (`needs-device-verify`).
