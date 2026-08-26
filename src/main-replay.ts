import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "./ledger/db";
import { createLogger } from "./log";
import { isRecord } from "./guard";
import { makeStore } from "./main-config";
import { makeCodexSessionFactory } from "./main-codex";

export const REPLAY_HELP = `earshot replay — relive a recorded incident with real model calls, captured room.

usage:
  earshot replay --db <snapshot.db> --from <iso> --to <iso> [--venue C…] [--speed N]

The snapshot is COPIED into the workspace and rewound to the window start; the original file is
never touched. Inbound messages replay at recorded pacing (--speed N compresses gaps N-fold;
speed 1 is truest to mid-turn races). Replies, reactions, and external tool calls are captured
and printed against what she originally did — nothing reaches Slack, Linear, GitHub, or Notion.

needs: codex logged in, EARSHOT_POLICY (or ./policy.yaml), and the workspace dirs codex-trusted.
  --db         path to a ledger snapshot (scp it from the live box first)
  --from/--to  ISO-8601 UTC window bounds, e.g. 2026-07-23T12:00:00Z
  --venue      only replay messages from one venue id
  --speed      gap compression factor (default 1)
  --workspace  scratch dir for the replay's codex sessions (default ./replay-workspace)
  --bot-id     bot principal id (default SLACK_BOT_USER_ID, else UREPLAY)
`;

export function replayArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function replayShow(kind: string, detail: unknown): string {
  return `  ${kind}: ${JSON.stringify(detail)}`;
}

export async function cmdReplay(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(REPLAY_HELP);
    return;
  }
  const snapshot = replayArg("db");
  const from = replayArg("from");
  const endTs = replayArg("to");
  if (!snapshot || !from || !endTs) {
    console.log(REPLAY_HELP);
    process.exit(1);
  }
  const { loadIncident, originalActions, rewindLedger } = await import("./replay/incident");
  const { runReplay } = await import("./replay/run");
  const { copyFileSync } = await import("node:fs");

  const workspace = replayArg("workspace") ?? "./replay-workspace";
  mkdirSync(workspace, { recursive: true });
  const copy = join(workspace, "replay.db");
  copyFileSync(snapshot, copy);
  const db = openLedger(copy);
  const store = makeStore();
  const log = createLogger();

  const venue = replayArg("venue");
  const events = loadIncident(db, {
    fromIso: from,
    toIso: endTs,
    ...(venue ? { venueId: venue } : {}),
  });
  if (events.length === 0) {
    console.error("no surface messages in that window");
    process.exit(1);
  }
  const original = originalActions(db, from, endTs);
  const rewound = rewindLedger(db, events[0]!.rowid, from);
  console.log(
    `rewound to ${from}: ${rewound.events} events, ${rewound.turns} turns, ${rewound.itemsDeleted}+${rewound.itemsReopened} attention items, ` +
      `${rewound.tasks} tasks, ${rewound.timers} timers cleared` +
      (rewound.memoriesInWindow
        ? ` (caveat: ${rewound.memoriesInWindow} memories written in-window stay — no edit history to rewind)`
        : ""),
  );
  console.log(`replaying ${events.length} messages at speed ${replayArg("speed") ?? "1"}…\n`);

  const captured = await runReplay({
    db,
    events,
    policyStore: store,
    sessionFactory: makeCodexSessionFactory(log),
    workspace,
    botPrincipalId: replayArg("bot-id") ?? process.env.SLACK_BOT_USER_ID ?? "UREPLAY",
    speed: Number(replayArg("speed") ?? "1"),
    logger: log,
  });

  console.log("\n=== originally ===");
  for (const turn of original) {
    for (const effect of turn.effects) {
      const kind = isRecord(effect) && typeof effect.kind === "string" ? effect.kind : "?";
      console.log(replayShow(kind, effect));
    }
  }
  console.log("\n=== in replay ===");
  for (const capture of captured) console.log(replayShow(capture.kind, capture.detail));
  db.close();
}
