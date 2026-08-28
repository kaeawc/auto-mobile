# AutoMobile

AutoMobile is an MCP server that lets AI agents control your Android & iOS
devices using natural language. It uses standard platform tools like `adb` &
`simctl` paired with its own additional Kotlin & Swift libraries and apps. All
components are open source. The point is to provide mobile engineers with AI
workflow tools to perform UX deep dives, reproduce bugs, and run automated
tests.

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

  .desktop-install-options.is-filtered [data-platform]:not(.is-recommended) {
    display: none;
  }

  .desktop-install-toggle {
    background: transparent;
    border: 0;
    color: var(--md-primary-fg-color);
    cursor: pointer;
    padding: 0.5rem 0;
    text-decoration: underline;
  }
</style>

## Install

<div class="doc-switcher" data-doc-switcher="install-method" data-doc-switcher-default="one-line" role="group" aria-label="Installation method">
  <button type="button" data-doc-switcher-option="one-line">One-line install</button>
  <button type="button" data-doc-switcher-option="manual">Manual</button>
</div>

<div data-doc-switcher-panel="install-method" data-doc-switcher-value="one-line" markdown>

<div class="install-command" markdown>
~~~bash
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/install.sh | bash
~~~
</div>

Run this in your app repository for project configuration, or elsewhere for
global configuration. Restart your MCP client when it finishes.

![Install Demo](img/install.gif)

<div class="desktop-install-options">
  <a data-platform="macos" href="https://github.com/kaeawc/auto-mobile/releases/download/0.0.66/AutoMobile-0.0.66-macos.dmg" aria-label="Download AutoMobile Desktop App for macOS x86-64">
    <strong>macOS</strong>
    <span>x86_64 · DMG</span>
  </a>
  <a data-platform="linux" href="https://github.com/kaeawc/auto-mobile/releases/download/0.0.66/AutoMobile-0.0.66-linux.deb" aria-label="Download AutoMobile Desktop App for Linux x86-64">
    <strong>Linux</strong>
    <span>x86_64 · DEB</span>
  </a>
  <a data-platform="windows" href="https://github.com/kaeawc/auto-mobile/releases/download/0.0.66/AutoMobile-0.0.66-windows.msi" aria-label="Download AutoMobile Desktop App for Windows x86-64">
    <strong>Windows</strong>
    <span>x86_64 · MSI</span>
  </a>
</div>

<script>
  (() => {
    const options = document.querySelector(".desktop-install-options");
    if (!options) return;

    const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
    const detected = /win/i.test(platform)
      ? "windows"
      : /mac/i.test(platform)
        ? "macos"
        : /linux/i.test(platform)
          ? "linux"
          : null;
    const recommended = detected && options.querySelector(`[data-platform="${detected}"]`);
    if (!recommended) return;

    recommended.classList.add("is-recommended");
    options.classList.add("is-filtered");

    const toggle = document.createElement("button");
    toggle.className = "desktop-install-toggle";
    toggle.type = "button";
    toggle.textContent = "Other desktop downloads";
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      const showingRecommendedOnly = options.classList.toggle("is-filtered");
      toggle.textContent = showingRecommendedOnly
        ? "Other desktop downloads"
        : `Show ${recommended.textContent.trim().split(/\s+/)[0]} download`;
      toggle.setAttribute("aria-expanded", String(!showingRecommendedOnly));
    });
    options.append(toggle);
  })();
</script>

</div>

<div data-doc-switcher-panel="install-method" data-doc-switcher-value="manual" markdown>

```json
{
  "command": "bunx",
  "args": ["@kaeawc/auto-mobile@latest"]
}
```

Place this server in the client’s documented MCP configuration, then restart
the client. Going this route means you're going to handle dependencies like having
bun and ffmpeg.

</div>

### First use

Open your configured agent and ask it to explore your mobile app. If you have a connected physical device it'll recognize it, otherwise it'll look for emulators / simulators to use or provision.

Some common workflows:

- [Explore an app](using/ux-exploration.md)
- [Reproduce a bug](using/reproducing-bugs.md)
- [Measure performance](using/performance.md)

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/uninstall.sh | bash
```
