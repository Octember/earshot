// SPEC §12.2, §12.3 — outbound delivery with retry. §12.2: "Outbound posts MUST be retried on
// transient failure with idempotity protection." §12.3: "Outbound failure of a terminal report
// MUST be retried until delivered or operator-alerted — the no-dangling-threads invariant
// outranks tidiness."
//
// Scope note: true idempotency against "the post actually succeeded but our client saw a timeout"
// isn't something Slack's plain chat.postMessage API gives you for free (no idempotency-key
// support) — the RECOMMENDED mitigation is a `checkAlreadyPosted` reconciliation hook the caller
// wires to something like conversations.history before assuming a retry is safe. Similarly,
// deliverTerminalReport retries generously (many more attempts, longer backoff ceiling) rather
// than literally forever — an unbounded in-process retry loop would starve everything else this
// process needs to do; a persistent failure alerts the operator instead of blocking forever.
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

// ~2 minutes of retrying total. Deliberately UNDER the turn stall watchdog (stall_timeout_ms,
// default 5 min): the report posts from inside a tool call, and out-waiting the watchdog would
// fail the execution AROUND the report — losing exactly what the retries exist to save.
const TERMINAL_REPORT_MAX_ATTEMPTS = 8;
const TERMINAL_REPORT_MAX_BACKOFF_MS = 60_000;

// SPEC §6.1 "no dangling threads" — a terminal report gets many more attempts than a plain post,
// with backoff capped so it keeps trying rather than escalating the delay forever.
export function deliverTerminalReport(
  post: () => Promise<PostResult>,
  opts: Omit<RetryOpts, "maxAttempts" | "maxBackoffMs"> & { maxAttempts?: number; maxBackoffMs?: number },
): Promise<PostResult | null> {
  return deliverPost(post, {
    maxAttempts: opts.maxAttempts ?? TERMINAL_REPORT_MAX_ATTEMPTS,
    backoffMs: opts.backoffMs,
    maxBackoffMs: opts.maxBackoffMs ?? TERMINAL_REPORT_MAX_BACKOFF_MS,
    sleep: opts.sleep,
    onExhausted: opts.onExhausted,
    checkAlreadyPosted: opts.checkAlreadyPosted,
  });
}
