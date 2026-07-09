import { describe, expect, test } from "bun:test";
import { ESLint } from "eslint";

async function lintSnippet(code: string): Promise<string[]> {
  const eslint = new ESLint({
    cwd: process.cwd(),
    overrideConfigFile: "eslint.config.mjs",
    fix: false,
  });
  const [result] = await eslint.lintText(code, {
    filePath: "src/errorHandlingConventionFixture.ts",
  });
  return result.messages.map(message => message.message);
}

describe("error-handling convention lint backstop", () => {
  test("rejects empty catch bodies", async () => {
    const messages = await lintSnippet(`
export function cleanup(): void {
  try {
    throw new Error("boom");
  } catch {
  }
}
`);

    expect(messages).toContain("Empty block statement.");
  });

  test("rejects return-only catch bodies without logging", async () => {
    const messages = await lintSnippet(`
export function parse(): string | null {
  try {
    return "ok";
  } catch {
    return null;
  }
}
`);

    expect(messages).toContain("Catch blocks that return a fallback must log the caught error before returning.");
  });

  test("rejects bare and undefined return-only catch bodies without logging", async () => {
    const messages = await lintSnippet(`
export function ignore(): void {
  try {
    throw new Error("boom");
  } catch {
    return;
  }
}

export function maybe(): string | undefined {
  try {
    return "ok";
  } catch {
    return undefined;
  }
}
`);

    expect(messages.filter(message => message === "Catch blocks that return a fallback must log the caught error before returning.")).toHaveLength(2);
  });

  test("rejects unlogged status-object returns", async () => {
    const messages = await lintSnippet(`
export function check(): { status: "pass" | "skip"; message?: string } {
  try {
    return { status: "pass" };
  } catch {
    return { status: "skip", message: "Could not check" };
  }
}
`);

    expect(messages).toContain("Catch blocks that return a typed failure/status object must log at warn, not debug.");
  });

  test("rejects debug logging before returning a typed status failure", async () => {
    const messages = await lintSnippet(`
import { logger } from "../utils/logger";

export function check(): { status: "pass" | "skip"; message?: string } {
  try {
    return { status: "pass" };
  } catch (error) {
    logger.debug(\`check failed: \${error}\`);
    return { status: "skip", message: "Could not check" };
  }
}
`);

    expect(messages).toContain("Catch blocks that return a typed failure/status object must log at warn, not debug.");
  });

  test("rejects injected debug loggers before returning a typed status failure", async () => {
    const messages = await lintSnippet(`
interface Dependencies {
  logger: {
    debug(message: string): void;
    warn(message: string): void;
  };
}

export function check(dependencies: Dependencies): { status: "pass" | "skip"; message?: string } {
  try {
    return { status: "pass" };
  } catch (error) {
    dependencies.logger.debug(\`check failed: \${error}\`);
    return { status: "skip", message: "Could not check" };
  }
}
`);

    expect(messages).toContain("Catch blocks that return a typed failure/status object must log at warn, not debug.");
  });

  test("allows logged fallback returns and warn-logged typed failures", async () => {
    const messages = await lintSnippet(`
import { logger } from "../utils/logger";

export function parse(): string | null {
  try {
    return "ok";
  } catch (error) {
    logger.debug(\`parse failed: \${error}\`);
    return null;
  }
}

export function check(): { status: "pass" | "skip"; message?: string } {
  try {
    return { status: "pass" };
  } catch (error) {
    logger.warn(\`check failed: \${error}\`, error);
    return { status: "skip", message: "Could not check" };
  }
}
`);

    expect(messages).not.toContain("Catch blocks that return a fallback must log the caught error before returning.");
    expect(messages).not.toContain("Catch blocks that return a typed failure/status object must log at warn, not debug.");
  });
});
