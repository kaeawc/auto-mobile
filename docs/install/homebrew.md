# Install with Homebrew

AutoMobile ships a command-line interface through a Homebrew tap. Each release
publishes a formula that pins the exact published npm tarball by SHA-256, so an
install is reproducible and upgrades arrive through the normal `brew` flow.

## Install

```bash
brew tap kaeawc/tap
brew install kaeawc/tap/auto-mobile
```

On recent Homebrew versions, third-party taps require an explicit trust step the
first time you use them. If the install reports the tap is not trusted, run:

```bash
brew trust kaeawc/tap
brew install kaeawc/tap/auto-mobile
```

Verify:

```bash
auto-mobile --version
auto-mobile --cli help
```

The formula declares a dependency on [`bun`](https://bun.sh), which Homebrew
installs from `homebrew-core` automatically. The installed `auto-mobile` command
is a thin wrapper that runs the published bundle with that `bun`.

## Upgrade

Homebrew is the update mechanism — there is no separate self-updater.

```bash
brew update
brew upgrade auto-mobile
```

Each release rewrites the formula in the tap with the new version's `url` and
`sha256`, so `brew upgrade` always moves you to a specific, checksummed build.
To check whether a newer version is available without upgrading:

```bash
brew livecheck auto-mobile
```

## Uninstall

```bash
brew uninstall auto-mobile
brew untap kaeawc/tap
```

## How the formula is published

The formula is generated and pushed automatically on every release by
`scripts/release/update-brew-formula.sh` (invoked from the "Publish Homebrew
formula" step in `.github/workflows/release.yml`). It resolves the just-published
npm tarball, computes its SHA-256, renders the formula, and commits it to the
`kaeawc/homebrew-tap` repository. The step requires the `HOMEBREW_TAP_TOKEN`
secret to have write access to that tap; on a tagged release a missing or expired
token fails the step loudly rather than silently skipping the publish.
