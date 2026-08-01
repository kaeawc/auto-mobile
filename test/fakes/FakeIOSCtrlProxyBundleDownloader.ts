import * as fs from "fs/promises";
import * as path from "path";
import { resolveRunnerChecksum } from "../../src/constants/release";
import type { Sha256Source, CtrlProxyIosBundleDownloader } from "../../src/utils/IOSCtrlProxyBundleDownloader";

export class FakeIOSCtrlProxyBundleDownloader implements CtrlProxyIosBundleDownloader {
  public downloadedUrls: string[] = [];
  public extractedPaths: string[] = [];
  public checksum: string = "fake-checksum";
  public runnerChecksum: string = resolveRunnerChecksum();
  public legacyRunnerChecksum: string = resolveRunnerChecksum();
  public checksummedFilePaths: string[] = [];
  public checksumSource: Sha256Source = "node";
  public extractedSubdir: string = "";
  /** When true, also emit Debug-iphoneos products + a device xctestrun (issue #4761 AC3). */
  public includeDeviceProducts: boolean = false;

  public async download(url: string, destination: string): Promise<void> {
    this.downloadedUrls.push(url);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const payload = "a".repeat(12000);
    await fs.writeFile(destination, payload);
  }

  public async computeFileSha256(filePath: string): Promise<{ checksum: string; source: Sha256Source }> {
    this.checksummedFilePaths.push(filePath);
    if (path.basename(filePath) === "CtrlProxyUITests") {
      return { checksum: this.runnerChecksum, source: this.checksumSource };
    }
    if (path.basename(filePath) === "CtrlProxyUITests-Runner") {
      return { checksum: this.legacyRunnerChecksum, source: this.checksumSource };
    }
    return { checksum: this.checksum, source: this.checksumSource };
  }

  public async extractBundle(_bundlePath: string, destination: string): Promise<void> {
    const extractionRoot = this.extractedSubdir
      ? path.join(destination, this.extractedSubdir)
      : destination;
    this.extractedPaths.push(extractionRoot);
    const productsDir = path.join(extractionRoot, "Build", "Products", "Debug-iphonesimulator");
    await fs.mkdir(productsDir, { recursive: true });
    const xctestrunFile = path.join(extractionRoot, "Build", "Products", "CtrlProxyApp_iphonesimulator.xctestrun");
    await fs.writeFile(xctestrunFile, "fake xctestrun");
    await fs.mkdir(path.join(productsDir, "CtrlProxyApp.app"), { recursive: true });
    const runnerDir = path.join(productsDir, "CtrlProxyUITests-Runner.app");
    await fs.mkdir(runnerDir, { recursive: true });
    await fs.writeFile(path.join(runnerDir, "CtrlProxyUITests-Runner"), "fake runner");
    const xctestBinary = path.join(runnerDir, "PlugIns", "CtrlProxyUITests.xctest", "CtrlProxyUITests");
    await fs.mkdir(path.dirname(xctestBinary), { recursive: true });
    await fs.writeFile(xctestBinary, "fake CtrlProxy code");
    await fs.mkdir(path.join(productsDir, "CtrlProxyTests.xctest"), { recursive: true });

    if (this.includeDeviceProducts) {
      const deviceDir = path.join(extractionRoot, "Build", "Products", "Debug-iphoneos");
      await fs.mkdir(deviceDir, { recursive: true });
      const deviceXctestrun = path.join(extractionRoot, "Build", "Products", "CtrlProxyApp_iphoneos.xctestrun");
      await fs.writeFile(deviceXctestrun, "fake device xctestrun");
      await fs.mkdir(path.join(deviceDir, "CtrlProxyApp.app"), { recursive: true });
      const deviceRunnerDir = path.join(deviceDir, "CtrlProxyUITests-Runner.app");
      await fs.mkdir(deviceRunnerDir, { recursive: true });
      await fs.writeFile(path.join(deviceRunnerDir, "CtrlProxyUITests-Runner"), "fake device runner");
      const deviceXctestBinary = path.join(deviceRunnerDir, "PlugIns", "CtrlProxyUITests.xctest", "CtrlProxyUITests");
      await fs.mkdir(path.dirname(deviceXctestBinary), { recursive: true });
      await fs.writeFile(deviceXctestBinary, "fake device CtrlProxy code");
      await fs.mkdir(path.join(deviceDir, "CtrlProxyTests.xctest"), { recursive: true });
    }
  }
}
