import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  slackRegistry,
  SLACK_TOOL_NAMES,
  type SlackFetch,
  type SlackToolDeps,
} from "../src/tools/slack";
import { isRecord } from "../src/guard";

// Fake Slack registry: `calls` records wire hits; `responses` scripts answers.
function makeRegistry(opts: {
  responses?: Record<string, unknown[]>;
  downloaded?: Uint8Array;
  adminToken?: string;
}) {
  const workspace = mkdtempSync(join(tmpdir(), "earshot-slack-tools-"));
  const calls: { url: string; body?: unknown; contentType?: string }[] = [];
  const responses = new Map(Object.entries(opts.responses ?? {}));
  const fakeFetch: SlackFetch = async (url, init) => {
    const raw = init?.body;
    const body =
      typeof raw === "string"
        ? init?.headers?.["Content-Type"]?.includes("json")
          ? JSON.parse(raw)
          : Object.fromEntries(new URLSearchParams(raw))
        : raw;
    calls.push({
      url,
      body,
      ...(init?.headers?.["Content-Type"] ? { contentType: init.headers["Content-Type"] } : {}),
    });
    const method = url.startsWith("https://slack.com/api/")
      ? url.slice("https://slack.com/api/".length)
      : url;
    const queued = responses.get(method);
    const payload = queued?.shift() ?? { ok: true };
    return { ok: true, status: 200, json: async () => payload };
  };
  const deps: SlackToolDeps = {
    readHistory: async () => [{ text: "root" }],
    readThread: async () => [{ text: "reply" }],
    downloadFile: async () => opts.downloaded ?? new Uint8Array([1, 2, 3]),
    botToken: "xoxb-test",
    ...(opts.adminToken ? { adminToken: opts.adminToken } : {}),
    workspace,
    fetch: fakeFetch,
  };
  return { registry: slackRegistry(deps), workspace, calls };
}

describe("slack registry shape", () => {
  test("SLACK_TOOL_NAMES matches registry tools exactly", () => {
    const { registry } = makeRegistry({});
    expect(Object.keys(registry.tools).toSorted()).toEqual([...SLACK_TOOL_NAMES].toSorted());
  });

  test("every example names a tool in the registry", () => {
    const { registry } = makeRegistry({});
    for (const example of registry.examples ?? [])
      expect(Object.keys(registry.tools)).toContain(example.tool);
  });

  test("only emoji_set is consequential — reads and in-room speech are ungated", () => {
    const { registry } = makeRegistry({});
    for (const [name, spec] of Object.entries(registry.tools)) {
      const classes = spec.actionClasses?.({}) ?? [];
      expect(classes).toEqual(name === "emoji_set" ? ["outward"] : []);
    }
  });
});

describe("download_file", () => {
  test("saves original bytes to workspace files dir; returns relative path", async () => {
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const { registry, workspace } = makeRegistry({ downloaded: bytes });
    const result = await registry.tools.download_file!.run!({
      url: "https://files.slack.com/files-pri/T0-F1/pic.png",
      name: "pic.png",
    });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.bytes).toBe(4);
    // ABSOLUTE path (review 2026-08-13): codex sessions run in per-identity subdirectories, so
    // a workspace-relative path would resolve wrong from their cwd.
    expect(parsed.path).toBe(resolve(workspace, "files", "pic.png"));
    expect(
      new Uint8Array(await Bun.file(join(workspace, "files", "pic.png")).arrayBuffer()),
    ).toEqual(bytes);
  });

  test("refuses non-Slack host; bot token never sent to arbitrary URL", async () => {
    const { registry } = makeRegistry({});
    const result = await registry.tools.download_file!.run!({
      url: "https://evil.example.com/steal",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("files.slack.com");
  });

  test("strips path traversal from the requested save name", async () => {
    const { registry } = makeRegistry({});
    const result = await registry.tools.download_file!.run!({
      url: "https://files.slack.com/f/x.png",
      name: "../../etc/passwd",
    });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output).path.endsWith("/files/passwd")).toBe(true); // traversal stripped; absolute path
  });
});

describe("upload_file", () => {
  test("Slack reserve→put→complete; file threaded into addressed conversation", async () => {
    const { registry, workspace, calls } = makeRegistry({
      responses: {
        "files.getUploadURLExternal": [
          { ok: true, upload_url: "https://upload.slack.example/u1", file_id: "F123" },
        ],
        "files.completeUploadExternal": [{ ok: true }],
      },
    });
    writeFileSync(join(workspace, "out.png"), "png-bytes");
    const result = await registry.tools.upload_file!.run!({
      path: "out.png",
      venueId: "C9",
      threadRootId: "17.001",
      title: "cleaned",
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("<#C9>");
    const complete = calls.find((c) => c.url.endsWith("files.completeUploadExternal"))!.body;
    if (!isRecord(complete)) throw new Error("expected completeUploadExternal body");
    expect(complete.channel_id).toBe("C9");
    expect(complete.thread_ts).toBe("17.001");
    expect(complete.files).toEqual([{ id: "F123", title: "cleaned" }]);
    expect(calls.some((c) => c.url === "https://upload.slack.example/u1")).toBe(true);
    // getUploadURLExternal is form-only: a JSON body earns invalid_arguments (bit us live 2026-07-30)
    const reserve = calls.find((c) => c.url.endsWith("files.getUploadURLExternal"))!;
    expect(reserve.contentType).toBe("application/x-www-form-urlencoded");
    expect(reserve.body).toEqual({ filename: "out.png", length: "9" });
  });

  test("refuses path outside workspace (daemon filesystem not postable)", async () => {
    const { registry } = makeRegistry({});
    const result = await registry.tools.upload_file!.run!({
      path: "../../../etc/passwd",
      venueId: "C9",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("workspace");
  });

  test("a missing file fails friendly with the path named", async () => {
    const { registry } = makeRegistry({});
    const result = await registry.tools.upload_file!.run!({ path: "nope.png", venueId: "C9" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("nope.png");
  });

  test("surfaces a missing files:write scope by name", async () => {
    const { registry, workspace } = makeRegistry({
      responses: { "files.getUploadURLExternal": [{ ok: false, error: "missing_scope" }] },
    });
    writeFileSync(join(workspace, "out.png"), "x");
    const result = await registry.tools.upload_file!.run!({ path: "out.png", venueId: "C9" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("files:write");
  });
});

describe("emoji_set", () => {
  test("without admin credential fails in room-safe language", async () => {
    const { registry } = makeRegistry({});
    const result = await registry.tools.emoji_set!.run!({
      name: "anya",
      url: "https://files.slack.com/f/a.png",
    });
    expect(result.success).toBe(false);
    expect(result.output).not.toMatch(/SLACK_|token|scope/i);
  });

  test("adds the emoji with the admin token, normalizing the name", async () => {
    const { registry, calls } = makeRegistry({
      adminToken: "xoxp-admin",
      responses: { "admin.emoji.add": [{ ok: true }] },
    });
    const result = await registry.tools.emoji_set!.run!({
      name: ":Anya:",
      url: "https://files.slack.com/f/a.png",
    });
    expect(result.success).toBe(true);
    const added = calls[0]!.body;
    if (!isRecord(added)) throw new Error("expected admin.emoji.add body");
    expect(added.name).toBe("anya");
  });

  test("an existing emoji is replaced: remove then re-add under the same name", async () => {
    const { registry, calls } = makeRegistry({
      adminToken: "xoxp-admin",
      responses: {
        "admin.emoji.add": [{ ok: false, error: "emoji_already_exists" }, { ok: true }],
        "admin.emoji.remove": [{ ok: true }],
      },
    });
    const result = await registry.tools.emoji_set!.run!({
      name: "anya",
      url: "https://files.slack.com/f/a.png",
    });
    expect(result.success).toBe(true);
    expect(calls.map((c) => c.url.split("/api/")[1])).toEqual([
      "admin.emoji.add",
      "admin.emoji.remove",
      "admin.emoji.add",
    ]);
  });
});
