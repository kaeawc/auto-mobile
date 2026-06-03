#!/usr/bin/env bun
import {
  createOpenAIMcpToolDefinition,
  OPENAI_MCP_TOOL_USAGE,
  parseOpenAIMcpToolCliArgs,
} from "../../src/openai";

const main = () => {
  const options = parseOpenAIMcpToolCliArgs(Bun.argv.slice(2));
  if (options.help) {
    process.stdout.write(OPENAI_MCP_TOOL_USAGE);
    return;
  }

  if (!options.serverUrl) {
    throw new Error("--server-url is required");
  }

  const definition = createOpenAIMcpToolDefinition({
    serverUrl: options.serverUrl,
    serverLabel: options.serverLabel,
    serverDescription: options.serverDescription,
    deferLoading: options.deferLoading,
    requireApproval: options.requireApproval,
  });

  process.stdout.write(`${JSON.stringify(definition, null, 2)}\n`);
};

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n\n${OPENAI_MCP_TOOL_USAGE}`);
    process.exit(1);
  }
}
