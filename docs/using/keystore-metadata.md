# Keystore metadata

The SDK's `metadata` call, available to app tests, inspects a declared Keystore
alias. Declare scopes and aliases first; see [Keystore test state](keystore-test-state.md).

It takes a required exact `scope` and an optional exact `alias`, and reports only
`alias`, `present`, and `category: KEY|CERTIFICATE|UNKNOWN`:

- `present: false` means the alias is **not present or not observable**, with
  category `UNKNOWN`.
- Key entries report `KEY`; `SECRET_KEY` and `PRIVATE_KEY` are reserved values.
- Aliases the app did not declare return `SCOPE_NOT_DECLARED`, whether or not they
  exist.
- No keys, certificates, certificate chains, values, or credential bytes are
  returned.
