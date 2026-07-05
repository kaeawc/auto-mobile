declare module "@modelcontextprotocol/sdk/server/index.js" {
  export interface Transport {
    start: () => Promise<void>;
    send: (message: any) => Promise<void>;
    close: () => Promise<void>;
    onMessage?: (callback: (message: any) => void) => void;
    onClose?: (callback: () => void) => void;
  }

  export class Server {
  	constructor(
      info: { name: string; version: string },
      config: { capabilities: { tools: Record<string, any> } }
    );

  	setRequestHandler(schema: any, handler: (request: any) => Promise<any>): void;
  	connect(transport: Transport): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/server/stdio.js" {
  import { Transport } from "@modelcontextprotocol/sdk/server/index.js";

  export class StdioServerTransport implements Transport {
  	constructor();
  	start(): Promise<void>;
  	send(message: any): Promise<void>;
  	close(): Promise<void>;
  	onMessage(callback: (message: any) => void): void;
  	onClose(callback: () => void): void;
  }
}

declare module "@modelcontextprotocol/sdk/types.js" {
  export interface Resource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
  }

  export interface ResourceTemplate {
    uriTemplate: string;
    name: string;
    description?: string;
    mimeType?: string;
  }

  export const CallToolRequestSchema: any;
  export const ListToolsRequestSchema: any;
  export const GetResourceRequestSchema: any;
  export const ListResourcesRequestSchema: any;
  export const ReadResourceRequestSchema: any;
  export const ListResourceTemplatesRequestSchema: any;
  export const SubscribeRequestSchema: any;
  export const UnsubscribeRequestSchema: any;
}

declare module "@modelcontextprotocol/sdk/types" {
  export const CallToolRequestSchema: any;
  export const ListToolsRequestSchema: any;
  export const GetResourceRequestSchema: any;
  export const ListResourcesRequestSchema: any;
  export interface CallToolResult {
    content: Array<{
      type: string;
      text: string;
    }>;
  }
}

declare module "zod" {
  export interface ZodIssue {
    code: string;
    path: Array<string | number>;
    message: string;
    expected?: string;
    received?: string;
    errors?: ZodIssue[][];
  }

  export class ZodError extends Error {
    issues: ZodIssue[];
  }

  export interface ZodSchema {
    optional: () => ZodSchema;
    describe: (description: string) => ZodSchema;
    default: (value: any) => ZodSchema;
    min: (value: number) => ZodSchema;
    max: (value: number) => ZodSchema;
  }

  export function toJSONSchema(schema: ZodSchema): Record<string, unknown>;

  export const z: {
    object: (schema: Record<string, any>) => ZodSchema;
    string: () => ZodSchema;
    number: () => ZodSchema;
    boolean: () => ZodSchema;
    enum: (values: string[]) => ZodSchema;
    array: (schema: ZodSchema) => ZodSchema;
    record: (schema: ZodSchema) => ZodSchema;
    union: (schemas: ZodSchema[]) => ZodSchema;
    any: () => ZodSchema;
  };
}
