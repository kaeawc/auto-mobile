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
  appId: string;
}

const sameContent = (left: PostedNotificationContent, right: PostedNotificationContent): boolean =>
  left.title === right.title && left.body === right.body;

export class InMemoryPostedNotificationLedger
  implements PostedNotificationRecorder, PostedNotificationLookup
{
  private readonly byDevice = new Map<string, PostedRecord[]>();

  constructor(private readonly maxRecordsPerDevice = MAX_RECORDS_PER_DEVICE) {}

  record(deviceId: string, appId: string, content: PostedNotificationContent): void {
    // The newest post of identical content owns it, so a row repeating another
    // app's earlier text is never attributed to that earlier app.
    const kept = (this.byDevice.get(deviceId) ?? []).filter(
      (record) => !sameContent(record, content),
    );
    const records = [{ appId, title: content.title, body: content.body }, ...kept];
    this.byDevice.set(deviceId, records.slice(0, this.maxRecordsPerDevice));
  }

  postedBy(deviceId: string, appId: string): PostedNotificationContent[] {
    return (this.byDevice.get(deviceId) ?? [])
      .filter((record) => record.appId === appId)
      .map(({ title, body }) => ({ title, body }));
  }
}

export const defaultPostedNotificationLedger = new InMemoryPostedNotificationLedger();
