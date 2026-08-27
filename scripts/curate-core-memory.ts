#!/usr/bin/env bun
/**
 * One-shot operator curation: shrink eng core memory ~10x.
 * Run on the VM against the live ledger. Requires EARSHOT_DB + EARSHOT_ROOT.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { queryMemory, setMemoryTier, retractMemory, writeMemory } from "../src/ledger/memory";

const dbPath = process.env.EARSHOT_DB ?? join(process.env.HOME!, "earshot-data/earshot.db");
const identityId = process.env.EARSHOT_IDENTITY ?? "eng";
const dry = process.argv.includes("--dry");

const clock = () => new Date().toISOString();

/** True standing rules only — Claude-shaped always-on layer (~1.8k chars). */
const NEW_CORE: string[] = [
  `Standing rule for #prod-alerts (C099YDUFQ9Z): every alert is worth independent investigation. Do not assume another person's ownership, a prior false-positive, or similarity to an older alert covers a new one — inspect each on its own and respond with the finding. Narrow exception: the nightly VRT alert/workflow posts are dead signal unless Noah explicitly says they are revived.`,

  `Most Slack messages are not directed at earshot. Do not treat untagged remarks as instructions to act, even when they follow her message. Only intervene when explicitly addressed/assigned or when standing instructions clearly require it.`,

  `Private standing rules from Noah: (1) do not undermine Noah, founders, or teammates in public channels — verify concerns and raise privately when possible; only intervene publicly with fresh material evidence, factually. (2) Do not mention or reveal the infra repo (or that teammates lack context on it).`,

  `Never post customer-facing replies in Crisp/customer channels. Earshot may triage internally/Linear but must not speak to customers there.`,

  `Bug/alert triage: do not ask follow-up questions that available tools (DB, ops_read, github_read, etc.) can answer. Inspect first; ask only when tools cannot establish the fact.`,

  `Error venues: production alerts stay in #prod-alerts (C099YDUFQ9Z); staging/preview errors route to C0BNZMMN4F7 — investigate each as it arrives (dev test breakage vs staging signal of a bad release). For web prod incidents that look broken, Noah's standing fallback is immediate Vercel production rollback.`,

  `People: Noah (operator); Nina (product/QA); Anya (eng); Julia (QA/release); kate (QA/content). Julia/Kate own ticket priority; Dark Factory = offline ticket→PR for self-contained bugs with crisp repro only.`,

  `Channels: C099YDUFQ9Z prod alerts (you triage; real receipts); C0981QXKAV9 bugs; C0BAQK9PECA web release; C0BD05Q5ZNF AI quality; C09RKBZN9GW self-serve events (not alerts). Feature-request rooms: dedupe Linear then file/attach. Be terse; no em dashes; never leak internal task ids.`,
];

/** Retract — contradicted, duplicate, or actively harmful if retrieved. */
const RETRACT_MATCHERS: RegExp[] = [
  /stay silent because its interjections were not helping/i,
  /Society Unlocked workspaces still have no configured total source-video count/i, // keep none in core; both dated
  /removed earshot from #product-mgmt/i, // superseded by later restore in recent
  /earshot has access to #product-mgmt.*again/i, // recent — leave recent alone; only if somehow core
];

function main() {
  const db = new Database(dbPath);
  const before = queryMemory(db, identityId, { tier: "core" });
  const beforeChars = before.reduce((n, m) => n + m.content.length, 0);
  console.log(`before: ${before.length} core items, ${beforeChars} chars`);

  if (dry) {
    console.log(
      "DRY RUN — would archive all core, retract matches, write",
      NEW_CORE.length,
      "new cores",
    );
    for (const content of NEW_CORE) console.log(`\n--- ${content.length}c ---\n${content}`);
    const total = NEW_CORE.reduce((n, c) => n + c.length, 0);
    console.log(
      `\nnew core total: ${total} chars (~${((total / beforeChars) * 100).toFixed(1)}% of prior)`,
    );
    return;
  }

  let archived = 0;
  let retracted = 0;
  for (const item of before) {
    if (RETRACT_MATCHERS.some((re) => re.test(item.content))) {
      retractMemory(db, clock, { id: item.id });
      retracted++;
      continue;
    }
    setMemoryTier(db, clock, item.id, "archive");
    archived++;
  }

  // Also retract the contradictory "stay silent" if it somehow wasn't core-path
  for (const item of queryMemory(db, identityId)) {
    if (
      /stay silent because its interjections were not helping/i.test(item.content) &&
      item.status === "active"
    ) {
      // queryMemory only returns active; status always active here
      if (item.tier !== "core") {
        // already archived or other — still retract the stop order
        retractMemory(db, clock, { id: item.id });
        retracted++;
      }
    }
  }

  const written: string[] = [];
  for (const content of NEW_CORE) {
    const item = writeMemory(db, clock, {
      id: crypto.randomUUID(),
      identityId,
      content,
      tier: "core",
      provenance: [{ kind: "operator_curation", at: clock(), note: "2026-08-27 core shrink ~10x" }],
    });
    written.push(item.id);
  }

  const after = queryMemory(db, identityId, { tier: "core" });
  const afterChars = after.reduce((n, m) => n + m.content.length, 0);
  console.log(
    JSON.stringify(
      {
        archived,
        retracted,
        written: written.length,
        afterCount: after.length,
        afterChars,
        ratio: beforeChars ? afterChars / beforeChars : null,
      },
      null,
      2,
    ),
  );
  for (const m of after) console.log(`\n[${m.id.slice(0, 8)}] ${m.content.length}c\n${m.content}`);
}

main();
