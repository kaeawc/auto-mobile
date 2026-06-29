import * as yaml from "js-yaml";

export const PLAN_YAML_LOAD_OPTIONS: yaml.LoadOptions = {
  schema: yaml.CORE_SCHEMA.withTags(yaml.mergeTag),
};
