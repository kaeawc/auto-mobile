import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import { execFileAsync, type ExecFileAsync } from "../HostCommandExecutor";
import { logger } from "../logger";

/** Bundle id of the disposable HealthKit seeding app. */
export const HEALTHKIT_SEEDER_BUNDLE_ID = "dev.am.hkseeder";
const EXECUTABLE = "hkseeder";
const TEAM = "AMSEED0000";

/**
 * Disposable app source, from the probe measured in #18796: it requests
 * authorization (which shows the Health Access sheet), saves the requested
 * samples and reads them back, printing `HKPROBE ...` lines on stdout.
 */
export const HEALTHKIT_SEEDER_SWIFT = `import UIKit
import HealthKit

func log(_ s: String) { print("HKPROBE " + s); fflush(stdout) }

func intArg(_ name: String, _ fallback: Double) -> Double {
  for a in ProcessInfo.processInfo.arguments where a.hasPrefix(name + "=") {
    if let v = Double(a.dropFirst(name.count + 1)) { return v }
  }
  return fallback
}

@main class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  let store = HKHealthStore()
  func application(_ a: UIApplication, didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)
    window?.rootViewController = UIViewController()
    window?.makeKeyAndVisible()
    let args = ProcessInfo.processInfo.arguments
    log("available=\\(HKHealthStore.isHealthDataAvailable()) args=\\(args.dropFirst())")
    if !HKHealthStore.isHealthDataAvailable() { log("done"); return true }
    let steps = HKQuantityType(.stepCount), hr = HKQuantityType(.heartRate)
    let sleep = HKCategoryType(.sleepAnalysis), workout = HKObjectType.workoutType()
    log("status steps=\\(store.authorizationStatus(for: steps).rawValue) hr=\\(store.authorizationStatus(for: hr).rawValue)")
    let go = { self.writeAndRead(steps: steps, hr: hr, sleep: sleep) }
    if args.contains("noauth") { go(); return true }
    store.requestAuthorization(toShare: [steps, hr, sleep, workout], read: [steps, hr, sleep, workout]) { ok, err in
      log("requestAuthorization ok=\\(ok) err=\\(String(describing: err))")
      log("status steps=\\(self.store.authorizationStatus(for: steps).rawValue) hr=\\(self.store.authorizationStatus(for: hr).rawValue)")
      go()
    }
    return true
  }
  func writeAndRead(steps: HKQuantityType, hr: HKQuantityType, sleep: HKCategoryType) {
    if CommandLine.arguments.contains("readonly") { readBack(steps, hr, sleep); return }
    let end = Date(), start = end.addingTimeInterval(-3600)
    let s = HKQuantitySample(type: steps, quantity: HKQuantity(unit: .count(), doubleValue: intArg("steps", 4242)), start: start, end: end)
    let h1 = HKQuantitySample(type: hr, quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: intArg("hr", 72)), start: start.addingTimeInterval(600), end: start.addingTimeInterval(600))
    let sleepSeconds = intArg("sleepHours", 8) * 3600
    let sl = HKCategorySample(type: sleep, value: HKCategoryValueSleepAnalysis.asleepCore.rawValue, start: end.addingTimeInterval(-3600 - sleepSeconds), end: end.addingTimeInterval(-3600))
    store.save([s, h1, sl]) { ok, err in
      log("save ok=\\(ok) err=\\(String(describing: err))")
      self.readBack(steps, hr, sleep)
    }
  }
  func readBack(_ types: HKSampleType...) {
    let group = DispatchGroup()
    for t in types {
      group.enter()
      let q = HKSampleQuery(sampleType: t, predicate: nil, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, res, err in
        log("read \\(t.identifier) n=\\(res?.count ?? -1) err=\\(String(describing: err))")
        if let q = res as? [HKQuantitySample] { for x in q { log("  value=\\(x.quantity)") } }
        group.leave()
      }
      store.execute(q)
    }
    group.notify(queue: .main) { log("done") }
  }
}
`;

export const HEALTHKIT_SEEDER_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${HEALTHKIT_SEEDER_BUNDLE_ID}</string>
<key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
<key>CFBundleName</key><string>${EXECUTABLE}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>MinimumOSVersion</key><string>17.0</string>
<key>UIDeviceFamily</key><array><integer>1</integer></array>
<key>NSHealthShareUsageDescription</key><string>${EXECUTABLE} reads health samples</string>
<key>NSHealthUpdateUsageDescription</key><string>${EXECUTABLE} writes health samples</string>
<key>UILaunchScreen</key><dict/>
</dict></plist>
`;

/** Embedded entitlements; the simulator needs `application-identifier` for HealthKit. */
export const HEALTHKIT_SEEDER_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>application-identifier</key><string>${TEAM}.${HEALTHKIT_SEEDER_BUNDLE_ID}</string>
<key>com.apple.developer.team-identifier</key><string>${TEAM}</string>
<key>com.apple.developer.healthkit</key><true/>
<key>com.apple.developer.healthkit.access</key><array/>
</dict></plist>
`;

export interface HealthKitAppBuild {
  /** The ad-hoc signed `.app` bundle path. */
  appPath: string;
  /** Removes what the build created on the host; call once the app is installed. */
  dispose(): Promise<void>;
}

export interface HealthKitAppBuilder {
  /** Builds and ad-hoc signs the disposable app. */
  build(): Promise<HealthKitAppBuild>;
}

/** Filesystem seam for the builder's temporary root. */
export interface HealthKitBuildFs {
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string): Promise<void>;
}

const nodeBuildFs: HealthKitBuildFs = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  rm: (path) => rm(path, { recursive: true, force: true }),
};

/** Builds the seeder with `swiftc` + `codesign`, as in the #18796 probe. */
export class SwiftcHealthKitAppBuilder implements HealthKitAppBuilder {
  constructor(
    private readonly exec: ExecFileAsync = execFileAsync,
    /** Caller-owned directory; it is never removed. Without it the builder owns a temp root. */
    private readonly workDir?: string,
    private readonly fs: HealthKitBuildFs = nodeBuildFs,
  ) {}

  async build(): Promise<HealthKitAppBuild> {
    let ownedRoot: string | undefined;
    try {
      let root = this.workDir;
      if (root === undefined) {
        ownedRoot = await this.fs.mkdtemp(join(tmpdir(), "am-hkseeder-"));
        root = ownedRoot;
      }
      const appPath = await this.compile(root);
      return { appPath, dispose: () => this.removeOwnedRoot(ownedRoot) };
    } catch (error) {
      await this.removeOwnedRoot(ownedRoot);
      throw toActionableError(error, "Failed to build the HealthKit seeding app");
    }
  }

  private async compile(root: string): Promise<string> {
    const app = join(root, `${EXECUTABLE}.app`);
    await mkdir(app, { recursive: true });
    const swift = join(root, "App.swift");
    const info = join(root, "Info.plist");
    const ent = join(root, "ent.plist");
    await writeFile(swift, HEALTHKIT_SEEDER_SWIFT);
    await writeFile(info, HEALTHKIT_SEEDER_INFO_PLIST);
    await writeFile(ent, HEALTHKIT_SEEDER_ENTITLEMENTS);
    const sdk = (await this.exec("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"])).stdout
      .toString()
      .trim();
    await this.exec("swiftc", [
      ...["-parse-as-library", "-sdk", sdk, "-target", "arm64-apple-ios17.0-simulator"],
      ...["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__entitlements"],
      ...["-Xlinker", ent, "-o", join(app, EXECUTABLE), swift],
    ]);
    await copyFile(info, join(app, "Info.plist"));
    await this.exec("codesign", ["-f", "-s", "-", app]);
    return app;
  }

  private async removeOwnedRoot(root: string | undefined): Promise<void> {
    if (!root) {
      return;
    }
    try {
      await this.fs.rm(root);
    } catch (error) {
      // Best-effort cleanup: a leftover temp root must not fail or mask the seed result.
      logger.warn(`Failed to remove HealthKit seeder build root ${root}: ${errorMessage(error)}`);
    }
  }
}
