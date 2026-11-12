# OEM identity lane: first executor rung

- Kind: idea
- Date: 2026-10-31
- Source: moved from `how-it-works/plat/android/oem-identity-lane.md`; #14059, #16142
- Shaped: [OEM identity lane](../how-it-works/plat/android/oem-identity-lane.md)

## Idea

The writable-system rung (`-writable-system`, `adb remount`, edit `build.prop`, add feature XMLs) is
the first rung that covers both descriptor fields, `props` and `features`, without root tooling.
That makes it the likely first executor once it has its own security review.
