# Install

You can use our interactive installer to step through all host platform requirements and configuration options. It checks host dependencies, optionally downloads Android or iOS developer tools, and configures the MCP daemon.

``` bash title="One-line install (click to copy)"
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/install.sh | bash
```

![Install Demo](img/install.gif)

Once you've finished that, learn [how to use AutoMobile](using/ux-exploration.md)

## Homebrew (macOS)

AutoMobile ships a Homebrew formula that installs the `auto-mobile` CLI and its
Bun runtime dependency. Until the formula is accepted into homebrew-core, tap
this repository directly:

``` bash title="Install via Homebrew"
brew tap kaeawc/auto-mobile https://github.com/kaeawc/auto-mobile
brew install auto-mobile
```

Verify the install:

``` bash
auto-mobile --cli help
```

## Uninstalling

To remove AutoMobile and its configurations, use the uninstall script:

``` bash title="One-line uninstall (click to copy)"
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/uninstall.sh | bash
```

??? example "See demo: Uninstall"
    ![Uninstall Demo](img/uninstall.gif)
