// SPEC §12.2 — outbound delivery with retry: "Outbound posts MUST be retried on transient
// failure with idempotency protection."
//
// Scope note: true idempotency against "the post actually succeeded but our client saw a timeout"
// isn't something Slack's plain chat.postMessage API gives you for free (no idempotency-key
// support) — the RECOMMENDED mitigation is a `checkAlreadyPosted` reconciliation hook the caller
// wires to something like conversations.history before assuming a retry is safe.
import type { PostResult } from "./types";

export interface RetryOpts {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onExhausted?: (error: unknown) => void;
  checkAlreadyPosted?: () => Promise<PostResult | null>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deliverPost(post: () => Promise<PostResult>, opts: RetryOpts): Promise<PostResult | null> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await post();
    } catch (e) {
      lastError = e;
      if (opts.checkAlreadyPosted) {
        const existing = await opts.checkAlreadyPosted();
        if (existing) return existing;
      }
      if (attempt < opts.maxAttempts) {
        const delay = Math.min(opts.backoffMs * 2 ** (attempt - 1), opts.maxBackoffMs ?? Infinity);
        await sleep(delay);
      }
    }
  }
  opts.onExhausted?.(lastError);
  return null;
}
