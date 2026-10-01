import { parseStringPromise } from "xml2js";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { iosPreferenceType, type IosPreferenceType } from "./IosPreferenceTypes";

interface PlistNode {
  "#name": string;
  _?: string;
  $$?: PlistNode[];
}

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };
export interface IosPlistPreference {
  type: IosPreferenceType;
  value: string | number | boolean;
}

// XctestrunPlist's ordered parser loses 64-bit integer precision. Keep the
// preference-specific conversion here rather than changing its other consumers.
export async function parseIosUserDefaultsPlist(
  xml: string,
): Promise<Map<string, IosPlistPreference>> {
  try {
    const parsed: PlistNode = await parseStringPromise(xml, {
      explicitChildren: true,
      preserveChildrenOrder: true,
      explicitRoot: false,
      trim: false,
    });
    const root = parsed["#name"] === "plist" ? parsed.$$?.[0] : undefined;
    if (!root || root["#name"] !== "dict") {
      throw new ActionableError("The iOS UserDefaults plist must contain a dictionary.");
    }
    return new Map(
      dictionaryPairs(root).map(([key, node]) => {
        const value = nodeValue(node);
        return [
          key,
          {
            type: iosPreferenceType(node["#name"]),
            value: typeof value === "object" ? JSON.stringify(value) : value,
          },
        ];
      }),
    );
  } catch (error) {
    throw toActionableError(error, "Failed to parse iOS UserDefaults XML plist");
  }
}

function dictionaryPairs(node: PlistNode): Array<[string, PlistNode]> {
  const children = node.$$ ?? [];
  const pairs: Array<[string, PlistNode]> = [];
  for (let i = 0; i < children.length; i += 2) {
    const key = children[i];
    const value = children[i + 1];
    if (key?.["#name"] !== "key" || !value) {
      throw new ActionableError("Malformed iOS UserDefaults plist dictionary key/value pair.");
    }
    pairs.push([key._ ?? "", value]);
  }
  return pairs;
}

function nodeValue(node: PlistNode): PlistValue {
  const text = node._ ?? "";
  switch (node["#name"]) {
    case "dict":
      return Object.fromEntries(
        dictionaryPairs(node).map(([key, child]) => [key, nodeValue(child)]),
      );
    case "array":
      return (node.$$ ?? []).map(nodeValue);
    case "integer":
      return plistInteger(text);
    case "real":
      return Number(text);
    case "true":
      return true;
    case "false":
      return false;
    case "date":
      return new Date(text).toISOString();
    case "data":
      return text.replace(/\s/g, "");
    case "string":
      return text;
    default:
      throw new ActionableError(`Unsupported iOS UserDefaults plist tag '${node["#name"]}'.`);
  }
}

function plistInteger(text: string): number | string {
  if (!/^-?\d+$/.test(text.trim())) {
    throw new ActionableError("Invalid integer in iOS UserDefaults plist.");
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : text.trim();
}
