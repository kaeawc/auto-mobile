import SwiftUI

@MainActor
struct PrototypeScreen: View {
    private enum Action { case relaunch, reset }
    let store: PrototypeLibraryStore
    let entry: PrototypeLibraryEntry
    @Environment(\.dismiss) private var dismiss
    @State private var revision = 0
    @State private var rendererActive = false
    @State private var pending: Action?
    @State private var content: PrototypeLibraryContent?
    @State private var storage: URL?
    @State private var error: Error?
    @State private var confirmsReset = false

    private var network: PrototypeNetworkConfiguration {
        PrototypeNetworkConfiguration(
            deviceClient: { _ in throw NetworkDisabled() },
            hostHandler: { _ in throw NetworkDisabled() }
        )
    }

    var body: some View {
        Group {
            if let error {
                LibraryErrorView(error: error)
            } else if let content, let storage {
                AutoMobilePrototypeView(
                    spec: content.spec, assets: content.assets, storage: .directory(storage), network: network,
                    onDismiss: { _ in dismiss() },
                    onLoadError: {
                        error = $0
                        self.content = nil
                    }
                )
                .onStopped {
                    PrototypeAssetRegistrar.releaseProcessFonts()
                    rendererActive = false
                    finishRelaunch()
                }
                .id(revision)
            } else {
                ProgressView()
            }
        }
        .navigationTitle(entry.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Relaunch", systemImage: "arrow.clockwise") { relaunch(.relaunch) }
                    Button("Reset", systemImage: "arrow.counterclockwise", role: .destructive) { confirmsReset = true }
                    Button("Close", systemImage: "xmark") { dismiss() }
                } label: { Label("Prototype actions", systemImage: "ellipsis.circle") }
                    .disabled(pending != nil)
            }
        }
        .confirmationDialog(
            "Reset stored values for this prototype?",
            isPresented: $confirmsReset,
            titleVisibility: .visible
        ) {
            Button("Reset and relaunch", role: .destructive) { relaunch(.reset) }
        }
        .onAppear(perform: load)
    }

    private func relaunch(_ action: Action) {
        pending = action
        content = nil // Unmount first; the renderer's onStopped callback follows its final flush.
        if !rendererActive { finishRelaunch() }
    }

    private func finishRelaunch() {
        guard let action = pending else { return }
        pending = nil
        do {
            if action == .reset { try store.resetStorage(entry.libraryId) }
            revision += 1
            error = nil
            load()
        } catch { self.error = error }
    }

    private func load() {
        do {
            let loaded = try store.load(entry.libraryId)
            let directory = try store.storageURL(entry.libraryId)
            try store.markOpened(entry.libraryId)
            storage = directory
            rendererActive = true
            content = loaded
        } catch { self.error = error }
    }
}

private struct NetworkDisabled: Error, LocalizedError {
    var errorDescription: String? { "Network is disabled for imported prototypes" }
}
