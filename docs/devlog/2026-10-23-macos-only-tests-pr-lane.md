# macOS-only test subset on a PR lane

- Kind: idea
- Date: 2026-10-23
- Source: moved from `how-it-works/ci/macos-only-tests.md`; #15067
- Shaped: [macOS-only (iOS) unit and integration tests](../how-it-works/ci/macos-only-tests.md)

## Gap

Since the owner rule that iOS tests never run on Linux or Windows (#15067), no pull-request lane runs
the macOS-only files. They run only in the nightly CircleCI `macOS Node Unit Tests` and
`macOS Node Host Integration Tests` jobs and in local runs on a Mac, so an iOS regression is caught a
night late at worst.

## Idea

A PR lane that runs only the macOS-only subset on a Mac runner would close the gap. It was not part of
#15067.
