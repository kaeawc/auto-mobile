/**
 * Parser for `aapt2 dump xmltree` output (the compiled binary XML of an APK).
 *
 * The text format is aapt2's own tree dump, not free-form text: every element is an
 * `E: name (line=N)` row and every attribute an `A: [ns:]name(0xRES)=value` row belonging to the
 * nearest preceding element. Indentation encodes nesting but not by a fixed step (an element's
 * children sit two columns deeper than its attributes), so nesting is derived from the relative
 * indent of element rows instead of a constant.
 */

export interface XmlTreeNode {
  readonly name: string;
  /** Attribute local names (namespace prefix stripped) to their unquoted value text. */
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlTreeNode[];
}

interface MutableNode {
  name: string;
  attributes: Record<string, string>;
  children: MutableNode[];
}

const ELEMENT_ROW = /^(\s*)E: (\S+) \(line=\d+\)\s*$/;
const ATTRIBUTE_ROW = /^\s*A: (.*?)(?:\(0x[0-9a-fA-F]+\))?=(.*)$/;
const RAW_SUFFIX = /\s\(Raw: ".*"\)$/;

function attributeLocalName(qualified: string): string {
  const separator = qualified.lastIndexOf(":");
  return separator === -1 ? qualified : qualified.slice(separator + 1);
}

function attributeValue(text: string): string {
  const withoutRaw = text.replace(RAW_SUFFIX, "");
  return withoutRaw.length >= 2 && withoutRaw.startsWith('"') && withoutRaw.endsWith('"')
    ? withoutRaw.slice(1, -1)
    : withoutRaw;
}

/** Parse one `aapt2 dump xmltree` dump into its root element; throws when there is none. */
export function parseAaptXmlTree(dump: string): XmlTreeNode {
  const stack: { indent: number; node: MutableNode }[] = [];
  let root: MutableNode | undefined;
  for (const line of dump.split("\n")) {
    const element = ELEMENT_ROW.exec(line);
    if (element) {
      const indent = element[1].length;
      const node: MutableNode = { name: element[2], attributes: {}, children: [] };
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      const parent = stack[stack.length - 1]?.node;
      if (parent) {
        parent.children.push(node);
      } else if (root === undefined) {
        root = node;
      } else {
        throw new Error(`aapt2 xmltree dump has more than one root element: ${node.name}`);
      }
      stack.push({ indent, node });
      continue;
    }
    if (!/^\s*A: /.test(line)) {
      continue;
    }
    const attribute = ATTRIBUTE_ROW.exec(line);
    const owner = stack[stack.length - 1]?.node;
    if (!attribute || !owner) {
      // Fail closed: a dropped attribute row would read as "attribute absent" to the policy.
      throw new Error(`unparseable aapt2 xmltree attribute row: ${line.trim()}`);
    }
    owner.attributes[attributeLocalName(attribute[1])] = attributeValue(attribute[2]);
  }
  if (root === undefined) {
    throw new Error("aapt2 xmltree dump has no root element");
  }
  return root;
}

/** Every descendant (and the node itself) matching `name`, depth first. */
export function findAll(node: XmlTreeNode, name: string): XmlTreeNode[] {
  const matches = node.name === name ? [node] : [];
  return matches.concat(node.children.flatMap((child) => findAll(child, name)));
}

/** The direct children of `node` named `name`. */
export function childrenNamed(node: XmlTreeNode, name: string): XmlTreeNode[] {
  return node.children.filter((child) => child.name === name);
}

/** `aapt2 dump resources` rows for xml resources: resource id to every config's file path. */
export function parseXmlResourceFiles(dump: string): ReadonlyMap<string, readonly string[]> {
  const files = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of dump.split("\n")) {
    const resource = /^\s*resource (0x[0-9a-fA-F]+) xml\//.exec(line);
    if (resource) {
      current = [];
      files.set(resource[1].toLowerCase(), current);
      continue;
    }
    if (/^\s*(?:resource |type )/.test(line)) {
      current = undefined;
      continue;
    }
    const file = /^\s*\([^)]*\) \(file\) (\S+) type=XML\s*$/.exec(line);
    if (file && current) {
      current.push(file[1]);
    }
  }
  return files;
}

/**
 * A boolean attribute as aapt2 prints it: `true`/`false`, or the raw `0xffffffff`/`0x0` form older
 * build-tools use. Anything else (a `@0x7f...` resource reference, say) cannot be judged, so it
 * throws rather than silently reading as false.
 */
export function booleanAttribute(node: XmlTreeNode, name: string): boolean | undefined {
  const value = node.attributes[name];
  if (value === undefined) {
    return undefined;
  }
  if (value === "true" || /^(?:\(type 0x12\))?0x0*[1-9a-f][0-9a-f]*$/i.test(value)) {
    return true;
  }
  if (value === "false" || /^(?:\(type 0x12\))?0x0+$/i.test(value)) {
    return false;
  }
  throw new Error(`<${node.name}> ${name}=${value} is not a literal boolean the policy can judge`);
}
