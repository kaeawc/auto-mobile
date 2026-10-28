import { describe, expect, test } from "bun:test";
import { parseSuiteDefinition } from "../../../scripts/agent-benchmark/config";
import {
  awsConfigIdentity,
  buildClaudeArgs,
  buildMcpConfig,
  claudeLaunchEnv,
  fillPlaceholders,
  googleCredentialsIdentity,
  isolatedServerEnv,
  managedSettingsIdentity,
  mcpServerEnv,
  providerIdentity,
  systemPromptFor,
  isRunShapingClaudeVariable,
} from "../../../scripts/agent-benchmark/invocation";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const pathDigest = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 12);

const PATHS = {
  runtime: "/usr/bin/bun",
  serverEntry: "/repo/dist/src/index.js",
  auxSocketDir: "/tmp/amb-abc",
  dataDir: "/run/data",
  dbDir: "/run/db",
  logDir: "/run/logs",
};
const VALUES = { deviceSerial: "emulator-5554", packageName: "dev.example", runDirectory: "/run" };

function suite(claude: Record<string, unknown> = {}) {
  return parseSuiteDefinition(
    {
      name: "demo",
      platform: "android",
      prompt: "p.txt",
      app: { packageName: "dev.example" },
      verify: { answerIncludes: ["DONE"], screenIncludes: ["Done"] },
      claude,
    },
    "demo.yml",
  );
}

describe("agent benchmark claude invocation", () => {
  test("isolates MCP config, streams JSON, and never carries the prompt in argv", () => {
    const args = buildClaudeArgs(suite(), "/run/mcp-config.json", "SYSTEM");
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--mcp-config",
      "/run/mcp-config.json",
      "--strict-mcp-config",
      "--setting-sources",
      "project,local",
      "--append-system-prompt",
      "SYSTEM",
      "--allowedTools",
      "mcp__auto-mobile",
      "--disallowedTools",
      "Bash",
      "PowerShell",
    ]);
  });

  test("the CLI model override wins over the suite model", () => {
    const configured = suite({ model: "suite-model", maxBudgetUsd: 1.5 });
    const args = buildClaudeArgs(configured, "/c.json", "S", "cli-model");
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "cli-model",
    ]);
    expect(args).toContain("1.5");
    expect(buildClaudeArgs(configured, "/c.json", "S")).toContain("suite-model");
  });

  test("an empty allow list drops its flag; Bash and PowerShell are always denied", () => {
    const args = buildClaudeArgs(suite({ allowedTools: [], disallowedTools: [] }), "/c.json", "S");
    expect(args).not.toContain("--allowedTools");
    expect(args.slice(args.indexOf("--disallowedTools"))).toEqual([
      "--disallowedTools",
      "Bash",
      "PowerShell",
    ]);
    const extra = buildClaudeArgs(
      suite({ disallowedTools: ["mcp__auto-mobile__openLink"] }),
      "/c.json",
      "S",
    );
    expect(extra.slice(extra.indexOf("--disallowedTools"))).toEqual([
      "--disallowedTools",
      "Bash",
      "PowerShell",
      "mcp__auto-mobile__openLink",
    ]);
  });

  test("the system prompt pins the device and appends filled suite text", () => {
    expect(systemPromptFor(suite(), VALUES)).toBe(
      "Use only the Android device with serial emulator-5554. The app under test is dev.example. " +
        "Interact with the device only through the auto-mobile MCP tools.",
    );
    const extra = systemPromptFor(
      suite({ appendSystemPrompt: "Device {deviceSerial} in {runDirectory}." }),
      VALUES,
    );
    expect(extra.endsWith("\n\nDevice emulator-5554 in /run.")).toBe(true);
    expect(fillPlaceholders("{packageName} {packageName}", VALUES)).toBe("dev.example dev.example");
  });

  test("the MCP server env carries only shared claim roots from the inherited env", () => {
    const config = buildMcpConfig(
      PATHS,
      {
        PATH: "/bin",
        AUTOMOBILE_ADB_SERVER_COORDINATION_DIR: "/shared/claims",
        AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR: "/shared/legacy",
        AUTOMOBILE_DB_PATH: "/resident.db",
        ADB_SERVER_SOCKET: "tcp:remote:5037",
        ANDROID_ADB_SERVER_ADDRESS: "remote",
        ANDROID_ADB_SERVER_PORT: "5038",
        ANDROID_HOME: "/sdk",
      },
      // POSIX, so the absolute paths stay as written on a Windows runner too.
      "linux",
    ) as { mcpServers: Record<string, { env: Record<string, string> }> };
    const env = config.mcpServers["auto-mobile"].env;
    expect(env.AUTOMOBILE_ADB_SERVER_COORDINATION_DIR).toBe("/shared/claims");
    expect(env.AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR).toBe("/shared/legacy");
    expect(env.ADB_SERVER_SOCKET).toBe("tcp:remote:5037");
    expect(env.ANDROID_ADB_SERVER_ADDRESS).toBe("remote");
    expect(env.ANDROID_ADB_SERVER_PORT).toBe("5038");
    expect(env.ANDROID_HOME).toBe("/sdk");
    expect(env.PATH).toBeUndefined();
    expect(env.AUTOMOBILE_DB_PATH).toBeUndefined();
    expect(env.AUTOMOBILE_DB_DIR).toBe("/run/db");
    expect(env.AUTOMOBILE_DATA_DIR).toBe("/run/data");
  });

  test("an inherited instructions switch is stripped; only the harness flag sets it", () => {
    const inherited = { AUTOMOBILE_SERVER_INSTRUCTIONS: "1" };
    expect(
      mcpServerEnv(inherited, PATHS, "linux", "/work").AUTOMOBILE_SERVER_INSTRUCTIONS,
    ).toBeUndefined();
    expect(
      mcpServerEnv({}, PATHS, "linux", "/work", { instructions: true })
        .AUTOMOBILE_SERVER_INSTRUCTIONS,
    ).toBe("1");
  });

  test("the MCP server runs against a private daemon with fresh state", () => {
    expect(buildMcpConfig(PATHS)).toEqual({
      mcpServers: {
        "auto-mobile": {
          type: "stdio",
          command: "/usr/bin/bun",
          args: ["/repo/dist/src/index.js"],
          env: {
            AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/amb-abc",
            AUTOMOBILE_HARNESS_PRIVATE_DAEMON: "1",
            AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS: "5000",
            AUTOMOBILE_DATA_DIR: "/run/data",
            AUTOMOBILE_DB_DIR: "/run/db",
            AUTOMOBILE_LOG_DIR: "/run/logs",
          },
        },
      },
    });
  });
});

describe("agent benchmark isolated server environment", () => {
  test("strips every inherited AutoMobile variable but keeps shared device claims", () => {
    const env = isolatedServerEnv(
      {
        PATH: "/bin",
        HOME: "/home/me",
        UNSET: undefined,
        // Inherited from a bun test parent, it would arm the server's test-only guards.
        NODE_ENV: "test",
        AUTOMOBILE_DB_PATH: "/resident.db",
        AUTO_MOBILE_DB_PATH: "/legacy.db",
        AUTOMOBILE_DATA_DIR: "/resident-data",
        AUTOMOBILE_DAEMON_SOCKET_PATH: "/tmp/resident.sock",
        AUTOMOBILE_DAEMON_LOCK_FILE_PATH: "/tmp/resident.lock",
        AUTOMOBILE_DISABLED_TOOLS: "observe",
        AUTOMOBILE_ENABLED_TOOLS: "tapOn",
        AUTO_MOBILE_TOOLSET: "legacy",
        AUTOMOBILE_ADB_SERVER_COORDINATION_DIR: "/shared/claims",
      },
      PATHS,
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/me",
      AUTOMOBILE_ADB_SERVER_COORDINATION_DIR: "/shared/claims",
      AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/amb-abc",
      AUTOMOBILE_HARNESS_PRIVATE_DAEMON: "1",
      AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS: "5000",
      AUTOMOBILE_DATA_DIR: "/run/data",
      AUTOMOBILE_DB_DIR: "/run/db",
      AUTOMOBILE_LOG_DIR: "/run/logs",
    });
  });
});

describe("agent benchmark managed settings", () => {
  test("digests each managed settings file, which --setting-sources cannot exclude", () => {
    const files: Record<string, string> = {
      "/etc/claude-code/managed-settings.json": '{"env":{"A":"1"}}',
      "/etc/claude-code/managed-settings.d/10-hooks.json": '{"hooks":{}}',
    };
    const list = (dir: string) =>
      dir === "/etc/claude-code"
        ? ["managed-settings.json", "managed-settings.d/10-hooks.json"]
        : [];
    const identity = managedSettingsIdentity("linux", list, (path) => files[path] ?? "");
    expect(identity).toBe(
      [
        `/etc/claude-code/managed-settings.d/10-hooks.json=sha256:${pathDigest('{"hooks":{}}')}`,
        `/etc/claude-code/managed-settings.json=sha256:${pathDigest('{"env":{"A":"1"}}')}`,
      ].join("\n"),
    );
    // An unmanaged host records nothing.
    expect(
      managedSettingsIdentity(
        "linux",
        () => [],
        () => "",
      ),
    ).toBe("");
  });
});

describe("agent benchmark launch paths", () => {
  test("relative PATH entries and credentials paths are made absolute for the temp cwd", () => {
    const posix = claudeLaunchEnv(
      { PATH: "./bin::/usr/bin", GOOGLE_APPLICATION_CREDENTIALS: "creds.json" },
      PATHS,
      "linux",
      "/work",
    );
    // An empty POSIX entry means the current directory, so it becomes /work too.
    expect(posix.PATH).toBe("/work/bin:/work:/usr/bin");
    expect(posix.GOOGLE_APPLICATION_CREDENTIALS).toBe("/work/creds.json");
    // The AWS credential chain's file paths resolve the same way.
    const aws = claudeLaunchEnv(
      {
        AWS_CONFIG_FILE: "aws/config",
        AWS_SHARED_CREDENTIALS_FILE: "/abs/credentials",
        AWS_WEB_IDENTITY_TOKEN_FILE: "token",
      },
      PATHS,
      "linux",
      "/work",
    );
    expect([
      aws.AWS_CONFIG_FILE,
      aws.AWS_SHARED_CREDENTIALS_FILE,
      aws.AWS_WEB_IDENTITY_TOKEN_FILE,
    ]).toEqual(["/work/aws/config", "/abs/credentials", "/work/token"]);
    // So do the Android SDK roots and the shared claim root, in Claude's env and the server's.
    const inherited = {
      ANDROID_HOME: "sdk",
      ANDROID_SDK_ROOT: "/abs/sdk",
      AUTOMOBILE_ADB_SERVER_COORDINATION_DIR: "claims",
    };
    const launch = claudeLaunchEnv(inherited, PATHS, "linux", "/work");
    // Claude's config directory and mTLS files resolve from the invocation directory too.
    const claudePaths = claudeLaunchEnv(
      {
        CLAUDE_CONFIG_DIR: "cfg",
        CLAUDE_CODE_CLIENT_CERT: "tls/c.pem",
        CLAUDE_CODE_CLIENT_KEY: "tls/k.pem",
      },
      PATHS,
      "linux",
      "/work",
    );
    expect([
      claudePaths.CLAUDE_CONFIG_DIR,
      claudePaths.CLAUDE_CODE_CLIENT_CERT,
      claudePaths.CLAUDE_CODE_CLIENT_KEY,
    ]).toEqual(["/work/cfg", "/work/tls/c.pem", "/work/tls/k.pem"]);
    const server = mcpServerEnv(inherited, PATHS, "linux", "/work");
    for (const env of [launch, server]) {
      expect(env.ANDROID_HOME).toBe("/work/sdk");
      expect(env.ANDROID_SDK_ROOT).toBe("/abs/sdk");
      expect(env.AUTOMOBILE_ADB_SERVER_COORDINATION_DIR).toBe("/work/claims");
    }
    const windows = claudeLaunchEnv({ Path: "bin;C:\\tools" }, PATHS, "win32", "C:\\work");
    expect(windows.Path).toBe("C:\\work\\bin;C:\\tools");
  });

  test("an AWS provider fingerprints the AWS config file the credential chain reads", () => {
    const files: Record<string, string> = {
      "/home/u/.aws/config": "[profile dev]\nrole_arn = arn:aws:iam::111:role/a\n",
      "/work/aws-config": "[profile dev]\nrole_arn = arn:aws:iam::222:role/a\n",
    };
    const read = (path: string) => {
      const content = files[path.replaceAll("\\", "/")];
      if (content === undefined) {
        throw new Error("ENOENT");
      }
      return content;
    };
    const identity = (env: Record<string, string>) =>
      providerIdentity(env, undefined, "linux", (path) => awsConfigIdentity(path, read), "/home/u");
    const bedrock = { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "dev" };
    const home = identity(bedrock);
    expect(home).toMatch(/^aws-config=sha256:[0-9a-f]{12}$/m);
    // Same profile name, different file: a different identity.
    expect(identity({ ...bedrock, AWS_CONFIG_FILE: "/work/aws-config" })).not.toBe(home);
    expect(identity({ ...bedrock, AWS_CONFIG_FILE: "/missing" })).toContain(
      "aws-config=unreadable",
    );
    // Other providers never read it.
    expect(identity({ CLAUDE_CODE_USE_VERTEX: "1" })).not.toContain("aws-config");
  });

  test("Windows provider keys count in any case", () => {
    expect(
      providerIdentity({ anthropic_bedrock_base_url: "https://br.example" }, undefined, "win32"),
    ).toBe("ANTHROPIC_BEDROCK_BASE_URL=https://br.example");
  });
});

describe("agent benchmark Windows environment casing", () => {
  test("classifies keys case-insensitively on Windows, exactly elsewhere", () => {
    const inherited = { Path: "C:\\bin", node_env: "test", claude_code_max_turns: "1" };
    const windows = claudeLaunchEnv(inherited, PATHS, "win32");
    expect(windows.node_env).toBeUndefined();
    expect(windows.claude_code_max_turns).toBeUndefined();
    expect(windows.Path).toBe("C:\\bin");
    // On POSIX these lowercase names are distinct variables the children never read as the
    // canonical ones, so they pass through untouched.
    expect(claudeLaunchEnv(inherited, PATHS, "linux").node_env).toBe("test");
  });
});

// The real reader would digest this machine's ~/.aws/config.
const STUB_AWS_CONFIG = () => "sha256:stub";

describe("agent benchmark provider identity", () => {
  test("records provider, base URL host, region, and routing without secrets", () => {
    const identity = providerIdentity(
      {
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_BASE_URL: "https://user:secret@proxy.example.com/v1?key=abc",
        AWS_REGION: "us-west-2",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "routed-sonnet",
        ANTHROPIC_API_KEY: "sk-secret",
        AWS_SECRET_ACCESS_KEY: "secret",
      },
      undefined,
      "linux",
      STUB_AWS_CONFIG,
    );
    expect(identity).toBe(
      [
        // The userinfo is digested, never echoed.
        `ANTHROPIC_BASE_URL=https://sha256:${pathDigest("user:secret")}@proxy.example.com/sha256:${pathDigest("/v1")}`,
        "ANTHROPIC_DEFAULT_SONNET_MODEL=routed-sonnet",
        "AWS_REGION=us-west-2",
        "CLAUDE_CODE_USE_BEDROCK=1",
        // The API key is recorded by name, never by value or digest.
        "auth=ANTHROPIC_API_KEY",
        "aws-config=sha256:stub",
      ].join("\n"),
    );
    expect(identity).not.toContain("secret");
    expect(providerIdentity({})).toBe("");
    // The Vertex project selects quota and capacity; it is digested, never echoed.
    const vertex = providerIdentity({
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "my-project",
    });
    expect(vertex).toContain(`ANTHROPIC_VERTEX_PROJECT_ID=sha256:${pathDigest("my-project")}`);
    expect(vertex).not.toContain("my-project");
    // The credentials file's project overrides the explicit project variables; only its
    // identity fields count, never the key, and the path itself does not.
    const files: Record<string, string> = {
      "/a.json": JSON.stringify({ type: "service_account", project_id: "p1", private_key: "K1" }),
      "/b.json": JSON.stringify({ type: "service_account", project_id: "p1", private_key: "K2" }),
      "/c.json": JSON.stringify({ type: "service_account", project_id: "p2", private_key: "K1" }),
    };
    const read = (path: string) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error("ENOENT");
      }
      return content;
    };
    const id = (path: string) => googleCredentialsIdentity(path, read);
    expect(id("/a.json")).toBe(id("/b.json"));
    expect(id("/a.json")).not.toBe(id("/c.json"));
    expect(id("/missing.json")).toBe("unreadable:file");
    // The impersonated service account is part of an external_account file's identity.
    const external = (url: string) =>
      googleCredentialsIdentity("/x.json", () =>
        JSON.stringify({
          type: "external_account",
          audience: "aud",
          service_account_impersonation_url: url,
        }),
      );
    expect(external("https://iam/sa-a")).not.toBe(external("https://iam/sa-b"));
    expect(
      providerIdentity(
        { CLAUDE_CODE_USE_VERTEX: "1", GOOGLE_APPLICATION_CREDENTIALS: "/a.json" },
        id,
      ),
    ).toContain(`GOOGLE_APPLICATION_CREDENTIALS=${id("/a.json")}`);
    // The assumed role's ARN names the target account.
    expect(providerIdentity({ AWS_ROLE_ARN: "arn:aws:iam::123:role/r" })).toBe(
      `AWS_ROLE_ARN=sha256:${pathDigest("arn:aws:iam::123:role/r")}`,
    );
    // The AWS SDK's endpoint overrides route Bedrock too, and a toggle turns them off.
    expect(
      providerIdentity({
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://vpce-1.bedrock.example",
        AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
      }),
    ).toBe(
      [
        "AWS_ENDPOINT_URL_BEDROCK_RUNTIME=https://vpce-1.bedrock.example",
        "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true",
      ].join("\n"),
    );
    // Custom request headers can carry tenant or routing values: digested, never echoed.
    expect(providerIdentity({ ANTHROPIC_CUSTOM_HEADERS: "X-Tenant: a" })).toBe(
      `ANTHROPIC_CUSTOM_HEADERS=sha256:${pathDigest("X-Tenant: a")}`,
    );
    // Proxy credentials pick a tenant: digested, so two tenants on one proxy differ.
    const tenantA = providerIdentity({ HTTPS_PROXY: "http://tenant-a:key-a@proxy.example:8080" });
    expect(tenantA).toBe(
      `HTTPS_PROXY=http://sha256:${pathDigest("tenant-a:key-a")}@proxy.example:8080`,
    );
    expect(tenantA).not.toContain("key-a");
    expect(providerIdentity({ HTTPS_PROXY: "http://tenant-b:key-b@proxy.example:8080" })).not.toBe(
      tenantA,
    );
    // The Anthropic-on-AWS workspace selects the account's quota.
    expect(providerIdentity({ ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_1" })).toBe(
      `ANTHROPIC_AWS_WORKSPACE_ID=sha256:${pathDigest("wrkspc_1")}`,
    );
    expect(providerIdentity({ ANTHROPIC_WORKSPACE_ID: "wrkspc_2" })).toBe(
      `ANTHROPIC_WORKSPACE_ID=sha256:${pathDigest("wrkspc_2")}`,
    );
    // Environment credentials pick the AWS principal; only the key ID is recorded, digested.
    const keyed = providerIdentity({
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(keyed).toBe(`AWS_ACCESS_KEY_ID=sha256:${pathDigest("AKIAEXAMPLE")}`);
    // The AWS profile picks Bedrock's account through the credential chain.
    expect(
      providerIdentity(
        { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "team-a" },
        undefined,
        "linux",
        STUB_AWS_CONFIG,
      ),
    ).toContain(`AWS_PROFILE=sha256:${pathDigest("team-a")}`);
    // Every Claude/API/MCP/Bash timeout or watchdog override is run-shaping.
    for (const key of [
      "API_TIMEOUT_MS",
      "API_FORCE_IDLE_TIMEOUT",
      "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS",
      "CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS",
      "CLAUDE_CODE_GLOB_TIMEOUT_SECONDS",
      // The toggles that turn those deadlines on or off.
      "CLAUDE_ENABLE_STREAM_WATCHDOG",
      "CLAUDE_ENABLE_BYTE_WATCHDOG",
      "CLAUDE_ENABLE_BYTE_WATCHDOG_BEDROCK",
      "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK",
      // The AWS SDK's retry policy.
      "AWS_RETRY_MODE",
      "AWS_MAX_ATTEMPTS",
    ]) {
      expect({ key, scrubbed: isRunShapingClaudeVariable(key) }).toEqual({ key, scrubbed: true });
    }
    expect(isRunShapingClaudeVariable("ANTHROPIC_API_KEY")).toBe(false);
    expect(isRunShapingClaudeVariable("CLAUDE_CODE_ATTRIBUTION_HEADER")).toBe(true);
    expect(isRunShapingClaudeVariable("CLAUDE_AUTO_BACKGROUND_TASKS")).toBe(true);
    expect(isRunShapingClaudeVariable("CLAUDE_CODE_EXTRA_BODY")).toBe(true);
    // The allowlist toggle would hide PATH (and the fingerprinted adb) from the server.
    expect(isRunShapingClaudeVariable("CLAUDE_CODE_MCP_ALLOWLIST_ENV")).toBe(true);
    // This opt-in keeps PowerShell enabled alongside a Bash deny.
    expect(isRunShapingClaudeVariable("CLAUDE_CODE_USE_POWERSHELL_TOOL")).toBe(true);
    // It wraps the measured stdio MCP server's startup command.
    expect(isRunShapingClaudeVariable("CLAUDE_CODE_SHELL_PREFIX")).toBe(true);
    const launch = claudeLaunchEnv(
      { PATH: "/bin", CLAUDE_CODE_SHELL_PREFIX: "/usr/local/bin/audit-wrap" },
      PATHS,
    );
    expect(launch.CLAUDE_CODE_SHELL_PREFIX).toBeUndefined();
    expect(launch.PATH).toBe(resolve("/bin"));
    expect(isRunShapingClaudeVariable("ANTHROPIC_BETAS")).toBe(true);
    expect(isRunShapingClaudeVariable("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS")).toBe(true);
    expect(isRunShapingClaudeVariable("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")).toBe(true);
    // Every provider endpoint override and the adb endpoint are part of the identity.
    expect(
      providerIdentity({
        ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example",
        ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "https://mantle.example",
        ANTHROPIC_AWS_BASE_URL: "https://aws.example",
        ADB_SERVER_SOCKET: "tcp:10.0.0.5:5037",
        ANDROID_ADB_SERVER_PORT: "5038",
      }),
    ).toBe(
      [
        "ADB_SERVER_SOCKET=tcp:10.0.0.5:5037",
        "ANDROID_ADB_SERVER_PORT=5038",
        "ANTHROPIC_AWS_BASE_URL=https://aws.example",
        "ANTHROPIC_BEDROCK_MANTLE_BASE_URL=https://mantle.example",
        "ANTHROPIC_FOUNDRY_BASE_URL=https://foundry.example",
      ].join("\n"),
    );
    // Gateway routes on one host differ by path; a trailing slash is the same route.
    const route = (url: string) => providerIdentity({ ANTHROPIC_BASE_URL: url });
    expect(route("https://gw:4000")).toBe("ANTHROPIC_BASE_URL=https://gw:4000");
    expect(route("https://gw:4000/")).toBe("ANTHROPIC_BASE_URL=https://gw:4000");
    expect(route("https://gw:4000/anthropic")).not.toBe(route("https://gw:4000"));
    expect(route("https://gw:4000/anthropic/")).toBe(route("https://gw:4000/anthropic"));
    expect(route("https://gw:4000/anthropic")).not.toContain("anthropic");
    // http and https to one gateway are different transports.
    expect(route("http://gw:4000/anthropic")).not.toBe(route("https://gw:4000/anthropic"));
    // Provider-specific region routing is recorded.
    expect(
      providerIdentity({
        ANTHROPIC_BEDROCK_REGION_PREFIX: "eu",
        ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: "us-east-2",
        VERTEX_REGION_CLAUDE_HAIKU: "europe-west1",
        ANTHROPIC_BEDROCK_SERVICE_TIER: "flex",
        ANTHROPIC_FOUNDRY_RESOURCE: "my-resource",
      }),
    ).toBe(
      [
        "ANTHROPIC_BEDROCK_REGION_PREFIX=eu",
        "ANTHROPIC_BEDROCK_SERVICE_TIER=flex",
        "ANTHROPIC_FOUNDRY_RESOURCE=my-resource",
        "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION=us-east-2",
        "VERTEX_REGION_CLAUDE_HAIKU=europe-west1",
      ].join("\n"),
    );
    expect(
      providerIdentity(
        { CLAUDE_CODE_USE_MANTLE: "1", CLAUDE_CODE_USE_ANTHROPIC_AWS: "1" },
        undefined,
        "linux",
        STUB_AWS_CONFIG,
      ),
    ).toBe(
      [
        "CLAUDE_CODE_USE_ANTHROPIC_AWS=1",
        "CLAUDE_CODE_USE_MANTLE=1",
        "aws-config=sha256:stub",
      ].join("\n"),
    );
    // Proxy routing is recorded by host and bypass list, its credentials only as a digest.
    // POSIX casing: on Windows no_proxy is NO_PROXY (covered separately).
    const proxied = providerIdentity(
      { HTTPS_PROXY: "http://user:pass@proxy.corp:3128", no_proxy: "localhost,127.0.0.1" },
      undefined,
      "linux",
    );
    expect(proxied).toBe(
      [
        `HTTPS_PROXY=http://sha256:${pathDigest("user:pass")}@proxy.corp:3128`,
        "no_proxy=localhost,127.0.0.1",
      ].join("\n"),
    );
    expect(proxied).not.toContain("pass");
    // Claude-only proxy overrides route the API too.
    expect(
      providerIdentity({ CLAUDE_CODE_HTTPS_PROXY: "http://user:pass@claude-proxy.corp:8080" }),
    ).toBe(
      `CLAUDE_CODE_HTTPS_PROXY=http://sha256:${pathDigest("user:pass")}@claude-proxy.corp:8080`,
    );
    expect(providerIdentity({ ANTHROPIC_BASE_URL: "not a url" })).toBe(
      "ANTHROPIC_BASE_URL=(unparseable)",
    );
  });
});
