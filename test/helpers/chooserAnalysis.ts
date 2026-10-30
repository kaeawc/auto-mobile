import fs from "node:fs";
import path from "node:path";
import { IntentChooserHandler } from "../../src/features/utility/IntentChooserHandler";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

const fixtureDir = path.join(import.meta.dir, "../fixtures/intent-chooser");

export const CHOOSER_CAPTURE_PATH = path.join(fixtureDir, "observe-raw-artifact.json");
export const CHOOSER_EXPECTED_PATH = path.join(fixtureDir, "expected-chooser-analysis.json");

type Props = Record<string, unknown>;
type Mutable = Record<string, unknown>;

const INDICATOR_TEXTS = [
  "Choose an app",
  "Open with",
  "Complete action using",
  "Always",
  "Just once",
];

/**
 * What DeepLinkManager's chooser analysis answers for a captured ResolverActivity hierarchy:
 * intent-chooser detection (whole, and with indicators removed), the list and its anchor rows
 * with their page signatures, and per-package row lookups with the label sets collected for the
 * fallback. `expected-chooser-analysis.json` was produced by this function against the code
 * before the chooser reads moved onto SearchableNode, so the test pins behaviour, not a re-derivation.
 */
export async function analyseChooserCapture(capturePath = CHOOSER_CAPTURE_PATH) {
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  const hierarchy = capture.viewHierarchy;
  const manager = new IntentChooserHandler(null, {
    adbFactory: { create: () => new FakeAdbExecutor() },
  });
  const parser = manager.parser;
  const props = (node: unknown): Props => parser.extractNodeProperties(node as never) as Props;
  const visit = (h: unknown, fn: (node: Mutable) => void) => {
    for (const root of parser.extractRootNodes(h as never)) {
      parser.traverseNode(root as never, (node: unknown) => fn(node as Mutable));
    }
  };

  const isIndicator = (p: Props) =>
    INDICATOR_TEXTS.includes(String(p.text || p["content-desc"] || "")) ||
    /ChooserActivity|ResolverActivity/.test(String(p.class || "")) ||
    /button_always|button_once|resolver_list|chooser_list/.test(String(p["resource-id"] || ""));
  const blank = (node: Mutable) => {
    delete node.text;
    delete node["content-desc"];
    delete node["resource-id"];
    node.class = "x";
  };

  let indicatorCount = 0;
  visit(hierarchy, (node) => {
    if (isIndicator(props(node))) {
      indicatorCount++;
    }
  });
  const detectWithout = Array.from({ length: indicatorCount }, (_unused, target) => {
    const copy = structuredClone(hierarchy);
    let seen = 0;
    visit(copy, (node) => {
      if (isIndicator(props(node))) {
        if (seen === target) {
          blank(node);
        }
        seen++;
      }
    });
    return manager.detectIntentChooser(copy);
  });
  const stripped = structuredClone(hierarchy);
  visit(stripped, (node) => {
    if (isIndicator(props(node))) {
      blank(node);
    }
  });

  const analyseHierarchy = async (h: typeof hierarchy) => {
    const roots = parser.extractRootNodes(h);
    const list = manager.findChooserList(roots);
    const packages = new Set<string>();
    visit(h, (node) => {
      const p = props(node);
      for (const value of [p.package, p.packageName]) {
        if (typeof value === "string") {
          packages.add(value);
        }
      }
      const id = p["resource-id"];
      if (typeof id === "string" && id.indexOf(":id/") > 0) {
        packages.add(id.slice(0, id.indexOf(":id/")));
      }
    });
    const apps: Record<string, unknown> = {};
    const labels: Record<string, unknown> = {};
    for (const pkg of [...packages, "com.example.nomatch"]) {
      const probe = new IntentChooserHandler(null, {
        adbFactory: { create: () => new FakeAdbExecutor() },
      });
      const select = IntentChooserHandler.prototype.selectUniqueChooserRow;
      Object.defineProperty(probe, "selectUniqueChooserRow", {
        value: (...args: Parameters<IntentChooserHandler["selectUniqueChooserRow"]>) => {
          const [candidates, labelRows] = args;
          labels[pkg] = {
            candidates: candidates.map((row) => row["view-id"] ?? null),
            labelRows: [...labelRows.entries()].map(([row, set]) => [
              row["view-id"] ?? null,
              [...set],
            ]),
          };
          return select.call(probe, ...args);
        },
      });
      try {
        const match = await probe.findAppInChooser(roots, pkg, { hierarchyPackage: h.packageName });
        apps[pkg] = {
          ok: true,
          packageVerified: match.packageVerified,
          bounds: match.element?.bounds ?? null,
        };
      } catch (error) {
        apps[pkg] = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return {
      anchors: [...manager.getChooserAnchorRows(h).entries()],
      list: list ? { bounds: list.bounds, resourceId: list["resource-id"] ?? null } : null,
      apps,
      labels,
    };
  };

  // Variant: each list row's text1 label gets an app-specific resource-id namespace, so the
  // namespace and package-row paths run on a real capture's structure.
  const namespaced = structuredClone(hierarchy);
  let next = 0;
  visit(namespaced, (node) => {
    const id = props(node)["resource-id"];
    if (typeof id === "string" && id.endsWith(":id/text1")) {
      node["resource-id"] = `com.pkg${next++}:id/text1`;
    }
  });

  // Detection when only the first indicator node survives, in one shape at a time.
  const detectSingle = (shape: (node: Mutable, original: Mutable) => boolean) => {
    const copy = structuredClone(hierarchy);
    let used = false;
    visit(copy, (node) => {
      if (!isIndicator(props(node))) {
        return;
      }
      const original = { ...node };
      blank(node);
      if (!used && shape(node, original)) {
        used = true;
      }
    });
    return manager.detectIntentChooser(copy);
  };
  const detectSingleIndicator = {
    textOnly: detectSingle((node, o) => {
      node.text = o.text ?? o["content-desc"] ?? "Always";
      node.class = "x";
      return true;
    }),
    contentDescOnly: detectSingle((node, o) => {
      node["content-desc"] = String(o.text ?? "Always");
      node.class = "x";
      return true;
    }),
    resourceIdOnly: detectSingle((node, o) => {
      node["resource-id"] = String(o["resource-id"] ?? "android:id/button_always");
      node.class = "x";
      return true;
    }),
    classOnly: detectSingle((node) => {
      node.class = "com.android.internal.app.ResolverActivity";
      return true;
    }),
    blankTextWithDescription: detectSingle((node) => {
      node.text = "  ";
      node["content-desc"] = "Always";
      node.class = "x";
      return true;
    }),
    emptyTextWithDescription: detectSingle((node) => {
      node.text = "";
      node["content-desc"] = "Always";
      node.class = "x";
      return true;
    }),
  };

  // Variant: every row under the list gets unique bare view ids (so each is an anchor row), and
  // the nodes below carry a mix of text, content-desc, empty and blank values.
  const mixed = structuredClone(namespaced);
  let k = 0;
  let row = 0;
  visit(mixed, (node) => {
    const p = props(node);
    if (p.clickable === true || p.clickable === "true") {
      node["view-id"] = `s2-${(row++).toString(16).padStart(16, "0")}`;
    }
    switch (k++ % 4) {
      case 0:
        delete node.text;
        node["content-desc"] = `description ${k}`;
        break;
      case 1:
        node.text = "";
        break;
      case 2:
        node.text = "  ";
        node["content-desc"] = "";
        break;
      default:
        break;
    }
  });

  return {
    detectAll: manager.detectIntentChooser(hierarchy),
    detectWithout,
    detectStripped: manager.detectIntentChooser(stripped),
    detectSingleIndicator,
    original: await analyseHierarchy(hierarchy),
    namespaced: await analyseHierarchy(namespaced),
    mixed: await analyseHierarchy(mixed),
  };
}
