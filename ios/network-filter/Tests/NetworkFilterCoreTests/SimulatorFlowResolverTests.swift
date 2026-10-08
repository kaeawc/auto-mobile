// swiftlint:disable force_unwrapping
import Foundation
@testable import NetworkFilterCore
import XCTest

final class SimulatorFlowResolverTests: XCTestCase {
    private let otherUDID = "0B9C1F7E-5D3A-4C21-9E8B-7A6F5E4D3C2B"
    private let customDeviceSet = "/private/var/folders/xy/T/automobile-sets/run-1"

    private var table = FakeProcessTable()
    private var defaultSimulator: ManagedSimulator {
        ManagedSimulator(deviceSet: CapturedSimulator.defaultDeviceSet, udid: CapturedSimulator.udid)!
    }

    override func setUp() {
        super.setUp()
        table = FakeProcessTable()
    }

    private func resolve(
        app: Data? = nil,
        process: Data?,
        managed: [ManagedSimulator],
        bundleId: String? = "dev.example.app"
    )
        -> FlowAttribution
    {
        let code = ProbeCodeIdentity(signingIdentifier: bundleId, teamIdentifier: nil, executablePath: nil)
        return SimulatorFlowResolver(processTable: table).resolve(
            sourceApp: app.map { ProbeProcessIdentity(auditToken: $0, code: code) },
            sourceProcess: process.map { ProbeProcessIdentity(auditToken: $0, code: code) },
            managed: Set(managed)
        )
    }

    /// Adds a booted simulator's launchd_sim (child of the host launchd).
    private func addLaunchdSim(pid: Int32, deviceSet: String, udid: String, startTime: UInt64 = 100) {
        table.add(
            pid: pid,
            parent: 1,
            startTime: startTime,
            path: CapturedSimulator.launchdSimPath,
            arguments: CapturedSimulator.launchdSimArguments(deviceSet: deviceSet, udid: udid)
        )
    }

    // MARK: - App processes

    func testAppInDefaultDeviceSetResolvesFromExecutablePath() {
        let path = CapturedSimulator.appExecutable()
        let token = table.add(pid: 501, pidVersion: 7, parent: 400, path: path)
        let result = resolve(process: token, managed: [defaultSimulator])
        XCTAssertEqual(result.attribution, .attributed)
        XCTAssertEqual(result.method, .executablePath)
        XCTAssertEqual(
            result.simulator,
            FlowSimulator(
                udid: CapturedSimulator.udid,
                deviceSet: CapturedSimulator.defaultDeviceSet,
                method: .executablePath
            )
        )
        XCTAssertEqual(
            result.app,
            FlowApp(bundleId: "dev.example.app", executablePath: path, pid: 501, pidVersion: 7)
        )
        XCTAssertNil(result.reason)
    }

    func testAppInCustomDeviceSetResolvesOnlyWhenHostSuppliesThatSet() {
        let token = table.add(
            pid: 502,
            parent: 400,
            path: CapturedSimulator.appExecutable(deviceSet: customDeviceSet, udid: otherUDID)
        )
        let custom = ManagedSimulator(deviceSet: customDeviceSet, udid: otherUDID)!
        XCTAssertEqual(resolve(process: token, managed: [custom]).simulator?.deviceSet, customDeviceSet)
        // The same UDID under the default set is a different simulator.
        let wrongSet = ManagedSimulator(deviceSet: CapturedSimulator.defaultDeviceSet, udid: otherUDID)!
        let result = resolve(process: token, managed: [wrongSet])
        XCTAssertEqual(result.attribution, .unattributed)
        XCTAssertEqual(result.reason, .unmanagedSimulator)
    }

    func testSameBundleOnTwoSimulatorsResolvesToEachUDID() {
        let first = table.add(pid: 510, parent: 400, path: CapturedSimulator.appExecutable())
        let second = table.add(pid: 511, parent: 401, path: CapturedSimulator.appExecutable(udid: otherUDID))
        let other = ManagedSimulator(deviceSet: CapturedSimulator.defaultDeviceSet, udid: otherUDID)!
        let managed = [defaultSimulator, other]
        XCTAssertEqual(resolve(process: first, managed: managed).simulator?.udid, CapturedSimulator.udid)
        XCTAssertEqual(resolve(process: second, managed: managed).simulator?.udid, otherUDID)
        // Only host-managed UDIDs are selectable.
        XCTAssertEqual(resolve(process: second, managed: [defaultSimulator]).reason, .unmanagedSimulator)
    }

    func testLowercaseManagedUDIDMatchesCoreSimulatorDirectory() {
        let token = table.add(pid: 512, parent: 400, path: CapturedSimulator.appExecutable())
        let lowercase = ManagedSimulator(
            deviceSet: CapturedSimulator.defaultDeviceSet + "/",
            udid: CapturedSimulator.udid.lowercased()
        )!
        XCTAssertEqual(resolve(process: token, managed: [lowercase]).attribution, .attributed)
    }

    // MARK: - Process generation

    func testPidReuseWithNewPidVersionIsUnattributed() {
        let old = FakeProcessTable.token(pid: 520, pidVersion: 1)
        let current = table.add(pid: 520, pidVersion: 2, parent: 400, path: CapturedSimulator.appExecutable())
        let stale = resolve(process: old, managed: [defaultSimulator])
        XCTAssertEqual(stale.attribution, .unattributed)
        XCTAssertEqual(stale.reason, .processUnavailable)
        let live = resolve(process: current, managed: [defaultSimulator])
        XCTAssertEqual(live.app?.pid, 520)
        XCTAssertEqual(live.app?.pidVersion, 2)
    }

    func testExitedProcessIsUnattributed() {
        let token = FakeProcessTable.token(pid: 521, pidVersion: 1)
        XCTAssertEqual(resolve(process: token, managed: [defaultSimulator]).reason, .processUnavailable)
    }

    // MARK: - Runtime-hosted helpers

    func testHelperResolvesThroughLaunchdSimAncestor() {
        addLaunchdSim(pid: 400, deviceSet: CapturedSimulator.defaultDeviceSet, udid: CapturedSimulator.udid)
        let token = table.add(pid: 530, parent: 400, path: CapturedSimulator.nsurlsessiondPath)
        let result = resolve(process: token, managed: [defaultSimulator], bundleId: "com.apple.nsurlsessiond")
        XCTAssertEqual(result.attribution, .attributed)
        XCTAssertEqual(result.method, .launchdSimAncestor)
        XCTAssertEqual(result.simulator?.udid, CapturedSimulator.udid)
        XCTAssertEqual(result.simulator?.method, .launchdSimAncestor)
        XCTAssertEqual(result.app?.executablePath, CapturedSimulator.nsurlsessiondPath)
    }

    func testSharedRuntimeHelperOnTwoSimulatorsResolvesPerAncestor() {
        addLaunchdSim(pid: 400, deviceSet: CapturedSimulator.defaultDeviceSet, udid: CapturedSimulator.udid)
        addLaunchdSim(pid: 401, deviceSet: customDeviceSet, udid: otherUDID)
        let webKit = CapturedSimulator.nsurlsessiondPath.replacingOccurrences(
            of: "usr/libexec/nsurlsessiond",
            with: "System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.Networking.xpc/" +
                "com.apple.WebKit.Networking"
        )
        // An intermediate (runningboard-style) parent between helper and launchd_sim.
        table.add(pid: 450, parent: 401, startTime: 200, path: "/RuntimeRoot/usr/libexec/xpcproxy")
        let first = table.add(pid: 531, parent: 400, path: webKit)
        let second = table.add(pid: 532, parent: 450, startTime: 300, path: webKit)
        let custom = ManagedSimulator(deviceSet: customDeviceSet, udid: otherUDID)!
        let managed = [defaultSimulator, custom]
        XCTAssertEqual(resolve(process: first, managed: managed).simulator?.udid, CapturedSimulator.udid)
        XCTAssertEqual(resolve(process: second, managed: managed).simulator?.deviceSet, customDeviceSet)
    }

    func testHelperUnderUnmanagedSimulatorIsUnattributed() {
        addLaunchdSim(pid: 400, deviceSet: CapturedSimulator.defaultDeviceSet, udid: otherUDID)
        let token = table.add(pid: 533, parent: 400, path: CapturedSimulator.nsurlsessiondPath)
        XCTAssertEqual(resolve(process: token, managed: [defaultSimulator]).reason, .unmanagedSimulator)
    }

    func testNativeMacProcessNeverMatches() {
        table.add(
            pid: 300,
            parent: 1,
            startTime: 10,
            path: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"
        )
        let token = table.add(pid: 540, parent: 300, path: "/Applications/Safari.app/Contents/MacOS/Safari")
        let result = resolve(process: token, managed: [defaultSimulator], bundleId: "dev.example.app")
        XCTAssertEqual(result.attribution, .unattributed)
        XCTAssertEqual(result.method, .unattributed)
        XCTAssertEqual(result.reason, .noSimulatorAncestor)
        XCTAssertNil(result.simulator)
        XCTAssertNil(result.app)
    }

    func testParentPidReusedDuringWalkIsUnattributed() {
        addLaunchdSim(pid: 400, deviceSet: CapturedSimulator.defaultDeviceSet, udid: CapturedSimulator.udid)
        let token = table.add(pid: 541, parent: 400, startTime: 1000, path: CapturedSimulator.nsurlsessiondPath)
        // launchd_sim exits and a newer process takes pid 400 before the walk reads it.
        table.replaceOnPIDLookup[400] = FakeProcessTable.Entry(
            record: ProcessRecord(
                pid: 400,
                parentPID: 1,
                startTime: 5000,
                executablePath: CapturedSimulator.launchdSimPath
            ),
            pidVersion: 2,
            arguments: CapturedSimulator.launchdSimArguments()
        )
        XCTAssertEqual(resolve(process: token, managed: [defaultSimulator]).reason, .ancestorLookupFailed)
    }

    func testUnreadableLaunchdSimArgumentsFailOpen() {
        addLaunchdSim(pid: 400, deviceSet: CapturedSimulator.defaultDeviceSet, udid: CapturedSimulator.udid)
        let token = table.add(pid: 542, parent: 400, path: CapturedSimulator.nsurlsessiondPath)
        table.failArgumentLookups = true
        let result = resolve(process: token, managed: [defaultSimulator])
        XCTAssertEqual(result.attribution, .unattributed)
        XCTAssertEqual(result.reason, .ancestorLookupFailed)
    }

    func testMissingParentFailsOpen() {
        let token = table.add(pid: 543, parent: 999, path: CapturedSimulator.nsurlsessiondPath)
        XCTAssertEqual(resolve(process: token, managed: [defaultSimulator]).reason, .ancestorLookupFailed)
    }

    func testParentCycleStopsAtDepthLimit() {
        table.add(pid: 600, parent: 601, startTime: 1, path: "/a")
        table.add(pid: 601, parent: 600, startTime: 1, path: "/b")
        let token = table.add(pid: 602, parent: 600, startTime: 1, path: "/c")
        XCTAssertEqual(resolve(process: token, managed: [defaultSimulator]).reason, .ancestorLookupFailed)
    }

    // MARK: - Delegated flows

    func testDelegatedFlowAttributesThroughSourceApp() {
        addLaunchdSim(pid: 400, deviceSet: CapturedSimulator.defaultDeviceSet, udid: CapturedSimulator.udid)
        let app = table.add(pid: 550, pidVersion: 3, parent: 400, path: CapturedSimulator.appExecutable())
        let helper = table.add(pid: 551, parent: 400, path: CapturedSimulator.nsurlsessiondPath)
        let result = resolve(app: app, process: helper, managed: [defaultSimulator])
        XCTAssertEqual(result.attribution, .attributed)
        XCTAssertEqual(result.method, .executablePath)
        XCTAssertEqual(result.app?.pid, 550)
        XCTAssertEqual(result.app?.pidVersion, 3)
    }

    func testDelegatedFlowWithTokensOnDifferentSimulatorsIsConflicting() {
        addLaunchdSim(pid: 401, deviceSet: CapturedSimulator.defaultDeviceSet, udid: otherUDID)
        let app = table.add(pid: 552, parent: 400, path: CapturedSimulator.appExecutable())
        let helper = table.add(pid: 553, parent: 401, path: CapturedSimulator.nsurlsessiondPath)
        let other = ManagedSimulator(deviceSet: CapturedSimulator.defaultDeviceSet, udid: otherUDID)!
        for managed in [[defaultSimulator, other], [defaultSimulator], [other]] {
            let result = resolve(app: app, process: helper, managed: managed)
            XCTAssertEqual(result.attribution, .conflicting, "managed: \(managed)")
            XCTAssertEqual(result.reason, .conflictingSimulators)
            XCTAssertNil(result.simulator)
            XCTAssertNil(result.app)
        }
    }

    func testDelegatedFlowWithUnresolvedAppIsUnattributed() {
        addLaunchdSim(pid: 400, deviceSet: CapturedSimulator.defaultDeviceSet, udid: CapturedSimulator.udid)
        let exitedApp = FakeProcessTable.token(pid: 554, pidVersion: 1)
        let helper = table.add(pid: 555, parent: 400, path: CapturedSimulator.nsurlsessiondPath)
        let result = resolve(app: exitedApp, process: helper, managed: [defaultSimulator])
        XCTAssertEqual(result.attribution, .unattributed)
        XCTAssertEqual(result.reason, .appUnresolved)
    }

    func testDelegatedFlowWithUnresolvedHelperStillAttributesThroughApp() {
        let app = table.add(pid: 556, parent: 400, path: CapturedSimulator.appExecutable())
        let exitedHelper = FakeProcessTable.token(pid: 557, pidVersion: 1)
        let result = resolve(app: app, process: exitedHelper, managed: [defaultSimulator])
        XCTAssertEqual(result.attribution, .attributed)
        XCTAssertEqual(result.app?.pid, 556)
    }

    // MARK: - Fail open

    func testLookupFailureIsUnattributed() {
        let token = table.add(pid: 560, parent: 400, path: CapturedSimulator.appExecutable())
        table.failTokenLookups = true
        let result = resolve(process: token, managed: [defaultSimulator])
        XCTAssertEqual(result.attribution, .unattributed)
        XCTAssertEqual(result.reason, .processUnavailable)
    }

    func testMalformedOrMissingTokensAreUnattributed() {
        XCTAssertEqual(resolve(process: Data([1, 2]), managed: [defaultSimulator]).reason, .processUnavailable)
        XCTAssertEqual(resolve(process: nil, managed: [defaultSimulator]).reason, .noAuditToken)
    }

    func testNoManagedSimulatorsAttributesNothing() {
        let token = table.add(pid: 561, parent: 400, path: CapturedSimulator.appExecutable())
        XCTAssertEqual(resolve(process: token, managed: []).reason, .unmanagedSimulator)
    }

    // MARK: - Configuration

    func testManagedSimulatorRejectsRelativePathsAndNonUUIDs() {
        XCTAssertNil(ManagedSimulator(deviceSet: "relative/set", udid: CapturedSimulator.udid))
        XCTAssertNil(ManagedSimulator(deviceSet: "/", udid: CapturedSimulator.udid))
        XCTAssertNil(ManagedSimulator(deviceSet: "/a/../b", udid: CapturedSimulator.udid))
        XCTAssertNil(ManagedSimulator(deviceSet: "/a", udid: "booted"))
        XCTAssertThrowsError(try JSONDecoder().decode(
            [ManagedSimulator].self,
            from: Data(#"[{"deviceSet":"/a","udid":"booted"}]"#.utf8)
        ))
    }

    func testManagedArgumentsParsePairsAndCanonicalizeDeviceSets() throws {
        let parsed = try ManagedSimulatorArguments.parse(
            ["--managed", "/tmp/set", CapturedSimulator.udid, "--managed", "/b", otherUDID.lowercased()],
            canonicalize: { $0 == "/tmp/set" ? "/private/tmp/set" : $0 }
        )
        XCTAssertEqual(parsed, [
            ManagedSimulator(deviceSet: "/private/tmp/set", udid: CapturedSimulator.udid)!,
            ManagedSimulator(deviceSet: "/b", udid: otherUDID)!,
        ])
        XCTAssertEqual(try ManagedSimulatorArguments.parse([], canonicalize: { $0 }), [])
    }

    func testManagedArgumentsRejectMalformedInput() {
        let identity: (String) -> String = { $0 }
        XCTAssertThrowsError(try ManagedSimulatorArguments.parse(["--udid", "x"], canonicalize: identity)) {
            XCTAssertEqual($0 as? ManagedSimulatorArgumentError, .unexpectedArgument("--udid"))
        }
        XCTAssertThrowsError(try ManagedSimulatorArguments.parse(["--managed", "/a"], canonicalize: identity)) {
            XCTAssertEqual($0 as? ManagedSimulatorArgumentError, .missingValue)
        }
        XCTAssertThrowsError(try ManagedSimulatorArguments.parse(["--managed", "a", "b"], canonicalize: identity)) {
            XCTAssertEqual($0 as? ManagedSimulatorArgumentError, .invalidSimulator(deviceSet: "a", udid: "b"))
        }
    }
}
