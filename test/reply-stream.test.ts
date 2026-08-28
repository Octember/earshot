import { describe, expect, test } from "bun:test";
import { ReplyStream, type ReplyStreamOpts } from "../src/adapter/reply-stream";
import { FakeAdapter } from "./fakes/fake-adapter";
import type { Logger } from "../src/log";

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeStream(overrides: Partial<ReplyStreamOpts> = {}) {
  const adapter = new FakeAdapter();
  const stream = new ReplyStream({
    adapter,
    venueId: "C1",
    threadTs: "1.0",
    recipient: "U1",
    log: silent,
    ...overrides,
  });
  return { adapter, stream };
}

describe("ReplyStream", () => {
  test("opens lazily on first post", async () => {
    const { adapter, stream } = makeStream();

    const id = await stream.post("found it");
    expect(id).not.toBeNull();
    expect(adapter.streams).toHaveLength(1);
    expect(adapter.streams[0]!.text).toBe("found it");
    await stream.close();
  });

  test("later posts append as separate paragraphs", async () => {
    const { adapter, stream } = makeStream();
    await stream.post("first");
    await stream.post("second");
    expect(adapter.streams[0]!.text).toBe("first\n\nsecond");
    await stream.close();
  });

  test("paceChars splits appended text at word boundaries for streamed-in pacing", async () => {
    const { adapter, stream } = makeStream({ paceChars: 10 });
    await stream.post("aaa bbb ccc ddd");
    const surfaceStream = adapter.streams[0]!;
    expect(surfaceStream.appends).toBeGreaterThan(1);
    expect(surfaceStream.text).toBe("aaa bbb ccc ddd");
    await stream.close();
  });

  test("stream start failure latches; post() returns null for caller fallback", async () => {
    const { adapter, stream } = makeStream();
    adapter.failStreams = true;
    expect(await stream.post("hello")).toBeNull();
    expect(await stream.post("again")).toBeNull();
    expect(stream.opened).toBe(false);
    await stream.close();
    expect(adapter.streams).toHaveLength(0);
  });

  test("no thread/recipient → no stream; post() null without surface call", async () => {
    const noThread = makeStream({ threadTs: null });
    expect(await noThread.stream.post("x")).toBeNull();
    const noRecipient = makeStream({ recipient: null });
    expect(await noRecipient.stream.post("x")).toBeNull();
    expect(noThread.adapter.streams).toHaveLength(0);
    expect(noRecipient.adapter.streams).toHaveLength(0);
  });

  test("close drains queued writes before stopping the stream", async () => {
    const { adapter, stream } = makeStream();
    void stream.post("fire-and-forget");
    await stream.close();
    expect(adapter.streams[0]!.text).toBe("fire-and-forget");
    expect(adapter.streams[0]!.stopped).toBe(true);
  });
});
