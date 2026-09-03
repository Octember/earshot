// Outbound delivery with retry; optional checkAlreadyPosted for timeout-vs-success reconciliation.
import type { PostResult } from "@bevyl-ai/agent-tools";

interface RetryOpts {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onExhausted?: (error: unknown) => void;
  checkAlreadyPosted?: () => Promise<PostResult | null>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function deliverPost(
  post: () => Promise<PostResult>,
  opts: RetryOpts,
): Promise<PostResult | null> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await post();
    } catch (error) {
      lastError = error;
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
