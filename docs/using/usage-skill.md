# Usage skill

AutoMobile publishes one usage skill, `auto-mobile-usage`, through the
[Skills over MCP](https://modelcontextprotocol.io/extensions/skills/overview)
extension. It tells an agent how to drive devices: acquire a session first,
observe before acting, read resources instead of calling tools for state, run
long operations as tasks, and handle the typed errors `capacity_exhausted`,
`device_service_disabled` and `device_owned_by_other_session`.

A host loads it on demand, so it adds nothing to `tools/list`, `resources/list`
or the default context. The server declares the `io.modelcontextprotocol/skills`
extension at `initialize`; whether the skill is used depends on the host, and
few hosts consume Skills over MCP yet.

| Call                      | Result                                             |
| ------------------------- | -------------------------------------------------- |
| Skills list request       | One entry: `skill://auto-mobile-usage/SKILL.md`.   |
| Skills get request        | The entry for that URI, with file digest.          |
| Resource read on that URI | The skill text, served without a device or daemon. |

A request for an unknown skill URI is refused. The same text
works over the stdio proxy, the daemon HTTP endpoint and the direct server.
