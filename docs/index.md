# AutoMobile

AutoMobile is an MCP server that lets an AI agent observe and control Android
and iOS devices.

<style>
  .install-command {
    max-width: 42rem;
  }

  .install-command code {
    font-size: 0.72rem;
  }

  .desktop-install-options {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin: 0.75rem 0 1.5rem;
  }

  .desktop-install-options a {
    border: 1px solid var(--md-default-fg-color--lighter);
    border-radius: 0.5rem;
    color: var(--md-default-fg-color);
    min-width: 9rem;
    padding: 0.5rem 0.75rem;
    text-align: center;
    text-decoration: none;
  }

  .desktop-install-options a:hover {
    border-color: var(--md-accent-fg-color);
  }

  .desktop-install-options span {
    color: var(--md-default-fg-color--light);
    display: block;
    font-size: 0.7rem;
  }
</style>

## Install

<div class="install-command" markdown>
~~~bash
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/install.sh | bash
~~~
</div>

Run this in your app repository for project configuration, or elsewhere for
global configuration. Restart your MCP client when it finishes.

![Install Demo](img/install.gif)

The last step of the install script offers to install the AutoMobile desktop app. You can also download it and have the AutoMobile MCP daemon installed from that end.

<div class="desktop-install-options">
  <a href="https://github.com/kaeawc/auto-mobile/releases/download/0.0.66/AutoMobile-0.0.66-macos.dmg" aria-label="Download AutoMobile Desktop App for macOS x86-64">
    <strong>macOS</strong>
    <span>x86_64 · DMG</span>
  </a>
  <a href="https://github.com/kaeawc/auto-mobile/releases/download/0.0.66/AutoMobile-0.0.66-linux.deb" aria-label="Download AutoMobile Desktop App for Linux x86-64">
    <strong>Linux</strong>
    <span>x86_64 · DEB</span>
  </a>
  <a href="https://github.com/kaeawc/auto-mobile/releases/download/0.0.66/AutoMobile-0.0.66-windows.msi" aria-label="Download AutoMobile Desktop App for Windows x86-64">
    <strong>Windows</strong>
    <span>x86_64 · MSI</span>
  </a>
</div>


### Manual MCP configuration

~~~json
{
  "command": "bunx",
  "args": ["@kaeawc/auto-mobile@latest"]
}
~~~

Place this server in the client’s documented MCP configuration, then restart
the client. Going this route means you're going to handle dependencies like having
bun and ffmpeg.

### First use

Open your configured agent and ask it to explore your mobile app. If you have a connected physical device it'll recognize it, otherwise it'll look for emulators / simulators to use or provision.

Some common workflows:

- [Explore an app](using/ux-exploration.md)
- [Reproduce a bug](using/reproducing-bugs.md)
- [Measure performance](using/performance.md)

### Uninstall

~~~bash
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/uninstall.sh | bash
~~~
