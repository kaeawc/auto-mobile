import * as yaml from "js-yaml";

type SchemaWithTags = yaml.Schema & {
  withTags?: (...tags: unknown[]) => yaml.Schema;
};

type SchemaWithExtend = yaml.Schema & {
  extend?: (definition: { implicit?: unknown[]; explicit?: unknown[] }) => yaml.Schema;
};

type SchemaWithTagLists = {
  implicit?: readonly unknown[];
  explicit?: readonly unknown[];
};

function tagName(tag: unknown): unknown {
  if (!tag || typeof tag !== "object") {
    return undefined;
  }

  const record = tag as Record<string, unknown>;

  return record.tagName ?? record.tag;
}

function findMergeTag(tags: readonly unknown[]): unknown {
  return tags.find((tag) => tagName(tag) === "tag:yaml.org,2002:merge");
}

function createPlanYamlSchema(): yaml.Schema {
  const coreSchema = yaml.CORE_SCHEMA as SchemaWithTags & SchemaWithExtend;
  const mergeTag = (yaml as typeof yaml & { mergeTag?: unknown }).mergeTag;

  if (mergeTag && typeof coreSchema.withTags === "function") {
    return coreSchema.withTags(mergeTag);
  }

  const defaultSchema = (yaml as typeof yaml & { DEFAULT_SCHEMA?: SchemaWithTagLists })
    .DEFAULT_SCHEMA;
  const defaultTags = [...(defaultSchema?.implicit ?? []), ...(defaultSchema?.explicit ?? [])];
  const defaultMergeTag = findMergeTag(defaultTags);

  if (defaultMergeTag && typeof coreSchema.extend === "function") {
    return coreSchema.extend({ implicit: [defaultMergeTag] });
  }

  throw new Error("js-yaml merge tag support is not available");
}

export const PLAN_YAML_LOAD_OPTIONS: yaml.LoadOptions = {
  schema: createPlanYamlSchema(),
};

const BASE64_PLAN_CONTENT_PREFIX = "base64:";

/**
 * The plan YAML text behind an `executePlan` `planContent` value. A `base64:` prefix marks
 * base64-encoded YAML (what the JUnit and XCTest runners always send); anything else is
 * already YAML. Shared by the orchestrator (execution) and the daemon's request-deadline
 * resolver so the two can never read one plan differently (#10173). Pure and non-throwing:
 * Node's base64 decoder is lenient, so invalid base64 decodes to garbage that the caller's
 * own YAML handling rejects. Callers that must bound work apply their size limit to the
 * encoded length BEFORE calling this.
 */
export function decodePlanContent(planContent: string): string {
  if (!planContent.startsWith(BASE64_PLAN_CONTENT_PREFIX)) {
    return planContent;
  }
  return Buffer.from(planContent.substring(BASE64_PLAN_CONTENT_PREFIX.length), "base64").toString(
    "utf-8",
  );
}
