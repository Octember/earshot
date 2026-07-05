import { describe, expect, test } from "bun:test";
import { ReplyStream, type ReplyStreamOpts } from "../src/adapter/reply-stream";
import { FakeAdapter } from "./fakes/fake-adapter";
import type { Logger } from "../src/log";

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeStream(overrides: Partial<ReplyStreamOpts> = {}) {
  const adapter = new FakeAdapter();
  const stream = new ReplyStream({ adapter, venueId: "C1", threadTs: "1.0", recipient: "U1", log: silent, ...overrides });
  return { adapter, stream };
}

// The delivery contract shared by interactive replies and execution reporting: one lazily-opened
// native streamed message, cards buffered until text materializes it, plain-post fallback when no
// stream can start.
describe("ReplyStream", () => {
  test("opens lazily: cards alone never create the message; first text opens it with cards flushed above the words", async () => {
    const { adapter, stream } = makeStream();

    expect(stream.setCards([{ text: "dig in", done: false }])).toBe(true);
    await stream.close();
    expect(adapter.streams).toHaveLength(0); // a cards-only turn never opened (and never notified)

    const id = await stream.post("found it");
    expect(id).not.toBeNull();
    expect(adapter.streams).toHaveLength(1);
    expect(adapter.taskCards).toEqual([{ messageId: id!, id: "item-0", title: "dig in", status: "pending" }]);
    expect(adapter.streams[0]!.text).toBe("found it");
  });

  test("later posts append as separate paragraphs; card updates edit live in place", async () => {
    const { adapter, stream } = makeStream();
    await stream.post("first");
    await stream.post("second");
    expect(adapter.streams[0]!.text).toBe("first\n\nsecond");

    stream.setCards([{ text: "dig in", done: true }]);
    await stream.close();
    expect(adapter.taskCards.at(-1)).toMatchObject({ id: "item-0", status: "complete" });
  });

  test("paceChars splits appended text at word boundaries for streamed-in pacing", async () => {
    const { adapter, stream } = makeStream({ paceChars: 10 });
    await stream.post("aaa bbb ccc ddd");
    const s = adapter.streams[0]!;
    expect(s.appends).toBeGreaterThan(1); // multiple HTTP appends = the pacing
    expect(s.text).toBe("aaa bbb ccc ddd"); // reassembles losslessly
  });

  test("when the stream cannot start, the failure latches: post() resolves null and the caller falls back", async () => {
    const { adapter, stream } = makeStream();
    adapter.failStreams = true;
    expect(await stream.post("hello")).toBeNull();
    expect(await stream.post("again")).toBeNull(); // latched — no retry storm
    expect(stream.opened).toBe(false);
    await stream.close();
    expect(adapter.streams).toHaveLength(0);
  });

  test("no thread or no recipient means no stream — post() resolves null without calling the surface", async () => {
    const noThread = makeStream({ threadTs: null });
    expect(await noThread.stream.post("x")).toBeNull();
    const noRecipient = makeStream({ recipient: null });
    expect(await noRecipient.stream.post("x")).toBeNull();
    expect(noThread.adapter.streams).toHaveLength(0);
    expect(noRecipient.adapter.streams).toHaveLength(0);
  });

  test("setCards reports false when the surface has no native cards, so the caller can fall back", () => {
    const adapter = new FakeAdapter();
    (adapter as { appendTaskUpdate?: unknown }).appendTaskUpdate = undefined;
    const stream = new ReplyStream({ adapter, venueId: "C1", threadTs: "1.0", recipient: "U1", log: silent });
    expect(stream.setCards([{ text: "a", done: false }])).toBe(false);
  });

  test("clearCards drops buffered cards so a failing turn never renders a plan box", async () => {
    const { adapter, stream } = makeStream();
    stream.setCards([{ text: "dig in", done: false }]);
    stream.clearCards();
    await stream.post("couldn't finish that one");
    expect(adapter.taskCards).toHaveLength(0);
  });

  test("settleCards completes unfinished cards (optionally retitled) so a stopped stream shows no error plan", async () => {
    const { adapter, stream } = makeStream();
    await stream.post("pr attached");
    stream.setCards([
      { text: "check ticket", done: true },
      { text: "report when it moves", done: false },
    ]);
    stream.settleCards((item) => `${item.text} — ⏸ parked`);
    await stream.close();
    const last = adapter.taskCards.at(-1)!;
    expect(last).toMatchObject({ id: "item-1", status: "complete" });
    expect(last.title).toBe("report when it moves — ⏸ parked");
    expect(adapter.streams[0]!.stopped).toBe(true);
  });

  test("close drains queued writes before stopping the stream", async () => {
    const { adapter, stream } = makeStream();
    void stream.post("fire-and-forget"); // producer does not await (interactive say())
    await stream.close();
    expect(adapter.streams[0]!.text).toBe("fire-and-forget");
    expect(adapter.streams[0]!.stopped).toBe(true);
  });
});
