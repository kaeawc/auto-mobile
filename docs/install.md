# Install AutoMobile

## Recommended: interactive installer

Run the installer in a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/install.sh | bash
```

It checks the host, offers to install required Android or iOS developer tools,
and configures detected MCP clients. Run it from your app's Git repository to
configure that project; run it elsewhere for a global configuration.

When the installer finishes, restart the MCP client if it was already running.

![Install Demo](img/install.gif)

## Manual MCP configuration

If the installer does not detect your client, add an MCP server whose command
is `bunx` and whose argument is `@kaeawc/auto-mobile@latest`:

```json
{
  "command": "bunx",
  "args": ["@kaeawc/auto-mobile@latest"]
}
```

Place this server in the client’s MCP configuration using its documented
configuration format, then restart the client.

## First use

Make an emulator/simulator or physical device available, then ask the agent to
perform a task such as:

> Explore the main flow in my Android app and report any confusing steps.

For direct checks, use `auto-mobile --cli help` and
`auto-mobile --cli listDevices`. If you did not install the CLI, use
`bunx @kaeawc/auto-mobile@latest --cli help` instead.

## Uninstall

The interactive uninstaller removes selected AutoMobile components:

```bash
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/uninstall.sh | bash
```
