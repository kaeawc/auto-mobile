import type { ViewHierarchyResult } from "../../../src/models";
import { createHierarchyForTest } from "../../features/observe/observeScreenTestBuilders";

/** The Phone field's bounds as the #17463 dogfood observation reported them. */
export const contactsPhoneFieldBounds = { left: 126, top: 1862, right: 954, bottom: 2030 };

/**
 * Google Contacts "Create contact" form (#17463), rebuilt from the issue's observation: the
 * Phone field shows its "+1" prefix as text and is named only by its hint "Phone (Mobile)",
 * which observe projects as `{label: "+1", sublabel: "Phone (Mobile)"}`. The section icon whose
 * description is "Phone" is the kind of non-editable node that makes a "Phone" text selector
 * match before the editable-hint tier is consulted. The Last name field is filled.
 */
export function contactsCreateContactHierarchy(): ViewHierarchyResult {
  return createHierarchyForTest({
    hierarchy: {
      node: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        class: "android.widget.FrameLayout",
        node: [
          {
            bounds: { left: 126, top: 1340, right: 954, bottom: 1508 },
            class: "android.widget.EditText",
            "resource-id": "first_name",
            text: "Ada",
            "hint-text": "First name",
            focusable: true,
            clickable: true,
            "long-clickable": true,
          },
          {
            bounds: { left: 126, top: 1560, right: 954, bottom: 1728 },
            class: "android.widget.EditText",
            "resource-id": "last_name",
            text: "Lovelace",
            "hint-text": "Last name",
            focusable: true,
            focused: true,
            clickable: true,
            "long-clickable": true,
          },
          {
            bounds: { left: 30, top: 1900, right: 96, bottom: 1966 },
            class: "android.widget.ImageView",
            "content-desc": "Phone",
          },
          {
            bounds: contactsPhoneFieldBounds,
            class: "android.widget.EditText",
            text: "+1",
            "hint-text": "Phone (Mobile)",
            focusable: true,
            clickable: true,
            "long-clickable": true,
          },
        ],
      },
    },
  });
}
