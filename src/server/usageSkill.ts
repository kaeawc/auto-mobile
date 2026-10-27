import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  skillEntry,
  SkillsExtension,
  type Skill,
  type SkillReadResult,
  type SkillSource,
} from "@modelcontextprotocol/server/ext/skills";
import { errorMessage } from "../utils/describeUnknownError";
import { sortedReaddirEntriesSync } from "../utils/io";
import { logger } from "../utils/logger";

/** Scheme every skill file URI starts with (SEP-2640 default `baseUri`). */
const SKILL_URI_PREFIX = "skill://";

/**
 * Folder of skill folders, relative to this module. The same two levels up reach the package
 * root from `src/server/` in a checkout and from `dist/src/` in the bundled package, where
 * `package.json` `files` ships `mcp-skills`.
 */
const DEFAULT_SKILLS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../mcp-skills",
);

/** A skill folder read into memory: the published entry plus each file's text. */
interface LoadedSkill {
  readonly entry: Skill;
  readonly files: ReadonlyMap<string, string>;
}

/** Whether a resource URI addresses a skill file (served here instead of by the resource registry). */
export function isSkillUri(uri: string): boolean {
  return uri.startsWith(SKILL_URI_PREFIX);
}

function listFilesRecursively(root: string, relativeDir = ""): string[] {
  return sortedReaddirEntriesSync(path.join(root, relativeDir)).flatMap((dirent) => {
    const relative = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      return listFilesRecursively(root, relative);
    }
    return dirent.isFile() ? [relative] : [];
  });
}

async function loadSkillFolder(root: string, name: string): Promise<LoadedSkill> {
  const skillDir = path.join(root, name);
  const files = new Map(
    listFilesRecursively(skillDir).map((relative) => [
      relative,
      fs.readFileSync(path.join(skillDir, relative), "utf8"),
    ]),
  );
  return { entry: await skillEntry(name, Object.fromEntries(files)), files };
}

async function loadAllSkills(root: string): Promise<readonly LoadedSkill[]> {
  const names = sortedReaddirEntriesSync(root)
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
  return Promise.all(names.map((name) => loadSkillFolder(root, name)));
}

/** A skill file's content addressed by URI; `undefined` when no loaded skill serves it. */
function readLoadedFile(skills: readonly LoadedSkill[], uri: string): SkillReadResult | undefined {
  const match = skills.find(({ entry }) => uri.startsWith(entry.uri.slice(0, -"SKILL.md".length)));
  if (!match) {
    return undefined;
  }
  const folderUri = match.entry.uri.slice(0, -"SKILL.md".length);
  const text = match.files.get(uri.slice(folderUri.length));
  return text === undefined ? undefined : { text, mimeType: mimeTypeFor(uri) };
}

function mimeTypeFor(uri: string): string {
  return uri.endsWith(".md") ? "text/markdown" : "text/plain";
}

/**
 * The skills source over a folder of skill folders. It is synchronous to construct and reads
 * the folder on first use, because `createMcpServer` is synchronous and builds one server per
 * stateless request; the load is memoized so every server shares one read. A folder that cannot
 * be read serves no skills instead of failing the server.
 */
export class UsageSkillSource implements SkillSource {
  private loaded: Promise<readonly LoadedSkill[]> | undefined;

  constructor(private readonly root: string = DEFAULT_SKILLS_ROOT) {}

  private skills(): Promise<readonly LoadedSkill[]> {
    this.loaded ??= loadAllSkills(this.root).catch((error: unknown) => {
      logger.warn(`[usageSkill] Failed to load skills from ${this.root}: ${errorMessage(error)}`);
      return [];
    });
    return this.loaded;
  }

  async list(): Promise<{ skills: Skill[] }> {
    return { skills: (await this.skills()).map(({ entry }) => entry) };
  }

  async get(uri: string): Promise<Skill | undefined> {
    return (await this.skills()).find(({ entry }) => entry.uri === uri)?.entry;
  }

  async read(uri: string): Promise<SkillReadResult | undefined> {
    return readLoadedFile(await this.skills(), uri);
  }
}

const sharedSource = new UsageSkillSource();
const sharedExtension = new SkillsExtension({ source: sharedSource });

/**
 * Serves the usage skill on `server` (`skills/list`, `skills/get`) so a host loads it on demand.
 * It is not listed in `tools/list`, `resources/list` or any default context. Call before connecting.
 */
export function attachUsageSkill(server: McpServer): void {
  sharedExtension.attach(server);
}

/**
 * Reads a `skill://` file for `resources/read`. The skills extension registers the same read on
 * the SDK server, but our own `resources/read` handler replaces the SDK's, so it delegates here.
 */
export async function readUsageSkillResource(
  uri: string,
  source: Pick<UsageSkillSource, "read"> = sharedSource,
): Promise<{ contents: [{ uri: string; mimeType?: string; text: string }] } | undefined> {
  const result = await source.read(uri);
  if (!result || !("text" in result)) {
    return undefined;
  }
  return { contents: [{ uri, mimeType: result.mimeType, text: result.text }] };
}
