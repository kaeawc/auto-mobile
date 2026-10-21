import { loadJimp, type JimpConstructor } from "../../../utils/image/loadJimp";
import { JimpBackend } from "../../../utils/image/backend/JimpBackend";
import type { ImageBackend } from "../../../utils/image/backend/ImageBackend";

export interface PrototypeIconInput {
  backgroundColor?: string;
  image?: Buffer;
}

export interface IconRenderer {
  render(input: PrototypeIconInput, sizePx: number): Promise<Buffer>;
}

export class IosPrototypeIconRenderer implements IconRenderer {
  constructor(
    private readonly backend: ImageBackend = new JimpBackend(),
    private readonly jimpLoader: () => Promise<JimpConstructor> = loadJimp,
  ) {}

  async render(input: PrototypeIconInput, sizePx: number): Promise<Buffer> {
    if (input.image) {
      return this.backend.execute(input.image, {
        operations: [{ type: "resize", width: sizePx, height: sizePx, maintainAspectRatio: true }],
        encoding: { mime: "image/png" },
      });
    }
    const color = input.backgroundColor ?? "#2E59BF";
    if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)) {
      throw new Error("Icon backgroundColor must be #RRGGBB or #RRGGBBAA");
    }
    const Jimp = await this.jimpLoader();
    const image = new Jimp({ width: sizePx, height: sizePx, color });
    return image.getBuffer("image/png");
  }
}
