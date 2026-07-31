# Install

You can use our interactive installer to step through all host platform requirements and configuration options. It checks host dependencies, optionally downloads Android or iOS developer tools, and configures the MCP daemon.

``` bash title="One-line install (click to copy)"
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/install.sh | bash
```

![Install Demo](img/install.gif)

Once you've finished that, learn [how to use AutoMobile](using/ux-exploration.md)

## Homebrew (macOS)

AutoMobile is published to the shared `kaeawc/tap` Homebrew tap on every
tagged release. The formula installs the `auto-mobile` CLI and pulls in
Bun as a runtime dependency.

``` bash title="Install via Homebrew"
brew install kaeawc/tap/auto-mobile
```

Verify the install:

``` bash
auto-mobile --cli help
```

## Android emulator crash recovery

To let a pool-started Android emulator recover from a mid-session process exit
or confirmed ADB disconnect, set this environment variable on the process that
starts the AutoMobile daemon:

``` bash
AUTOMOBILE_ANDROID_REBOOT_ON_DEATH=1 auto-mobile
```

`AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH=1` is supported as a compatibility alias.
Only the exact value `1` enables recovery. AutoMobile retries the same AVD at
most twice per daemon lifetime, with backoff; after that budget is exhausted it
removes and suppresses the device as it normally would. This does not recover
externally started emulators or iOS simulators.

## Uninstalling

To remove AutoMobile and its configurations, use the uninstall script:

``` bash title="One-line uninstall (click to copy)"
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/uninstall.sh | bash
```

??? example "See demo: Uninstall"
    ![Uninstall Demo](img/uninstall.gif)
