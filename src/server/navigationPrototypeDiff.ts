import { z } from "zod/v4";
import { ActionableError } from "../models";
import type { ExportedGraph } from "../utils/interfaces/NavigationGraph";
import type { PrototypeAssetFileReader } from "../features/prototype/prototypeAssetUploader";
import {
  diffPrototypeNavigation,
  realNavigationGraphFrom,
  type PrototypeNavigationDiff,
} from "../features/prototype/prototypeNavigationDiff";
import { prototypeSpecForDevice } from "../features/prototype/prototypeComponents";
import { buildPrototypeScreenMap } from "../features/prototype/prototypeScreenMap";
import { readPrototypeSpecFile } from "../features/prototype/prototypeSpecFile";
import { specProblem } from "./prototypeTools/schemas";

/**
 * The `getNavigationGraph` arguments that ask for a prototype diff (#14125). A function, so each
 * caller gets its own field instances and the advertised schema carries no shared `$ref`.
 */
export const prototypeDiffArgsShape = () => ({
  prototypeSpec: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "A prototype spec to diff against this graph: returns prototypeDiff with matched screens, prototype screens and transitions the app lacks, and app screens the prototype lacks. Not with prototypeSpecPath",
    ),
  prototypeSpecPath: z
    .string()
    .optional()
    .describe(
      "Absolute path of a prototype spec JSON file to diff against. Not with prototypeSpec",
    ),
  screenMapping: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Explicit matches for the diff: prototype screen id (as screenMap reports it, e.g. stack:nav/home) to real screen name. Tried before testTag and name matching. Not with screenMappingPath",
    ),
  screenMappingPath: z
    .string()
    .optional()
    .describe("Absolute path of a JSON file holding screenMapping. Not with screenMapping"),
});

/** Only used to derive the type; the advertised schema spreads a fresh shape. */
const prototypeDiffArgsSchema = z.object(prototypeDiffArgsShape());
export type PrototypeDiffArgs = z.output<typeof prototypeDiffArgsSchema>;

async function readJson(path: string, label: string, reader: PrototypeAssetFileReader) {
  const read = await readPrototypeSpecFile(path, reader, { label });
  if ("error" in read) {
    throw new ActionableError(read.error);
  }
  return read.json;
}

async function specOf(args: PrototypeDiffArgs, reader: PrototypeAssetFileReader) {
  if (args.prototypeSpec !== undefined && args.prototypeSpecPath !== undefined) {
    throw new ActionableError("Pass prototypeSpec or prototypeSpecPath, not both.");
  }
  const spec =
    args.prototypeSpecPath === undefined
      ? args.prototypeSpec
      : await readJson(args.prototypeSpecPath, "prototypeSpecPath", reader);
  const problem = specProblem(spec);
  if (problem) {
    throw new ActionableError(`prototype spec is invalid at ${problem.path}: ${problem.text}`);
  }
  // Map the expanded spec, as the screenMap action does, so a screen drawn by a component keeps
  // its testTag and its actions.
  return prototypeSpecForDevice(spec);
}

async function mappingOf(
  args: PrototypeDiffArgs,
  reader: PrototypeAssetFileReader,
): Promise<Record<string, string>> {
  if (args.screenMapping !== undefined && args.screenMappingPath !== undefined) {
    throw new ActionableError("Pass screenMapping or screenMappingPath, not both.");
  }
  if (args.screenMappingPath === undefined) {
    return args.screenMapping ?? {};
  }
  const json = await readJson(args.screenMappingPath, "screenMappingPath", reader);
  const isMapping =
    typeof json === "object" &&
    json !== null &&
    !Array.isArray(json) &&
    Object.values(json).every((value) => typeof value === "string");
  if (!isMapping) {
    throw new ActionableError(
      `screenMappingPath ${args.screenMappingPath}: expected a JSON object of prototype screen id to real screen name strings`,
    );
  }
  return json as Record<string, string>;
}

/** The diff for a `getNavigationGraph` call, or undefined when it names no prototype spec. */
export async function prototypeDiffForGraph(
  args: PrototypeDiffArgs,
  graph: ExportedGraph,
  reader: PrototypeAssetFileReader,
): Promise<PrototypeNavigationDiff | undefined> {
  if (args.prototypeSpec === undefined && args.prototypeSpecPath === undefined) {
    if (args.screenMapping !== undefined || args.screenMappingPath !== undefined) {
      throw new ActionableError(
        "screenMapping needs prototypeSpec or prototypeSpecPath to diff against.",
      );
    }
    return undefined;
  }
  const spec = await specOf(args, reader);
  const mapping = await mappingOf(args, reader);
  return diffPrototypeNavigation(
    buildPrototypeScreenMap(spec),
    realNavigationGraphFrom(graph),
    mapping,
  );
}
