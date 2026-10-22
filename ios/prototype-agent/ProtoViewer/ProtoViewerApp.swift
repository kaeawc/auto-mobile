import SwiftUI

@main
@MainActor
struct ProtoViewerApp: App {
    private let library: Result<PrototypeLibraryStore, Error>

    init() {
        library = Result {
            let support = try FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
            ).appendingPathComponent("ProtoViewer", isDirectory: true)
            return try PrototypeLibraryStore(
                root: support.appendingPathComponent("library", isDirectory: true),
                storageRoot: support.appendingPathComponent("storage", isDirectory: true)
            )
        }
    }

    var body: some Scene {
        WindowGroup {
            switch library {
            case let .success(store): LibraryView(store: store)
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
