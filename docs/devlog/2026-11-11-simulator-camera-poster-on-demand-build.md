# Build the camera poster dylib on demand

- Kind: decision
- Date: 2026-11-11
- Source: moved from `how-it-works/plat/ios/simulator-camera-poster.md`; #17990, #18073
- Shaped: [iOS Simulator camera poster](../how-it-works/plat/ios/simulator-camera-poster.md)

## Context

The camera poster injection library (`libAMCameraPoster.dylib`) must be available wherever the
daemon starts a simulator, including from an installed npm package.

## Options

1. Ship the single self-contained Objective-C source (about 30 KB) and build on demand.
2. Ship a prebuilt, checksummed universal dylib following the `prototype-agent` release asset
   pattern.

## Decision

Option 1. Simulator code signing is ad hoc and not enforced, and starting a simulator already
requires Xcode, so a local build adds no new requirement.

## Consequences

First use pays a compile. A prebuilt asset (option 2) would remove it; until then
`AUTOMOBILE_IOS_CAMERA_POSTER_DYLIB` serves users who supply their own build. For SDK-linked apps, a
debug-only frame source was named as the next candidate when injection is unavailable.
