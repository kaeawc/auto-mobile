# `getAndroid` without an identifier selects a phone

- Kind: decision
- Date: 2026-11-24
- Source: #19124, #19147
- Shaped: [Android phones and tablets](../using/android.md)

## Context

`getAndroid` advertised every input property as optional, but a schema refinement rejected a
call that named neither `avdName` nor `deviceId`. A client reading the schema had no way to
know an identifier was required, so a bare call failed with `Invalid parameters` and cost an
extra `listDeviceImages` round trip. The schema could not advertise the requirement either: the
tool-schema flattener strips a top-level `anyOf`, because the Anthropic API rejects top-level
combinators.

## Options

- Advertise the requirement as a top-level `anyOf`. Not possible: the flattener strips it.
- Keep the refinement and improve its message. The schema would still say "all optional".
- Let a bare call select a device.

## Decision

A call with neither identifier selects a device through the existing selector boot: with no
`requires`, it asks for `formFactor: "phone"`, preferring a running device, then a configured
image, and never creates one. Lifecycle coordination uses the selector lease, which binds the
resolved AVD's stable identity before the boot changes anything. When nothing matches, the error
names `listDeviceImages` and `avdName`.

## Consequences

A bare `getAndroid` can cold-boot whichever configured phone AVD the matcher ranks first. A
running device is picked only when its form factor is known to be phone; any other device
still needs `deviceId`.
