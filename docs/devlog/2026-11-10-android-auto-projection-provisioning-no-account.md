# Android Auto projection: no Google account

- Kind: decision
- Date: 2026-11-10
- Source: moved from `how-it-works/plat/android/android-auto-projection-provisioning.md`; #17843
- Shaped: [Android Auto projection provisioning](../how-it-works/plat/android/android-auto-projection-provisioning.md)

## Context

An account was only ever needed to update the Android Auto stub through Play, and Play reports
Android Auto as not compatible on the API 36 image.

## Options

- Sideload Android Auto with no account.
- Scripted Google sign-in.
- Adding a `com.google` account over adb.

## Decision

The supported path is a sideload, which needs no credentials, so the provisioner has no credential
inputs. Scripted Google sign-in is deliberately absent. A flow that needs a signed-in device uses an
AVD snapshot that a person signed in to once.

## Consequences

Why sign-in automation is excluded:

- Google's guidance disallows scripts that automate keystrokes or clicks to sign in.
- New emulators on datacenter IPs get "Verify it's you", 2-Step Verification and CAPTCHA challenges,
  which automation must not get past, and repeated sign-ins risk locking the account.
- There is no supported way to add a `com.google` account over adb:
  `AccountManager.addAccountExplicitly` needs the authenticator's signature.
