import { describe, expect, test } from "bun:test";
import { deliverPost, deliverTerminalReport } from "../src/adapter/outbound";

function instantSleep() {
  return Promise.resolve();
}

describe("deliverPost (SPEC §12.2 outbound retry)", () => {
  test("succeeds immediately when the post succeeds", async () => {
    let attempts = 0;
    const result = await deliverPost(async () => {
      attempts++;
      return { messageId: "m1" };
    }, { maxAttempts: 3, backoffMs: 1, sleep: instantSleep });

    expect(result).toEqual({ messageId: "m1" });
    expect(attempts).toBe(1);
  });

  test("retries a transient failure and eventually succeeds", async () => {
    let attempts = 0;
    const result = await deliverPost(async () => {
      attempts++;
      if (attempts < 3) throw new Error("rate limited");
      return { messageId: "m1" };
    }, { maxAttempts: 5, backoffMs: 1, sleep: instantSleep });

    expect(result).toEqual({ messageId: "m1" });
    expect(attempts).toBe(3);
  });

  test("gives up after maxAttempts and alerts the caller, returning null (not throwing)", async () => {
    let attempts = 0;
    let alerted: unknown = null;
    const result = await deliverPost(
      async () => {
        attempts++;
        throw new Error("persistent failure");
      },
      { maxAttempts: 3, backoffMs: 1, sleep: instantSleep, onExhausted: (e) => (alerted = e) },
    );

    expect(result).toBeNull();
    expect(attempts).toBe(3);
    expect(alerted).toBeInstanceOf(Error);
  });
});

describe("deliverTerminalReport (SPEC §6.1/§12.3: no dangling threads outranks tidiness)", () => {
  test("retries far more persistently than a plain post before alerting", async () => {
    let attempts = 0;
    let alerted = false;
    const result = await deliverTerminalReport(
      async () => {
        attempts++;
        if (attempts < 8) throw new Error("still down");
        return { messageId: "m1" };
      },
      { backoffMs: 1, sleep: instantSleep, onExhausted: () => (alerted = true) },
    );

    expect(result).toEqual({ messageId: "m1" });
    expect(alerted).toBe(false);
  });

  test("still eventually alerts if delivery never succeeds, without ever claiming a fake success", async () => {
    let alerted = 0;
    const result = await deliverTerminalReport(
      async () => {
        throw new Error("down forever");
      },
      { backoffMs: 1, sleep: instantSleep, onExhausted: () => alerted++ },
    );

    expect(result).toBeNull();
    expect(alerted).toBeGreaterThan(0);
  });

  test("a reconciliation hook can detect an already-delivered post and avoid a duplicate", async () => {
    let postAttempts = 0;
    const result = await deliverTerminalReport(
      async () => {
        postAttempts++;
        throw new Error("timed out waiting for response"); // looks like a failure to us...
      },
      {
        backoffMs: 1,
        sleep: instantSleep,
        // ...but it actually went through — reconciliation finds it and we don't double-post.
        checkAlreadyPosted: async () => ({ messageId: "already-there" }),
      },
    );

    expect(result).toEqual({ messageId: "already-there" });
    expect(postAttempts).toBe(1);
  });
});
