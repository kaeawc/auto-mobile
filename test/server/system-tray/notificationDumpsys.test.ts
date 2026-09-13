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

  test("does not attribute a row to a record that carries no readable content", () => {
    expect(
      attributeRowByDumpsys(
        [{ pkg: "com.example.app", titles: [], bodies: [] }],
        new Set(["anything"]),
      ),
    ).toBeNull();
  });
});
