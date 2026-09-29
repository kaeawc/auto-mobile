import type { CtrlProxyNode } from "../../../src/features/observe/ios/types";

// SpringBoard Photos chain and frames recorded in #8060/#8081 verification.
// The second image is the title-area row from the existing runner fixture.
export const springBoardPhotosIcon: CtrlProxyNode = {
  className: "SBIconView",
  text: "Photos",
  clickable: "true",
  role: "button",
  bounds: { left: 120, top: 288, right: 188, bottom: 379 },
  node: [
    {
      className: "UIView",
      bounds: { left: 122, top: 290, right: 186, bottom: 368 },
      node: [
        {
          className: "UIView",
          resourceId: "label-view",
          bounds: { left: 126, top: 357, right: 182, bottom: 377 },
          node: [
            {
              className: "UIView",
              node: [
                {
                  className: "UIImageView",
                  bounds: { left: 109, top: 339, right: 200, bottom: 394 },
                  clickable: "true",
                  role: "image",
                },
                {
                  className: "UIImageView",
                  bounds: { left: 126, top: 357, right: 182, bottom: 377 },
                  clickable: "true",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
