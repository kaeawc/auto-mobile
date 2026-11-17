import Foundation
import UIKit

struct MultiSceneHostLog: Encodable {
    let deviceClass: String
    let status: String
    let sceneIdentifiers: [String]
    let observation: ObservationHostLog
}

@MainActor
enum SdkContractMultiSceneScenario {
    static func run(runId: String) async throws -> MultiSceneHostLog {
        let host = SdkContractObservationScenario.register()
        try await waitUntil { UIApplication.shared.connectedScenes.contains { $0 is UIWindowScene } }
        let isPad = UIDevice.current.userInterfaceIdiom == .pad
        if isPad {
            let previous = Set(UIApplication.shared.connectedScenes.map { $0.session.persistentIdentifier })
            var activationError: Error?
            UIApplication.shared.requestSceneSessionActivation(nil, userActivity: nil, options: nil) {
                activationError = $0
            }
            try await waitUntil {
                activationError != nil || UIApplication.shared.connectedScenes.contains {
                    !previous.contains($0.session.persistentIdentifier) && $0.activationState == .foregroundActive
                }
            }
            if let activationError { throw activationError }
        }
        let ids = UIApplication.shared.connectedScenes.map { $0.session.persistentIdentifier }.sorted()
        let status = isPad ? "complete" : "not-applicable"
        let documents = try FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = documents.appendingPathComponent(SdkContractManifestWriter.directoryName, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(status.utf8).write(to: directory.appendingPathComponent("\(runId).scenes-ready"), options: .atomic)
        try await SdkContractRunner.waitForMarker(
            runId: runId,
            suffix: "actions-done",
            seconds: SdkContractRunner.actionsDoneWaitSeconds,
            orThrow: .harnessNotFinished(seconds: SdkContractRunner.actionsDoneWaitSeconds)
        )
        return MultiSceneHostLog(
            deviceClass: isPad ? "ipad" : "iphone",
            status: status,
            sceneIdentifiers: ids,
            observation: host.log()
        )
    }

    private static func waitUntil(_ ready: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(30)
        while !ready() {
            guard Date() < deadline else { throw SdkContractError.timedOut(seconds: 30) }
            try await Task.sleep(nanoseconds: SdkContractRunner.capturePollNanoseconds)
        }
    }
}
