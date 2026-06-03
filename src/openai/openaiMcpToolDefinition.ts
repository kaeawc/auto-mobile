export type OpenAIMcpRequireApproval = "always" | "never";

export interface OpenAIMcpToolDefinitionOptions {
  serverLabel?: string;
  serverDescription?: string;
  serverUrl: string;
  deferLoading?: boolean;
  requireApproval?: OpenAIMcpRequireApproval;
}

export interface OpenAIMcpToolDefinition {
  type: "mcp";
  server_label: string;
  server_description?: string;
  server_url: string;
  defer_loading?: true;
  require_approval?: OpenAIMcpRequireApproval;
}

export interface OpenAIMcpToolCliOptions {
  serverUrl?: string;
  serverLabel?: string;
  serverDescription?: string;
  deferLoading: boolean;
  requireApproval?: OpenAIMcpRequireApproval;
  help: boolean;
}

const DEFAULT_SERVER_LABEL = "auto-mobile";
const DEFAULT_SERVER_DESCRIPTION =
  "AutoMobile mobile device automation tools for Android and iOS.";

export const OPENAI_MCP_TOOL_USAGE = `Usage:
  bunx @kaeawc/auto-mobile@latest --cli openai-mcp-tool --server-url URL [options]

Options:
  --server-url URL             Streamable HTTP/SSE MCP endpoint exposed to OpenAI.
  --server-label NAME          OpenAI MCP server label (default: auto-mobile).
  --server-description TEXT    Description shown to the model.
  --defer-loading              Add defer_loading: true for tool_search callers.
  --require-approval MODE      OpenAI approval mode: always or never.
  --help                       Show this help.
`;

const normalizeNonEmpty = (value: string | undefined, fallback: string): string => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
};

const normalizeServerUrl = (value: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("OpenAI MCP server URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid OpenAI MCP server URL: ${value}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("OpenAI MCP server URL must use http or https");
  }

  return parsed.toString();
};

export const createOpenAIMcpToolDefinition = (
  options: OpenAIMcpToolDefinitionOptions
): OpenAIMcpToolDefinition => {
  const definition: OpenAIMcpToolDefinition = {
    type: "mcp",
    server_label: normalizeNonEmpty(options.serverLabel, DEFAULT_SERVER_LABEL),
    server_description: normalizeNonEmpty(
      options.serverDescription,
      DEFAULT_SERVER_DESCRIPTION
    ),
    server_url: normalizeServerUrl(options.serverUrl),
  };

  if (options.deferLoading) {
    definition.defer_loading = true;
  }

  if (options.requireApproval) {
    definition.require_approval = options.requireApproval;
  }

  return definition;
};

const readValue = (args: string[], index: number, flag: string): string => {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
};

const parseRequireApproval = (value: string): OpenAIMcpRequireApproval => {
  if (value === "always" || value === "never") {
    return value;
  }
  throw new Error("--require-approval must be 'always' or 'never'");
};

export const parseOpenAIMcpToolCliArgs = (args: string[]): OpenAIMcpToolCliOptions => {
  const options: OpenAIMcpToolCliOptions = {
    deferLoading: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--server-url":
        options.serverUrl = readValue(args, i, arg);
        i++;
        break;
      case "--server-label":
        options.serverLabel = readValue(args, i, arg);
        i++;
        break;
      case "--server-description":
        options.serverDescription = readValue(args, i, arg);
        i++;
        break;
      case "--defer-loading":
        options.deferLoading = true;
        break;
      case "--require-approval":
        options.requireApproval = parseRequireApproval(readValue(args, i, arg));
        i++;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
};
