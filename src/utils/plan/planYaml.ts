import * as yaml from "js-yaml";

export const PLAN_YAML_LOAD_OPTIONS: yaml.LoadOptions = {
  schema: new yaml.Schema([...yaml.CORE_SCHEMA.tags, yaml.mergeTag]),
};
