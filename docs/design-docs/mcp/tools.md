# MCP tools

AutoMobile exposes tools for these tasks:

| Area | Tools |
| --- | --- |
| Observation | `observe`, `bugReport`, `rawViewHierarchy` |
| Interaction | `tapOn`, `swipeOn`, `dragAndDrop`, `pinchOn`, `inputText`, `clearText`, `pressButton`, `pressKey` |
| Apps | `launchApp`, `terminateApp`, `installApp`, `putAppFile`, `stageSharedStorage` |
| Devices | `listDevices`, `startDevice`, `killDevice`, `setActiveDevice` |
| Plans and diagnostics | `executePlan`, `doctor`, `debugSearch`, `highlight` |

Tool availability depends on the platform, connected runner, and enabled
feature gates. Ask the client to inspect the registered tool schema for the
exact arguments and supported selectors.

For reliable workflows, observe before important actions and use semantic
selectors. See the [observation loop](interaction-loop.md) and
[tool registration](tool-registration.md).

