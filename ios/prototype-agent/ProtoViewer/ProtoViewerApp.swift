import OSLog
import SwiftUI

private let libraryLog = Logger(subsystem: "dev.jasonpearson.automobile.protoviewer", category: "library")

@main
@MainActor
struct ProtoViewerApp: App {
    @State private var networkSwitch = PrototypeLibraryNetworkSwitch()
    private let library: Result<(PrototypeLibraryStore, PrototypeLibraryImportService), Error>

    init() {
        library = Result {
            let support = try FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
            ).appendingPathComponent("ProtoViewer", isDirectory: true)
            let root = support.appendingPathComponent("library", isDirectory: true)
            let storage = support.appendingPathComponent("storage", isDirectory: true)
            let inbox = try FileManager.default.url(
                for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true
            ).appendingPathComponent("Inbox", isDirectory: true)
            let store = try PrototypeLibraryStore(root: root, storageRoot: storage)
            PrototypeLibraryStartupCleanup(
                exporter: PrototypeLibraryExporter(store: store), inbox: PrototypeLibraryInbox(root: inbox)
            ).run { libraryLog.error("\($0, privacy: .public)") }
            let imports = PrototypeLibraryImportService(root: root, storageRoot: storage, inbox: inbox) {
                libraryLog.error("\($0, privacy: .public)")
            }
            return (store, imports)
        }
    }

    var body: some Scene {
        WindowGroup {
            switch library {
            case let .success((store, imports)):
                LibraryView(store: store, importService: imports, networkSwitch: networkSwitch)
            case let .failure(error): LibraryErrorView(error: error)
            }
        }
    }
}

struct LibraryErrorView: View {
    let error: Error

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Unable to open prototype").font(.headline)
                if let failure = error as? PrototypeLibraryFailure {
                    Text(failure.path).font(.system(.body, design: .monospaced))
                    Text(failure.message)
                } else {
                    Text(error.localizedDescription)
                }
            }
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
    }
}
