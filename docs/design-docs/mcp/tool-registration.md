# Tool registration

AutoMobile registers public MCP tools by their exact, case-sensitive names.
There are no tool groups: enabling one tool does not enable related tools.

Tools can be selected at startup:

```bash
auto-mobile --enable-tool clipboard --enable-tool sqlQuery
auto-mobile --disable-tool observe
```

The equivalent environment variables are
`AUTOMOBILE_ENABLED_TOOLS` and `AUTOMOBILE_DISABLED_TOOLS`, using
comma-separated exact names. Startup rejects unknown names, wrong casing, or a
tool enabled and disabled in the same layer.

The effective order is:

1. persisted per-session choice;
2. CLI startup choice;
3. environment startup choice;
4. the tool’s built-in default.

Some tools also require independent gates such as debug mode, embedded SDK mode,
or a recording/network option. A plan-only tool is never exposed as a public
MCP tool. Changes to the public tool list notify compatible clients to refresh
their discovery.

