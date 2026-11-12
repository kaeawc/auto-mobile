# Device farm

A shared device farm (an **organizer** daemon placing agent requests onto **host** daemons that dial
out to it, observed from the Desktop App) is a proposed design. None of it is implemented: every
daemon runs in the single deployment mode it has today, on a laptop, in CI, or on a remote server that
agents call directly.

The design's binding constraint is a **standalone guarantee**: a daemon with no farm role configured
opens no new listeners or outbound connections, exposes the same tools, schemas, resources and
results, loads no farm code at startup, needs no new configuration, credentials or dependencies, keeps
the agent-facing MCP endpoint (including `--host` and its per-daemon bearer token; see
[Daemon](mcp/daemon.md)), and leaves the Desktop App's behaviour against a local daemon unchanged.

## Background

- [Device farm design](../devlog/2026-11-04-device-farm-design.md): roles, session flow, tunnel,
  protocol, identity, capacity, loopback, plugins, Desktop App views, build order and risks.
