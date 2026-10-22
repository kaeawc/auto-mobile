import SwiftUI

@MainActor
struct LibraryView: View {
    let store: PrototypeLibraryStore
    @State private var entries: [PrototypeLibraryEntry] = []
    @State private var skippedCount = 0
    @State private var error: Error?

    var body: some View {
        NavigationStack {
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
                    List {
                        ForEach(entries) { entry in
                            NavigationLink(value: entry) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(entry.label).font(.headline)
                                    HStack {
                                        Text(
                                            Date(timeIntervalSince1970: Double(entry.lastOpenedAt) / 1000),
                                            style: .relative
                                        )
                                        Text("Imported").font(.caption).padding(.horizontal, 6)
                                            .background(.quaternary, in: Capsule())
                                    }
                                    .foregroundStyle(.secondary)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                        if skippedCount > 0 {
                            Text("\(skippedCount) unavailable entries skipped").foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("ProtoViewer")
            .onAppear(perform: refresh)
            .navigationDestination(for: PrototypeLibraryEntry.self) { entry in
                PrototypeScreen(store: store, entry: entry)
            }
        }
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
