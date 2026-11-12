# Keystore StrongBox fault: pre-generation check

- Kind: decision
- Date: 2026-11-06
- Source: moved from `how-it-works/plat/android/keystore-strongbox-fault.md`; #17314
- Shaped: [Keystore StrongBox-unavailable fault](../how-it-works/plat/android/keystore-strongbox-fault.md)

## Context

The debug SDK's Keystore fault plan wraps only the SDK's own Keystore backend. Apps generate keys
themselves through `KeyGenerator` or `KeyPairGenerator`, so `STRONGBOX_UNAVAILABLE` cannot be
injected without the app's help.

## Options

- Wrap generation, so the SDK calls `generateKey()` itself.
- Register a JCA provider named `AndroidKeyStore` ahead of the platform one.
- Have the app pass its own `KeyGenParameterSpec` to a check immediately before generating.

## Decision

The app calls `KeystoreTestState.checkKeyGeneration(spec)` before `generateKey()`/`generateKeyPair()`.

## Consequences

- Wrapping generation would have put provider and algorithm choices in the SDK.
- A second provider is not possible: `Security` refuses a second provider with the same name.
- The check takes the app's own spec, leaves generation unchanged and fails exactly where the
  platform would.
