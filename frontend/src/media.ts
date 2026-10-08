import {
  Input,
  BlobSource,
  ALL_FORMATS,
  CanvasSink,
  EncodedPacketSink,
} from "mediabunny";
import { sha256 } from "@noble/hashes/sha2.js";
import { type Source, uid } from "./domain";
export async function fingerprint(blob: Blob) {
  const h = sha256.create();
  for (let offset = 0; offset < blob.size; offset += 4 * 1024 * 1024)
    h.update(
      new Uint8Array(
        await blob.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer(),
      ),
    );
  return Array.from(h.digest(), (n) => n.toString(16).padStart(2, "0")).join(
    "",
  );
}
export class LocalMedia {
  input: Input;
  sink?: CanvasSink;
  source?: Source;
  queue: Promise<unknown> = Promise.resolve();
  closed = false;
  constructor(public blob: Blob) {
    this.input = new Input({
      source: new BlobSource(blob),
      formats: ALL_FORMATS,
    });
  }
  async inspect(name: string, signal?: AbortSignal): Promise<Source> {
    if (this.blob.size > 256 * 1024 * 1024)
      throw new Error("This clip exceeds the 256 MB import limit.");
    const track = await this.input.getPrimaryVideoTrack();
    if (!track) throw new Error("The file has no readable video stream.");
    if (await track.hasHighDynamicRange())
      throw new Error(
        "HDR footage is not supported yet. Convert the clip to SDR first.",
      );
    const width = await track.getDisplayWidth(),
      height = await track.getDisplayHeight(),
      start = await track.getFirstTimestamp(),
      duration = (await track.computeDuration()) - start;
    if (duration <= 0 || duration > 30)
      throw new Error("Choose a clip up to 30 seconds long.");
    if (width > 4096 || height > 4096)
      throw new Error("Choose a clip with dimensions at most 4096 pixels.");
    const config = await track.getDecoderConfig();
    if (!config || !(await track.canDecode()))
      throw new Error(
        "This browser cannot decode this video codec locally. Use Prepare online for the FFmpeg conversion path.",
      );
    const pts: { time: number; ticks: number }[] = [];
    for await (const packet of new EncodedPacketSink(track).packets(
      undefined,
      undefined,
      { metadataOnly: true },
    )) {
      signal?.throwIfAborted();
      pts.push({ time: packet.timestamp, ticks: packet.microsecondTimestamp });
      if (pts.length > 1800)
        throw new Error("This clip exceeds the 1800 source-frame limit.");
    }
    pts.sort((a, b) => a.time - b.time);
    if (!pts.length)
      throw new Error("The clip has no decoded frame timestamps.");
    const count = Math.max(1, Math.ceil(duration * 30 - 1e-6));
    let j = 0;
    const frames = Array.from({ length: count }, (_, index) => {
      const timestamp = index / 30;
      while (j + 1 < pts.length && pts[j + 1].time <= start + timestamp + 1e-7)
        j++;
      return {
        index,
        timestamp,
        sourceTimestamp: pts[j].time,
        sourcePts: pts[j].ticks,
        timeBase: "1/1000000",
      };
    });
    this.sink = new CanvasSink(track, {
      width: Math.min(480, width),
      poolSize: 2,
    });
    this.source = {
      id: uid(),
      name,
      fingerprint: await fingerprint(this.blob),
      size: this.blob.size,
      width,
      height,
      duration: count / 30,
      fps: 30,
      frames,
      metadata: {
        codec: await track.getCodec(),
        rotation: await track.getRotation(),
        pixelAspectRatio: await track.getPixelAspectRatio(),
        colorSpace: await track.getColorSpace(),
        timing:
          "CFR 30; preceding presented sample; source PTS expressed in integer microseconds",
      },
    };
    signal?.throwIfAborted();
    await this.frame(0);
    return this.source;
  }
  frame(
    index: number,
    signal?: AbortSignal,
  ): Promise<HTMLCanvasElement | OffscreenCanvas> {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        signal?.throwIfAborted();
        if (this.closed || !this.sink || !this.source)
          throw new Error("Media is not ready.");
        const wrapped = await this.sink.getCanvas(
          this.source.frames[index].sourceTimestamp + 1e-7,
        );
        signal?.throwIfAborted();
        if (
          !wrapped ||
          Math.abs(
            wrapped.timestamp - this.source.frames[index].sourceTimestamp,
          ) > 2e-5
        )
          throw new Error(
            "The decoder did not return the requested source frame.",
          );
        return wrapped.canvas;
      });
    this.queue = task;
    return task;
  }
  close() {
    this.closed = true;
    this.input.dispose();
  }
}
