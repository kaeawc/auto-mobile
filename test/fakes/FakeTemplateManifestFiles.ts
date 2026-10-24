import { basename, dirname } from "node:path";
import type { TemplateManifestFiles } from "../../src/features/iosTemplates/FileSimulatorTemplateManifestStore";
import type { SimulatorTemplateManifest } from "../../src/features/iosTemplates/SimulatorTemplateManifestStore";
export class FakeTemplateManifestFiles implements TemplateManifestFiles {
  readonly files = new Map<string, string>();
  read(path: string): string | undefined {
    return this.files.get(path);
  }
  write(path: string, value: SimulatorTemplateManifest): void {
    this.files.set(path, JSON.stringify(value));
  }
  remove(path: string): void {
    this.files.delete(path);
  }
  list(directory: string): string[] {
    return [...this.files.keys()]
      .filter((path) => dirname(path) === directory)
      .map((path) => basename(path));
  }
}
