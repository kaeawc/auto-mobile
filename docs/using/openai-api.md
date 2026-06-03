# OpenAI API

AutoMobile is an MCP server. OpenAI API callers that connect to AutoMobile through a remotely exposed MCP endpoint can use OpenAI tool search by adding `defer_loading: true` to the caller-side MCP tool declaration.

This is not an MCP server `_meta` field. The OpenAI API reads `defer_loading` from the `tools` array in the Responses API request.

## Generate a tool declaration

Use the generator to produce the JSON object for the OpenAI `tools` array:

```bash
bunx @kaeawc/auto-mobile@latest --cli openai-mcp-tool \
  --server-url https://example.com/auto-mobile/mcp \
  --defer-loading \
  --require-approval always
```

Example output:

```json
{
  "type": "mcp",
  "server_label": "auto-mobile",
  "server_description": "AutoMobile mobile device automation tools for Android and iOS.",
  "server_url": "https://example.com/auto-mobile/mcp",
  "defer_loading": true,
  "require_approval": "always"
}
```

Then include both the MCP declaration and `tool_search` in the Responses API request:

```ts
const response = await client.responses.create({
  model: "gpt-5.5",
  input: "Open the app and inspect the current screen.",
  tools: [
    {
      type: "mcp",
      server_label: "auto-mobile",
      server_description: "AutoMobile mobile device automation tools for Android and iOS.",
      server_url: "https://example.com/auto-mobile/mcp",
      defer_loading: true,
      require_approval: "always"
    },
    { type: "tool_search" }
  ],
  parallel_tool_calls: false
});
```

## Notes

- Only use `defer_loading: true` with OpenAI models and callers that support `tool_search`.
- Keep `require_approval` strict for device automation unless your caller already has a separate review layer.
- AutoMobile's normal stdio installation does not expose a public HTTP endpoint. Use this declaration only when AutoMobile is available through an OpenAI-reachable MCP endpoint.
