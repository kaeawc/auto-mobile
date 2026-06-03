# Install

You can use our interactive installer to step through all host platform requirements and configuration options. It checks host dependencies, optionally downloads Android or iOS developer tools, and configures the MCP daemon.

``` bash title="One-line install (click to copy)"
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/install.sh | bash
```

![Install Demo](img/install.gif)

Once you've finished that, learn [how to use AutoMobile](using/ux-exploration.md)

## Codex policy options

When the installer configures Codex, it writes an `[mcp_servers.auto-mobile]`
section to `~/.codex/config.toml`. You can opt in to Codex's MCP policy fields
before running the installer:

```bash
AUTOMOBILE_CODEX_MCP_REQUIRED=true \
AUTOMOBILE_CODEX_MCP_ENABLED_TOOLS=observe,tapOn,swipeOn,inputText \
AUTOMOBILE_CODEX_MCP_DISABLED_TOOLS=androidDeviceShell \
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/install.sh | bash
```

This produces Codex-side TOML like:

```toml
[mcp_servers.auto-mobile]
command = "bunx"
args = ["@kaeawc/auto-mobile@latest"]
required = true
enabled_tools = ["observe", "tapOn", "swipeOn", "inputText"]
disabled_tools = ["androidDeviceShell"]
```

`disabled_tools` is applied by Codex after `enabled_tools`.

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

## Uninstalling

To remove AutoMobile and its configurations, use the uninstall script:

``` bash title="One-line uninstall (click to copy)"
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/uninstall.sh | bash
```

??? example "See demo: Uninstall"
    ![Uninstall Demo](img/uninstall.gif)
