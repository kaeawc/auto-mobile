# MCP SDK v2 adoption survey

Which MCP SDK v2 and MCP 2026-07-28 features AutoMobile uses, and where each is described (epic
#4665). The ranked adoption proposals and the survey baseline are in the devlog entry below.

## Packages

`@modelcontextprotocol/server` and `@modelcontextprotocol/client` (`^2.4.0`) and
`@modelcontextprotocol/node` (`^2.1.1`), inlined into `dist/` at build time; see
[MCP TypeScript SDK v2 split packages](../../devlog/2026-10-17-mcp-sdk-v2-split-packages.md).

## Where adopted features live

| Feature                                                                | Page                                                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Stateless per-request servers, session key, `list_changed`             | [SDK v2 and stateless daemon layer](sdk-v2-stateless-migration.md)                                    |
| Opt-in 2026-07-28 serving (`AUTOMOBILE_MCP_MODERN_ERA`), trace context | [Opt-in modern daemon HTTP routing](sdk-v2-stateless-migration.md#opt-in-modern-daemon-http-routing)  |
| Tasks extension                                                        | [Tasks extension](sdk-v2-stateless-migration.md#tasks-extension-4668)                                 |
| Skills extension (`auto-mobile-usage`)                                 | [Skills extension](sdk-v2-stateless-migration.md#skills-extension-15430)                              |
| Elicitation (legacy push and MRTR) for an ambiguous device             | [Elicitation for an ambiguous device target](elicitation-ambiguous-device.md)                         |
| MCP Apps (`ui://automobile/observe`)                                   | [Live observe App shell](observe-app-shell.md), [Interactive observe App](observe-app-interactive.md) |

## Not used

- Sampling and Roots (deprecated in 2026-07-28).
- Logging (deprecated): `sendLoggingMessage` appears only inside the stdio proxy
  (`src/server/proxyServer.ts`).
- SSE resumability and event stores (removed from the spec).

## Background

- [MCP SDK v2 adoption survey](../../devlog/2026-10-27-sdk-v2-adoption-survey-proposals.md)
