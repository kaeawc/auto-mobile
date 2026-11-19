# Android Auto provisioning accepts the welcome screen

- Kind: decision
- Date: 2026-11-16
- Source: #17838
- Shaped: [Android Auto projection provisioning](../how-it-works/plat/android/android-auto-projection-provisioning.md)

## Context

Provisioning with no Google account reached **Welcome to Android Auto** with the DHU running. The
**Continue** tap that accepts Android Auto's terms ran only behind an explicit
`acceptAndroidAutoTerms` request flag, so a device pass without it stopped at the welcome screen and
could not reach the projected launcher. A research spike found no adb, settings or intent route that
marks the terms as accepted.

## Options

- Keep the explicit `acceptAndroidAutoTerms` flag.
- Leave the welcome screen as an owner-run manual step.
- Accept the welcome screen as an internal provisioning step.

## Decision

Provisioning accepts the welcome screen itself on emulator AVDs, with no tool parameter. The step is
idempotent, logged, and reports `already-done` once the screen is gone. It never signs in to Google.

## Consequences

`provisionDevice` and `startDevice` no longer accept `androidAuto.acceptAndroidAutoTerms`, and the
`onboarding` step no longer reports `skipped`.
