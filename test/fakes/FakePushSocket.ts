import type { Socket } from "node:net";
import { FakeSocket } from "./FakeNetServer";

type FakePushSocketContract = Pick<Socket, "write" | "writableLength" | "destroyed">;

/** Socket buffer accounting with explicit reader progress, without real I/O. */
export class FakePushSocket<Response = Record<string, unknown>>
  extends FakeSocket<Response>
  implements FakePushSocketContract
{
  bufferedBytes = 0;
  totalBytesWritten = 0;

  constructor() {
    super();
    Object.defineProperty(this, "writableLength", { get: () => this.bufferedBytes });
    this.onWrite = (frame) => {
      const bytes = Buffer.byteLength(frame);
      this.totalBytesWritten += bytes;
      if (!this.writeReturnValue) {
        this.bufferedBytes += bytes;
      }
    };
  }

  drain(keepStalling = false): void {
    this.bufferedBytes = 0;
    this.writeReturnValue = !keepStalling;
    this.emit("drain");
  }
}
