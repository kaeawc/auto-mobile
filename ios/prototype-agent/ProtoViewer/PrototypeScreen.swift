import SwiftUI

@MainActor
struct PrototypeScreen: View {
    private enum Action { case relaunch, reset }
    let store: PrototypeLibraryStore
    let entry: PrototypeLibraryEntry
    let networkSwitch: PrototypeLibraryNetworkSwitch
    /// MCP `open` reports success on the first render and failure on any load error or watchdog expiry.
    let onLoaded: @MainActor () -> Void
    let onLoadFailed: @MainActor () -> Void
    @State private var showsSettings = false
    @Environment(\.dismiss) private var dismiss
    @State private var revision = 0
    @State private var rendererActive = false
    @State private var pending: Action?
    @State private var content: PrototypeLibraryContent?
    @State private var storage: URL?
    @State private var error: Error?
    @State private var confirmsReset = false
    @State private var watchdog = PrototypeRenderWatchdog(clock: SystemPrototypeClock())

    private let network: PrototypeNetworkConfiguration

    init(
        store: PrototypeLibraryStore, entry: PrototypeLibraryEntry, networkSwitch: PrototypeLibraryNetworkSwitch,
        onLoaded: @escaping @MainActor () -> Void = {}, onLoadFailed: @escaping @MainActor () -> Void = {}
    ) {
        self.onLoaded = onLoaded
        self.onLoadFailed = onLoadFailed
        self.store = store
        self.entry = entry
        self.networkSwitch = networkSwitch
        #if PROTOVIEWER_ALLOW_CLEARTEXT
            let allowsCleartext = true
        #else
            let allowsCleartext = false
        #endif
        network = PrototypeLibraryNetwork.configuration(networkSwitch: networkSwitch, allowsCleartext: allowsCleartext)
    }

    var body: some View {
        VStack(spacing: 0) {
            if networkSwitch.enabled {
                Label("Network on", systemImage: "network")
                    .font(.footnote)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                    .background(.bar)
            }
            prototypeContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
        }
        .navigationTitle(entry.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Settings", systemImage: "gearshape") { showsSettings = true }
                    Button("Relaunch", systemImage: "arrow.clockwise") { relaunch(.relaunch) }
                    Button("Reset", systemImage: "arrow.counterclockwise", role: .destructive) { confirmsReset = true }
                    Button("Close", systemImage: "xmark") { dismiss() }
                } label: {
                    Label("Prototype actions", systemImage: "ellipsis.circle")
                }
                .disabled(pending != nil)
            }
        }
        .sheet(isPresented: $showsSettings) { LibrarySettingsView(networkSwitch: networkSwitch) }
        .confirmationDialog(
            "Reset stored values for this prototype?",
            isPresented: $confirmsReset,
            titleVisibility: .visible
        ) {
            Button("Reset and relaunch", role: .destructive) { relaunch(.reset) }
        }
        .onAppear(perform: load)
        .onDisappear { watchdog.cancel() }
    }

    private var prototypeContent: some View {
        Group {
            if let error {
                LibraryErrorView(error: error)
            } else if let content, let storage {
                AutoMobilePrototypeView(
                    spec: content.spec, assets: content.assets, storage: .directory(storage), network: network,
                    onDismiss: { _ in dismiss() },
                    onLoadError: {
                        watchdog.cancel()
                        error = $0
                        self.content = nil
                        onLoadFailed()
                    }
                )
                .onFirstRender {
                    watchdog.cancel()
                    onLoaded()
                }
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
    }

    private func relaunch(_ action: Action) {
        pending = action
        watchdog.cancel()
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
        } catch {
            self.error = error
            onLoadFailed()
        }
    }

    private func load() {
        do {
            let loaded = try store.load(entry.libraryId)
            let directory = try store.storageURL(entry.libraryId)
            try store.markOpened(entry.libraryId)
            storage = directory
            rendererActive = true
            content = loaded
            watchdog.start {
                // No first content within the budget: show the error state; Back and Close stay available.
                error = PrototypeLibraryFailure(path: entry.label, message: "Prototype did not render in time")
                content = nil
                onLoadFailed()
            }
        } catch {
            self.error = error
            onLoadFailed()
        }
    }
}
