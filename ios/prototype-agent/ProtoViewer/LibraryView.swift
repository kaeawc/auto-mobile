import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct LibraryView: View {
    let store: PrototypeLibraryStore
    let importService: PrototypeLibraryImportService
    let mcpInbox: PrototypeMcpInbox
    let networkSwitch: PrototypeLibraryNetworkSwitch
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var navigation = PrototypeLibraryNavigation()
    @State private var mcpOpen: PrototypeMcpRequest?
    @State private var showsSettings = false
    @State private var importCount = 0
    @State private var entries: [PrototypeLibraryEntry] = []
    @State private var skippedCount = 0
    @State private var error: Error?
    @State private var actionError: String?
    @State private var showsError = false
    @State private var importsFile = false
    @State private var deletion: PrototypeLibraryEntry?
    @State private var confirmsDelete = false
    @State private var export: PrototypeLibraryExport?
    @State private var confirmsShare = false
    @State private var sharesFile = false

    var body: some View {
        // One NavigationSplitView at every width: regular shows library and prototype side by side, compact
        // collapses to the phone stack, and the selection (and so the open prototype) survives a switch.
        NavigationSplitView {
            sidebar
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showsSettings) { LibrarySettingsView(networkSwitch: networkSwitch) }
        .onAppear(perform: refresh)
        .fileImporter(isPresented: $importsFile, allowedContentTypes: [
            UTType(exportedAs: "dev.jasonpearson.automobile.prototype"), .json,
        ]) { result in
            switch result {
            case let .success(url): receive(url, source: .file)
            case let .failure(error): report(error)
            }
        }
        .onOpenURL(perform: receiveURL)
        .alert("Prototype operation failed", isPresented: $showsError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? String(
                localized: "Unknown error",
                comment: "Fallback when a library operation fails without details."
            ))
        }
        .confirmationDialog(
            String(
                localized: "Delete \(deletionLabel)?",
                comment: "Delete confirmation title; placeholder is the prototype name."
            ),
            isPresented: $confirmsDelete,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) { delete() }
            Button("Cancel", role: .cancel) { deletion = nil }
        } message: {
            Text("The prototype and its stored values will be removed.")
        }
        .confirmationDialog("Share prototype?", isPresented: $confirmsShare, titleVisibility: .visible) {
            Button("Share", systemImage: "square.and.arrow.up") { sharesFile = true }
            Button("Cancel", role: .cancel) { finishExport() }
        } message: {
            Text(preflightMessage)
        }
        .onChange(of: confirmsShare) { _, visible in
            if !visible, !sharesFile { finishExport() }
        }
        .sheet(isPresented: $sharesFile, onDismiss: finishExport) {
            if let export {
                PrototypeShareSheet(url: export.url) { error in
                    sharesFile = false
                    if let error { report(error) }
                }
            }
        }
    }

    private var sidebar: some View {
        Group {
            if let error {
                LibraryErrorView(error: error)
            } else if entries.isEmpty {
                ContentUnavailableView(
                    "No prototypes",
                    systemImage: "tray",
                    description: Text("Imported prototypes appear here.")
                )
            } else {
                List(selection: $navigation.selection) {
                    ForEach(entries) { entry in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(entry.label).font(.headline)
                            let layout = dynamicTypeSize.isAccessibilitySize
                                ? AnyLayout(VStackLayout(alignment: .leading))
                                : AnyLayout(HStackLayout())
                            layout {
                                Text(
                                    Date(timeIntervalSince1970: Double(entry.lastOpenedAt) / 1000),
                                    style: .relative
                                )
                                Text("Imported").font(.caption).padding(.horizontal, 6)
                                    .background(.quaternary, in: Capsule())
                            }
                            .foregroundStyle(.secondary)
                        }
                        .tag(PrototypeLibraryDestination.entry(entry))
                        .accessibilityElement(children: .combine)
                        .swipeActions(allowsFullSwipe: false) { actions(entry) }
                        .contextMenu { actions(entry) }
                    }
                    if skippedCount > 0 {
                        Text("\(skippedCount) unavailable entries skipped").foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("ProtoViewer")
        .navigationSplitViewColumnWidth(
            min: ProtoViewerWidthClass.sidebarWidth.min,
            ideal: ProtoViewerWidthClass.sidebarWidth.ideal,
            max: ProtoViewerWidthClass.sidebarWidth.max
        )
        .disabled(importCount > 0)
        .overlay {
            if importCount > 0 { ProgressView("Importing prototype…").padding().background(.regularMaterial) }
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Settings", systemImage: "gearshape") { showsSettings = true }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Import", systemImage: "square.and.arrow.down") { importsFile = true }
                    .disabled(importCount > 0)
            }
        }
    }

    @ViewBuilder private var detail: some View {
        switch navigation.selection {
        case nil:
            // Only visible at regular width; compact shows the library until a row is chosen.
            ContentUnavailableView(
                "Select a prototype",
                systemImage: "rectangle.on.rectangle",
                description: Text("Choose a prototype from the library to open it.")
            )
        case let .entry(entry):
            PrototypeScreen(store: store, entry: entry, networkSwitch: networkSwitch, onClose: closePrototype)
                .id(PrototypeLibraryDestination.entry(entry).id)
        case let .mcp(entry, command):
            PrototypeScreen(store: store, entry: entry, networkSwitch: networkSwitch, onLoaded: {
                reportMcpOpen(command, entry: entry, success: true)
            }, onLoadFailed: {
                reportMcpOpen(command, entry: entry, success: false)
            }, onClose: closePrototype)
                .id(PrototypeLibraryDestination.mcp(entry: entry, command: command).id)
                .onDisappear { reportMcpOpen(command, entry: entry, success: false) }
        }
    }

    private func closePrototype() {
        navigation.close()
    }

    private var deletionLabel: String {
        deletion?.label ?? String(localized: "prototype", comment: "Fallback name in the delete confirmation.")
    }

    private var exporter: PrototypeLibraryExporter { PrototypeLibraryExporter(store: store) }

    private var preflightMessage: String {
        guard let export, !export.warnings.isEmpty else {
            return String(
                localized: "Shares the spec and its referenced assets. Stored values and library metadata are excluded.",
                comment: "Share confirmation describing exported contents."
            )
        }
        let details = export.warnings.map { "\($0.code.rawValue): \($0.path)" }.joined(separator: "\n")
        return String(
            localized: "This spec may contain credentials or private addresses. Review before sharing.\n\(details)",
            comment: "Share warning; placeholder contains technical warning codes and paths."
        )
    }

    @ViewBuilder
    private func actions(_ entry: PrototypeLibraryEntry) -> some View {
        Button("Share", systemImage: "square.and.arrow.up") { prepareExport(entry) }
        Button("Delete", systemImage: "trash", role: .destructive) {
            deletion = entry
            confirmsDelete = true
        }
    }

    private func receiveURL(_ url: URL) {
        guard url.scheme?.lowercased() == "automobile-proto" else { receive(url, source: .share); return }
        // Even malformed MCP URLs are consumed: they must never enter the share-file alert path.
        guard let command = PrototypeMcpRequest.parse(url) else {
            libraryLog.warning("Ignoring MCP URL with unusable request id")
            return
        }
        Task {
            if let entry = await mcpInbox.handle(command, screen: ForegroundScreen.pixels()) {
                // Swap before awaiting: overlapping opens each supersede exactly one predecessor.
                let previous = mcpOpen
                mcpOpen = command
                navigation.openMcp(entry, command: command)
                if let previous { await mcpInbox.reportOpenFailed(previous) }
            }
            refresh()
        }
    }

    private func reportMcpOpen(_ command: PrototypeMcpRequest, entry: PrototypeLibraryEntry, success: Bool) {
        guard mcpOpen == command else { return }
        mcpOpen = nil
        Task {
            if success { await mcpInbox.reportOpened(command, entry: entry, screen: ForegroundScreen.pixels()) }
            else { await mcpInbox.reportOpenFailed(command) }
        }
    }

    private func receive(_ url: URL, source: PrototypeLibraryImporter.Source) {
        let scoped = url.startAccessingSecurityScopedResource()
        importCount += 1
        Task {
            defer {
                if scoped { url.stopAccessingSecurityScopedResource() }
                importCount -= 1
            }
            do {
                try await importService.importFile(url, source: source)
                refresh()
            } catch is CancellationError {
                refresh()
            } catch { report(error) }
        }
    }

    private func prepareExport(_ entry: PrototypeLibraryEntry) {
        do {
            try exporter.prepareExport(entry.libraryId, pending: &export)
            confirmsShare = true
        } catch { report(error) }
    }

    private func finishExport() {
        guard let export else { return }
        do {
            try exporter.cleanup(export)
            self.export = nil
        } catch { report(error) }
    }

    private func delete() {
        guard let deletion else { return }
        do {
            try store.delete(deletion.libraryId)
            navigation.didDelete(libraryId: deletion.libraryId)
        } catch { report(error) }
        self.deletion = nil
        refresh()
    }

    private func report(_ error: Error) {
        actionError = error.localizedDescription
        showsError = true
    }

    private func refresh() {
        do {
            let listing = try store.list()
            entries = listing.entries
            skippedCount = listing.skippedCount
            error = nil
        } catch { self.error = error }
    }
}
