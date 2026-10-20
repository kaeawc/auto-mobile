type ResourceUpdateNotifier = (uris: string[]) => Promise<void>;

let notifier: ResourceUpdateNotifier = async () => {};

/** The server supplies delivery; daemon recording state also runs without an MCP registry. */
export function registerResourceUpdateNotifier(next: ResourceUpdateNotifier): () => void {
  const previous = notifier;
  notifier = next;
  return () => {
    notifier = previous;
  };
}

export function notifyResourcesUpdated(uris: string[]): Promise<void> {
  return notifier(uris);
}
