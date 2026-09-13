import { describe, expect, test } from "bun:test";
import {
  attributeRowByDumpsys,
  parseDumpsysNotificationRecords,
} from "../../../src/server/system-tray/notificationDumpsys";

const dump = (...lines: string[]): string => lines.join("\n");

const wellbeingRecord = dump(
  "    NotificationRecord(0x1a2b3c: pkg=com.google.android.apps.wellbeing user=UserHandle{0} id=0 tag=Discovery key=0|com.google.android.apps.wellbeing|0|Discovery|10164)",
  "      uid=10164 userId=0",
  "      extras={",
  "        android.title=String (Need better sleep?)",
  "        android.subText=null",
  "        android.showChronometer=Boolean (false)",
  "        android.text=String (Use Bedtime mode to silence your phone and keep the screen dark at bedtime)",
  "        android.template=String (android.app.Notification$BigTextStyle)",
  "      }",
);

describe("dumpsys notification records", () => {
  test("reads the posting package with its title and body from extras", () => {
    expect(parseDumpsysNotificationRecords(wellbeingRecord)).toEqual([
      {
        pkg: "com.google.android.apps.wellbeing",
        titles: ["Need better sleep?"],
        bodies: ["Use Bedtime mode to silence your phone and keep the screen dark at bedtime"],
      },
    ]);
  });

  test("keeps records separate per posting package", () => {
    const records = parseDumpsysNotificationRecords(
      dump(
        wellbeingRecord,
        "    NotificationRecord(0xff00: pkg=com.google.android.apps.messaging user=UserHandle{0} id=1 tag=null key=0|com.google.android.apps.messaging|1|null|10155)",
        "      extras={",
        "        android.title=String ((555) 123-4567)",
        "        android.text=String (Got it, thanks!)",
        "      }",
      ),
    );
    expect(records.map((record) => record.pkg)).toEqual([
      "com.google.android.apps.wellbeing",
      "com.google.android.apps.messaging",
    ]);
    expect(records[1].titles).toEqual(["(555) 123-4567"]);
  });

  test("yields no correlation evidence from a redacted dump", () => {
    expect(
      parseDumpsysNotificationRecords(
        dump(
          "    NotificationRecord(0x1a2b3c: pkg=com.google.android.apps.wellbeing user=UserHandle{0} id=0 tag=Discovery key=0|com.google.android.apps.wellbeing|0|Discovery|10164)",
          "      extras={",
          "        android.title=String [19 chars]",
          "        android.text=String [74 chars]",
          "      }",
        ),
      ),
    ).toEqual([{ pkg: "com.google.android.apps.wellbeing", titles: [], bodies: [] }]);
  });

  test("ignores content-shaped lines outside a record's extras block", () => {
    expect(
      parseDumpsysNotificationRecords(
        dump(
          "  Notification listeners:",
          "    android.title=String (Not a posted notification)",
          "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=0 tag=null key=0|com.example.app|0|null|10100)",
          "      android.text=String (Outside extras)",
          "      extras={",
          "        android.title=String (Inside extras)",
          "      }",
          "      android.text=String (After extras)",
        ),
      ),
    ).toEqual([{ pkg: "com.example.app", titles: ["Inside extras"], bodies: [] }]);
  });

  test("attributes a row whose rendered text matches exactly one package", () => {
    expect(
      attributeRowByDumpsys(
        parseDumpsysNotificationRecords(wellbeingRecord),
        new Set([
          "Need better sleep?",
          "Use Bedtime mode to silence your phone and keep the screen dark at bedtime",
        ]),
      ),
    ).toBe("com.google.android.apps.wellbeing");
  });

  test("requires every populated extras category to be rendered by the row", () => {
    const records = parseDumpsysNotificationRecords(wellbeingRecord);
    expect(attributeRowByDumpsys(records, new Set(["Need better sleep?"]))).toBeNull();
    expect(attributeRowByDumpsys(records, new Set(["Some other notification"]))).toBeNull();
  });

  test("refuses to name an owner when two packages posted identical content", () => {
    const records = parseDumpsysNotificationRecords(
      dump(
        "    NotificationRecord(0x1: pkg=com.example.one user=UserHandle{0} id=0 tag=null key=0|com.example.one|0|null|10100)",
        "      extras={",
        "        android.title=String (Same title)",
        "      }",
        "    NotificationRecord(0x2: pkg=com.example.two user=UserHandle{0} id=0 tag=null key=0|com.example.two|0|null|10101)",
        "      extras={",
        "        android.title=String (Same title)",
        "      }",
      ),
    );
    expect(attributeRowByDumpsys(records, new Set(["Same title"]))).toBeNull();
  });

  test("keeps a row ambiguous when another package's record explains the same text", () => {
    // A collapsed or custom row can render a title without the body its record
    // populated, so the thinner record is not the better candidate: naming it
    // would attribute the other app's row to the requested package (#6875).
    const records = parseDumpsysNotificationRecords(
      dump(
        "    NotificationRecord(0x1: pkg=com.example.requested user=UserHandle{0} id=0 tag=null key=0|com.example.requested|0|null|10100)",
        "      extras={",
        "        android.title=String (Download complete)",
        "      }",
        "    NotificationRecord(0x2: pkg=com.example.other user=UserHandle{0} id=0 tag=null key=0|com.example.other|0|null|10101)",
        "      extras={",
        "        android.title=String (Download complete)",
        "        android.text=String (file.zip)",
        "      }",
      ),
    );
    expect(attributeRowByDumpsys(records, new Set(["Download complete"]))).toBeNull();
  });

  test("still attributes a row when no other package shares its rendered text", () => {
    const records = parseDumpsysNotificationRecords(
      dump(
        wellbeingRecord,
        "    NotificationRecord(0x2: pkg=com.example.other user=UserHandle{0} id=0 tag=null key=0|com.example.other|0|null|10101)",
        "      extras={",
        "        android.title=String (Unrelated)",
        "        android.text=String (Unrelated body)",
        "      }",
      ),
    );
    expect(
      attributeRowByDumpsys(
        records,
        new Set([
          "Need better sleep?",
          "Use Bedtime mode to silence your phone and keep the screen dark at bedtime",
        ]),
      ),
    ).toBe("com.google.android.apps.wellbeing");
  });

  test("drops empty extras values so a title-only row stays matchable", () => {
    // `android.text=String ()` is an empty body; hierarchy extraction never
    // emits empty strings, so keeping it would make the record unmatchable.
    const records = parseDumpsysNotificationRecords(
      dump(
        "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=0 tag=null key=0|com.example.app|0|null|10100)",
        "      extras={",
        "        android.title=String (Sync finished)",
        "        android.text=String ()",
        "        android.subText=String (   )",
        "      }",
      ),
    );
    expect(records).toEqual([{ pkg: "com.example.app", titles: ["Sync finished"], bodies: [] }]);
    expect(attributeRowByDumpsys(records, new Set(["Sync finished"]))).toBe("com.example.app");
  });

  test("does not attribute a row to a record that carries no readable content", () => {
    expect(
      attributeRowByDumpsys(
        [{ pkg: "com.example.app", titles: [], bodies: [] }],
        new Set(["anything"]),
      ),
    ).toBeNull();
  });

  test("reads a CharSequence extra that spans physical lines", () => {
    // `NotificationRecord.dump` prints an embedded newline verbatim, so the
    // closing delimiter lands on a later physical line (#6875).
    expect(
      parseDumpsysNotificationRecords(
        dump(
          "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=0 tag=null key=0|com.example.app|0|null|10100)",
          "      extras={",
          "        android.title=String (Backup)",
          "        android.bigText=String (Line one",
          "Line two)",
          "      }",
        ),
      ),
    ).toEqual([{ pkg: "com.example.app", titles: ["Backup"], bodies: ["Line one\nLine two"] }]);
  });

  test("does not run a multiline value past the end of its record", () => {
    expect(
      parseDumpsysNotificationRecords(
        dump(
          "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=0 tag=null key=0|com.example.app|0|null|10100)",
          "      extras={",
          "        android.text=String (unterminated",
          "      }",
          "    NotificationRecord(0x2: pkg=com.example.other user=UserHandle{0} id=0 tag=null key=0|com.example.other|0|null|10101)",
          "      extras={",
          "        android.title=String (Other)",
          "      }",
        ),
      ),
    ).toEqual([
      { pkg: "com.example.app", titles: [], bodies: [] },
      { pkg: "com.example.other", titles: ["Other"], bodies: [] },
    ]);
  });

  test("keeps a row ambiguous when a record carrying no extras could own it", () => {
    // A header-less custom `RemoteViews` row renders text none of the supported
    // extras carry, so its own record is opaque. Attributing the row to the one
    // package whose extras happen to equal that text names the wrong app.
    const records = parseDumpsysNotificationRecords(
      dump(
        "    NotificationRecord(0x1: pkg=com.actual.custom user=UserHandle{0} id=0 tag=null key=0|com.actual.custom|0|null|10100)",
        "      extras={",
        "        android.template=String (android.app.Notification$DecoratedCustomViewStyle)",
        "      }",
        "    NotificationRecord(0x2: pkg=com.requested user=UserHandle{0} id=0 tag=null key=0|com.requested|0|null|10101)",
        "      extras={",
        "        android.title=String (Syncing)",
        "      }",
      ),
    );
    expect(attributeRowByDumpsys(records, new Set(["Syncing"]))).toBeNull();
  });
});
