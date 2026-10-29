import AutoMobileSDK
import Foundation

/// Runs the launch-requested SDK contract scenario once and always writes its manifest, so
/// the harness can tell a fixture-host failure from an SDK or transport disagreement.
enum SdkContractRunner {
    static let networkScenario = "network"
    static let faultScenario = "faults"
    static let capabilityScenario = "capabilities"
    static let scenarioTimeoutSeconds: UInt64 = 30
    /// How long the fault scenario waits for the harness to install its rules through CtrlProxy.
    static let rulesReadyWaitSeconds: Double = 60
    /// The SDK buffer flushes every 500 ms; allow several flushes before giving up.
    static let captureWaitSeconds: Double = 10
    static let capturePollNanoseconds: UInt64 = 100_000_000

    static func startIfRequested(environment: [String: String] = ProcessInfo.processInfo.environment) {
        guard let launch = SdkContractLaunch.from(environment: environment) else { return }
        Task.detached {
            await SdkContractRunner.run(launch)
        }
    }

    static func run(_ launch: SdkContractLaunch) async {
        var manifest = SdkContractManifest(runId: launch.runId, scenario: launch.scenario)
        let tap = SdkContractBatchTap(belongsToRun: SdkContractBatchTap.networkEvents(forRun: launch.runId))
        tap.start()
        defer { tap.stop() }
        let server = SdkContractLoopbackServer()
        defer { server.stop() }
        do {
            AutoMobileNetwork.shared.setEnabled(true)
            AutoMobileNetwork.shared.setCaptureHeaders(true)
            AutoMobileNetwork.shared.setCaptureBodies(true)
            try await runScenario(launch, server: server, into: &manifest)
            // Fewer captured events than expected is a finding for the harness to attribute,
            // not a fixture failure, so the run still completes.
            let expectedCount = manifest.network.count + manifest.faults.count
            let captured = await waitForCapture(tap, expectedCount: expectedCount)
            manifest.bundleId = captured.bundleId
            manifest.events = captured.events
            manifest.undecodableBatches = captured.undecodableBatches
            manifest.status = .complete
        } catch {
            let serverLog = server.eventLog().joined(separator: "; ")
            let serverDetail = serverLog.isEmpty ? "no events" : serverLog
            manifest.failure = "\(SdkContractError.describe(error)) | server: \(serverDetail)"
            manifest.status = .failed
        }
        do {
            try SdkContractManifestWriter.write(manifest)
            let status = manifest.status.rawValue
            AutoMobileLog.shared.i(
                "SdkContract",
                "manifest_written run=\(launch.runId) status=\(status) events=\(manifest.events.count)"
            )
        } catch {
            AutoMobileLog.shared.e(
                "SdkContract",
                "manifest_write_failed run=\(launch.runId) error=\(error.localizedDescription)"
            )
        }
    }

    private static func runScenario(
        _ launch: SdkContractLaunch,
        server: SdkContractLoopbackServer,
        into manifest: inout SdkContractManifest
    ) async throws {
        let runId = launch.runId
        switch launch.scenario {
        case networkScenario:
            manifest.network = try await withTimeout(seconds: scenarioTimeoutSeconds) {
                let ports = try await server.start()
                return try await SdkContractNetworkScenario(runId: runId, ports: ports).run()
            }
        case capabilityScenario:
            manifest.capabilities = SdkContractCapabilityScenario.run()
        case faultScenario:
            try await waitForRulesReady(runId: runId)
            manifest.faults = try await withTimeout(seconds: scenarioTimeoutSeconds) {
                let ports = try await server.start()
                return try await SdkContractFaultScenario(runId: runId, ports: ports).run()
            }
        default:
            throw SdkContractError.unknownScenario(launch.scenario)
        }
    }

    /// The harness writes `<runId>.rules-ready` next to the manifest once CtrlProxy has delivered
    /// the fault rules to the SDK, so no case runs before its rule exists.
    private static func waitForRulesReady(runId: String, fileManager: FileManager = .default) async throws {
        let documents = try fileManager.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let marker = documents
            .appendingPathComponent(SdkContractManifestWriter.directoryName, isDirectory: true)
            .appendingPathComponent("\(runId).rules-ready")
        let deadline = Date().addingTimeInterval(rulesReadyWaitSeconds)
        while !fileManager.fileExists(atPath: marker.path) {
            guard Date() < deadline else {
                throw SdkContractError.rulesNotInstalled(seconds: rulesReadyWaitSeconds)
            }
            try await Task.sleep(nanoseconds: capturePollNanoseconds)
        }
    }

    private static func waitForCapture(
        _ tap: SdkContractBatchTap,
        expectedCount: Int
    ) async
        -> SdkContractBatchTap.Snapshot
    {
        let deadline = Date().addingTimeInterval(captureWaitSeconds)
        var snapshot = tap.snapshot()
        while snapshot.events.count < expectedCount, Date() < deadline {
            try? await Task.sleep(nanoseconds: capturePollNanoseconds)
            snapshot = tap.snapshot()
        }
        return snapshot
    }

    private static func withTimeout<T: Sendable>(
        seconds: UInt64,
        _ body: @escaping @Sendable () async throws -> T
    ) async throws
        -> T
    {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask {
                try await body()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: seconds * 1_000_000_000)
                throw SdkContractError.timedOut(seconds: seconds)
            }
            defer { group.cancelAll() }
            guard let result = try await group.next() else {
                throw SdkContractError.timedOut(seconds: seconds)
            }
            return result
        }
    }
}
