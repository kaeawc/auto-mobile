import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";

/** Representative Playground Forms & Input screen with empty iOS text fields. */
const iosFormsEmptyFields: ViewHierarchyResult = {
  hierarchy: {
    node: {
      $: { class: "XCUIElementTypeApplication" },
      node: [
        {
          $: {
            class: "UITextField",
            role: "textfield",
            "resource-id": "name-field",
            "hint-text": "Name",
            actions: ["set_text"],
            clickable: true,
          },
          bounds: { left: 20, top: 100, right: 373, bottom: 150 },
          node: [
            {
              $: { class: "UITextFieldLabel", text: "Name" },
              bounds: { left: 30, top: 110, right: 80, bottom: 140 },
            },
          ],
        },
        {
          $: {
            class: "UITextField",
            role: "textfield",
            "resource-id": "email-field",
            "hint-text": "Email",
            actions: ["set_text"],
            clickable: true,
          },
          bounds: { left: 20, top: 170, right: 373, bottom: 220 },
          node: [
            {
              $: { class: "UITextFieldLabel", text: "Email" },
              bounds: { left: 30, top: 180, right: 80, bottom: 210 },
            },
          ],
        },
      ],
    },
  },
  screenWidth: 393,
  screenHeight: 852,
};

export default iosFormsEmptyFields;
