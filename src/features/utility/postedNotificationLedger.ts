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

const MAX_RECORDS_PER_DEVICE = 100;

interface PostedRecord extends PostedNotificationContent {
  /** Every app that posted this exact content; more than one leaves it unattributed. */
  appIds: ReadonlySet<string>;
}

const sameContent = (left: PostedNotificationContent, right: PostedNotificationContent): boolean =>
  left.title === right.title && left.body === right.body;

export class InMemoryPostedNotificationLedger
  implements PostedNotificationRecorder, PostedNotificationLookup
{
  private readonly byDevice = new Map<string, PostedRecord[]>();

  constructor(private readonly maxRecordsPerDevice = MAX_RECORDS_PER_DEVICE) {}

  record(deviceId: string, appId: string, content: PostedNotificationContent): void {
    const existing = this.byDevice.get(deviceId) ?? [];
    const previous = existing.find((record) => sameContent(record, content));
    // Identical content from two apps proves neither owns a row showing it.
    const appIds = new Set([...(previous?.appIds ?? []), appId]);
    const records = [
      { title: content.title, body: content.body, appIds },
      ...existing.filter((record) => record !== previous),
    ];
    this.byDevice.set(deviceId, records.slice(0, this.maxRecordsPerDevice));
  }

  postedBy(deviceId: string, appId: string): PostedNotificationContent[] {
    return (this.byDevice.get(deviceId) ?? [])
      .filter((record) => record.appIds.size === 1 && record.appIds.has(appId))
      .map(({ title, body }) => ({ title, body }));
  }
}

export const defaultPostedNotificationLedger = new InMemoryPostedNotificationLedger();
