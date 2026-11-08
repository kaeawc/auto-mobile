/**
 * The notifications this process posted with `postNotification` on iOS/watchOS, by
 * device. An iOS lone banner names no app, so systemTray attributes such a row to
 * an app only when that app posted the row's content here (#17445).
 */

export interface PostedNotificationContent {
  title: string;
  body: string;
}

export interface PostedNotificationRecorder {
  record(deviceId: string, appId: string, content: PostedNotificationContent): void;
}

export interface PostedNotificationLookup {
  /** The content the app most recently posted to the device, newest first. */
  postedBy(deviceId: string, appId: string): PostedNotificationContent[];
}

interface PostedRecord extends PostedNotificationContent {
  /** Every app that posted this exact content; more than one leaves it unattributed. */
  appIds: ReadonlySet<string>;
}

// A post is a deliberate tool call, so the ledger keeps every distinct content it
// has seen: forgetting one would let a later identical post from another app look
// unambiguous while the first app's banner is still in the tray.
const contentKey = ({ title, body }: PostedNotificationContent): string =>
  JSON.stringify([title, body]);

export class InMemoryPostedNotificationLedger
  implements PostedNotificationRecorder, PostedNotificationLookup
{
  private readonly byDevice = new Map<string, Map<string, PostedRecord>>();

  record(deviceId: string, appId: string, content: PostedNotificationContent): void {
    const records = this.byDevice.get(deviceId) ?? new Map<string, PostedRecord>();
    const key = contentKey(content);
    const previous = records.get(key);
    // Identical content from two apps proves neither owns a row showing it.
    const appIds = new Set([...(previous?.appIds ?? []), appId]);
    records.delete(key);
    records.set(key, { title: content.title, body: content.body, appIds });
    this.byDevice.set(deviceId, records);
  }

  postedBy(deviceId: string, appId: string): PostedNotificationContent[] {
    return [...(this.byDevice.get(deviceId)?.values() ?? [])]
      .reverse()
      .filter((record) => record.appIds.size === 1 && record.appIds.has(appId))
      .map(({ title, body }) => ({ title, body }));
  }
}

export const defaultPostedNotificationLedger = new InMemoryPostedNotificationLedger();
