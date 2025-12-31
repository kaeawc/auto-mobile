import fs from "fs/promises";
import path from "path";
import { ensureDirExists } from "./io";

/**
 * Utility for writing debug information to files in the scratch/debug directory
 */

const DEBUG_DIR = path.join(process.cwd(), "scratch", "debug");

/**
 * Ensures the debug directory exists
 */
async function ensureDebugDir(): Promise<void> {
  await ensureDirExists(DEBUG_DIR);
}

/**
 * Formats a timestamp for display in debug files
 */
function formatTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/T/, " ").replace(/\..+/, "");
}

/**
 * Formats a timestamp for use in filenames (no spaces or colons)
 */
function formatFilenameTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").replace(/T/, "_");
}

/**
 * Creates a section header in the debug file
 */
function createSection(title: string, content?: string): string {
  const separator = "=".repeat(80);
  const parts = [
    separator,
    `[${formatTimestamp()}] ${title}`,
    separator
  ];

  if (content) {
    parts.push(content);
    parts.push(""); // Empty line after content
  }

  return parts.join("\n");
}

/**
 * Creates a subsection header in the debug file
 */
function createSubsection(title: string, content?: string): string {
  const separator = "-".repeat(80);
  const parts = [
    separator,
    `${title}`,
    separator
  ];

  if (content) {
    parts.push(content);
    parts.push(""); // Empty line after content
  }

  return parts.join("\n");
}

/**
 * Interface for debug file writer options
 */
export interface DebugFileWriterOptions {
  /** Prefix for the debug file name */
  prefix: string;
  /** Whether to append to existing file or create new one */
  append?: boolean;
}

/**
 * Debug file writer class
 * Provides methods to write structured debug information to files
 */
export class DebugFileWriter {
  private filePath: string;
  private buffer: string[] = [];

  constructor(private options: DebugFileWriterOptions) {
    const timestamp = formatFilenameTimestamp();
    const filename = `${options.prefix}-${timestamp}.log`;
    this.filePath = path.join(DEBUG_DIR, filename);
  }

  /**
   * Gets the absolute path to the debug file
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Adds a section to the debug output
   */
  addSection(title: string, content?: string): this {
    this.buffer.push(createSection(title, content));
    return this;
  }

  /**
   * Adds a subsection to the debug output
   */
  addSubsection(title: string, content?: string): this {
    this.buffer.push(createSubsection(title, content));
    return this;
  }

  /**
   * Adds a timestamped entry to the debug output
   */
  addEntry(message: string): this {
    this.buffer.push(`[${formatTimestamp()}] ${message}`);
    this.buffer.push(""); // Empty line after entry
    return this;
  }

  /**
   * Adds raw content to the debug output
   */
  addContent(content: string): this {
    this.buffer.push(content);
    this.buffer.push(""); // Empty line after content
    return this;
  }

  /**
   * Adds a key-value pair to the debug output
   */
  addKeyValue(key: string, value: any): this {
    const valueStr = typeof value === "object"
      ? JSON.stringify(value, null, 2)
      : String(value);

    this.buffer.push(`${key}: ${valueStr}`);
    return this;
  }

  /**
   * Adds multiple key-value pairs to the debug output
   */
  addKeyValues(kvPairs: Record<string, any>): this {
    for (const [key, value] of Object.entries(kvPairs)) {
      this.addKeyValue(key, value);
    }
    this.buffer.push(""); // Empty line after all pairs
    return this;
  }

  /**
   * Adds timing information to the debug output
   */
  addTiming(label: string, durationMs: number): this {
    this.buffer.push(`${label}: ${durationMs}ms`);
    return this;
  }

  /**
   * Adds an error to the debug output
   */
  addError(error: Error | string): this {
    const errorStr = error instanceof Error
      ? `${error.message}\n${error.stack || ""}`
      : String(error);

    this.buffer.push(createSubsection("ERROR", errorStr));
    return this;
  }

  /**
   * Writes the buffered content to the debug file
   */
  async write(): Promise<void> {
    await ensureDebugDir();

    const content = this.buffer.join("\n");

    if (this.options.append) {
      await fs.appendFile(this.filePath, "\n" + content);
    } else {
      await fs.writeFile(this.filePath, content);
    }
  }

  /**
   * Clears the buffer without writing
   */
  clear(): this {
    this.buffer = [];
    return this;
  }
}

/**
 * Creates a new debug file writer
 */
export function createDebugFileWriter(options: DebugFileWriterOptions): DebugFileWriter {
  return new DebugFileWriter(options);
}
