# System design

AutoMobile connects an MCP-compatible AI client to Android and iOS devices.

```mermaid
flowchart LR
  Client["AI client"] --> MCP["AutoMobile MCP server"]
  MCP --> Tools["Tools and resources"]
  Tools --> Android["Android device"]
  Tools --> iOS["iOS simulator or device"]
```

The client asks for an outcome. AutoMobile selects a device, observes its current
state, performs an action, and returns the new state. Device-specific runners
handle platform details so the client can use the same interaction model across
Android and iOS.

The main user-facing capabilities are:

- observe screens and accessibility information;
- tap, swipe, type, press buttons, and perform gestures;
- launch, install, and terminate apps;
- select and manage devices;
- execute repeatable plans and collect diagnostics.

Start with [installation](../install.md) or the [tool list](mcp/tools.md).

