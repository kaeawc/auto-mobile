# Keystore StrongBox-unavailable fault

The debug SDK's Keystore fault plan wraps the SDK's own Keystore backend, which
covers metadata lookups and deletion. Key generation happens in app code, through
`KeyGenerator` or `KeyPairGenerator`, so the SDK cannot intercept it.
`STRONGBOX_UNAVAILABLE` therefore needs the app to make one call before it
generates a key.

## Contract

- The app calls `KeystoreTestState.checkKeyGeneration(spec)` with its
  `KeyGenParameterSpec` immediately before `generateKey()`/`generateKeyPair()`.
- The method reads `spec.keystoreAlias` and `spec.isStrongBoxBacked` and passes
  them to an internal `KeyGenerationGate`. Main source holds only that nullable
  gate. `KeystoreFaultPlan` (debug source) installs the gate when a fault is
  injected.
- The gate throws `StrongBoxUnavailableException` with no message when StrongBox
  is requested and the alias is declared, enabled, and armed with
  `STRONGBOX_UNAVAILABLE`. That is the type the platform throws from key
  generation on a device without StrongBox, and it is a `ProviderException`, so
  the app's existing fallback handles it.
- Release builds never install the gate, so the call is a no-op there. It is also
  a no-op below API 28, where StrongBox cannot be requested. The published-AAR
  check (`scripts/android/validate-sdk-debug-inspector-consumer.sh`) requires
  `KeystoreFaultPlan` in the debug AAR and its absence from the release AAR.
- The fault plan's backend decorator treats this kind as a no-op, so metadata and
  deletion report the real Keystore state.

## Why a pre-generation check

Wrapping generation, so that the SDK calls `generateKey()` itself, would put
provider and algorithm choices in the SDK. Registering a JCA provider named
`AndroidKeyStore` ahead of the platform one is not possible: `Security` refuses a
second provider with the same name. A check that takes the app's own spec leaves
generation unchanged and fails exactly where the platform would.
