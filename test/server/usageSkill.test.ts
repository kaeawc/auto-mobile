import { Client } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DaemonClient } from "../../src/daemon/client";
import { createMcpServer } from "../../src/server/index";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { UsageSkillSource } from "../../src/server/usageSkill";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";

const SKILL_URI = "skill://auto-mobile-usage/SKILL.md";
const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SKILL_FILE = path.join(REPO_ROOT, "mcp-skills", "auto-mobile-usage", "SKILL.md");

interface Connection {
  readonly client: Client;
  readonly skills: SkillsClient;
  close(): Promise<void>;
}

async function connectDirect(): Promise<Connection> {
  const server = createMcpServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "usage-skill-direct", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    skills: new SkillsClient(client),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function connectProxy(): Promise<Connection> {
  const { server, proxy } = createProxyMcpServer({
    proxyConfig: {
      clientFactory: () => new FakeDaemonClient(),
      daemonManager: new FakeDaemonManager(),
      autoStartDaemon: false,
    },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "usage-skill-proxy", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    skills: new SkillsClient(client),
    close: async () => {
      await client.close();
      await proxy.close();
    },
  };
}

describe.each([
  ["direct server", connectDirect],
  ["proxy server", connectProxy],
])("usage skill over %s", (_label, connect) => {
  let connection: Connection;
  let restore: () => void;
  let availability: () => void;

  beforeAll(async () => {
    restore = installHermeticServerFixture();
    // A proxy that served the skill through the daemon would try to reach one.
    const availabilitySpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(false);
    availability = () => availabilitySpy.mockRestore();
    connection = await connect();
  });

  afterAll(async () => {
    await connection.close();
    availability();
    restore();
  });

  test("declares the skills extension", () => {
    expect(connection.skills.supported).toBe(true);
  });

  test("skills/list returns the usage skill", async () => {
    const { skills, invalid } = await connection.skills.list();
    expect(invalid).toEqual([]);
    expect(skills.map((skill) => skill.uri)).toEqual([SKILL_URI]);
    expect(skills[0]?.frontmatter.name).toBe("auto-mobile-usage");
    expect(skills[0]?.frontmatter.description).toContain("AutoMobile");
  });

  test("skills/get returns the entry and the file reads back verified", async () => {
    const { skill } = await connection.skills.get(SKILL_URI);
    expect(skill.uri).toBe(SKILL_URI);
    const file = await connection.skills.read(skill);
    expect(file.verified).toBe(true);
    expect(file.body).toStartWith("\n# Driving devices with AutoMobile");
    expect(file.text).toContain("Observe before you act");
  });

  test("skills/get for an unknown skill is refused", async () => {
    await expect(connection.skills.get("skill://missing/SKILL.md")).rejects.toThrow();
  });

  test("reading a file the skill does not contain is refused without reaching the daemon", async () => {
    await expect(
      connection.client.readResource({ uri: "skill://auto-mobile-usage/references/missing.md" }),
    ).rejects.toThrow(/not found/i);
  });

  test("the skill stays out of tools and the default resource list", async () => {
    const resources = await connection.client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).not.toContain(SKILL_URI);
    const tools = await connection.client.listTools();
    expect(JSON.stringify(tools)).not.toContain("auto-mobile-usage");
  });
});

describe("UsageSkillSource", () => {
  test("serves no skills when the folder cannot be read", async () => {
    const source = new UsageSkillSource(path.join(REPO_ROOT, "mcp-skills", "does-not-exist"));
    expect(await source.list()).toEqual({ skills: [] });
    expect(await source.read(SKILL_URI)).toBeUndefined();
  });

  test("read refuses a file the skill does not contain", async () => {
    const source = new UsageSkillSource();
    expect(await source.read("skill://auto-mobile-usage/references/missing.md")).toBeUndefined();
    expect(await source.read("skill://other/SKILL.md")).toBeUndefined();
  });
});

describe("usage skill packaging", () => {
  test("the skill folder ships in the npm package", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      files: string[];
    };
    expect(manifest.files).toContain("mcp-skills");
    expect(existsSync(SKILL_FILE)).toBe(true);
    expect(readFileSync(SKILL_FILE, "utf8")).toMatch(/^---\nname: auto-mobile-usage\n/);
  });
});
