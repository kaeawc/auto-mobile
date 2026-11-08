import { Builder, parseStringPromise } from "xml2js";
import { ActionableError, toActionableError } from "../../../../models/ActionableError";

export interface AndroidManifestStampInput {
  templatePackage: string;
  appId: string;
  label: string;
  permissions: readonly string[];
  enabledComponents: readonly string[];
}
interface XmlNode {
  $?: Record<string, string>;
  [name: string]: Record<string, string> | XmlNode[] | undefined;
}

/** Parse and rebuild text XML; resource ownership stays with the linked template table. */
export async function stampAndroidManifest(
  xml: string,
  input: AndroidManifestStampInput,
): Promise<string> {
  try {
    const document: { manifest: XmlNode } = await parseStringPromise(xml, { explicitArray: true });
    const manifest = document.manifest;
    if (!manifest || !Array.isArray(manifest.application) || manifest.application.length !== 1) {
      throw new ActionableError("Template must contain one application manifest element.");
    }
    rewriteAttributes(manifest, input);
    manifest.$ = { ...manifest.$, package: input.appId };
    const application = manifest.application[0]!;
    application.$ = { ...application.$, "android:label": input.label };
    delete manifest["uses-permission-sdk-23"];
    manifest["uses-permission"] = [
      ...new Set(["android.permission.INTERNET", ...input.permissions]),
    ]
      .sort()
      .map((name) => ({ $: { "android:name": name } }));
    const components = ["activity", "service", "receiver", "provider"].flatMap((tag) =>
      Array.isArray(application[tag]) ? application[tag] : [],
    );
    for (const name of input.enabledComponents) {
      const component = components.find((node) => node.$?.["android:name"] === name);
      if (!component) {
        throw new ActionableError(
          `Unknown Android template component ${name}. Choose a component declared by this template.`,
        );
      }
      component.$ = { ...component.$, "android:enabled": "true" };
    }
    return (
      new Builder({ renderOpts: { pretty: true, indent: "  ", newline: "\n" } }).buildObject(
        document,
      ) + "\n"
    );
  } catch (error) {
    throw toActionableError(error, "Cannot stamp Android template manifest");
  }
}

function rewriteAttributes(node: XmlNode, input: AndroidManifestStampInput): void {
  for (const [key, value] of Object.entries(node.$ ?? {})) {
    const local = key.split(":").at(-1)!;
    if (local.startsWith("compileSdk") || local.startsWith("platformBuild")) {
      delete node.$![key];
      continue;
    }
    node.$![key] = rewriteAttributeValue(value, input);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        rewriteAttributes(child, input);
      }
    }
  }
}

function rewriteAttributeValue(value: string, input: AndroidManifestStampInput): string {
  // Attribute values only: XML structure is traversed through xml2js, never regex.
  if (value === "@null" || value === "@empty") {
    // Special values, not resources; a package-qualified form would fail to link.
    return value;
  }
  if (value.startsWith("@") && !value.startsWith("@0x") && !value.includes(":")) {
    return `@*${input.templatePackage}:${value.slice(1)}`;
  }
  if (
    value.startsWith(`@${input.templatePackage}:`) ||
    value.startsWith(`@*${input.templatePackage}:`)
  ) {
    return `@*${input.templatePackage}:${value.slice(value.indexOf(":") + 1)}`;
  }
  return value.replaceAll(input.templatePackage, input.appId);
}
