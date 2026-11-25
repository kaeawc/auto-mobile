import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

// Apart from prototypeRemoteImages.ts's contract limits and URL rules, so the web library can tell
// a bare spec needs remote images in the browser (#16453).

const FIELDS = ["url", "placeholder", "error", "crossfade", "via"];

export function prototypeRemoteImageFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    const accessory = record(record(node.ios)?.bottomAccessory);
    if (accessory) {
      fields.push(
        ...prototypeRemoteImageFields({ root: accessory }).map(
          (field) => `${path}.ios.bottomAccessory${field.slice(4)}`,
        ),
      );
    }
    if (node.type === "image") {
      fields.push(
        ...FIELDS.filter((field) => node[field] !== undefined).map((field) => `${path}.${field}`),
      );
    }
  });
  return fields;
}
