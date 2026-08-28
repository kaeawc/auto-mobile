# Daemon

The AutoMobile daemon is a local background service that keeps a pool of
devices ready for work. It assigns a device to each session, proxies the same
MCP tools and resources, and returns the device to the pool when work ends.

```mermaid
%%{init: {"flowchart": {"defaultRenderer": "elk"}, "elk": {"keepEntryNodeOnTop": true}} }%%
flowchart LR
  Daemon[🤖 MCP daemon] -->|assign a device| Sessions[📱 Device session manager]
  Sessions -->|start work| Loop
  subgraph Loop[🔄 Interaction loop]
    direction TB
    Device1[📱 Device 1]
    Device2[📱 Device 2]
    More[📱 Device …]
    DeviceN[📱 Device N]
  end
  Loop -->|collect results| Results[🖼️ Processed results]
  Results -->|return to the daemon| Daemon
```

This enables parallel test runs and coordinated multi-device actions without
each client needing to manage device processes itself. It can run as a
standalone service, within the MCP server, or temporarily in CI.
