import { describe, expect, test } from "bun:test";
import { parsePolicyYaml, toPolicy, validatePolicy, PolicyStore, PolicyValidationFailedError } from "../src/policy/load";

const MINIMAL_YAML = `
surface:
  kind: slack
  credentials:
    bot_token: $SLACK_BOT_TOKEN
operator_principals:
  - U_OPERATOR
identities:
  - id: eng
    venue_ids: [C1]
    budget:
      monthly_cap: 100
budget:
  global_monthly_cap: 1000
`;

function baseOpts(overrides: Partial<Parameters<typeof validatePolicy>[1]> = {}) {
  return {
    knownTools: new Set(["task_create", "task_steer", "task_confirm", "task_cancel", "task_query", "memory_write"]),
    envAvailable: () => true,
    ...overrides,
  };
}

describe("parsePolicyYaml + toPolicy (SPEC §16.1)", () => {
  test("parses a minimal policy and applies documented defaults", () => {
    const policy = toPolicy(parsePolicyYaml(MINIMAL_YAML));

    expect(policy.surface.kind).toBe("slack");
    expect(policy.surface.credentials.bot_token).toBe("$SLACK_BOT_TOKEN");
    expect(policy.operatorPrincipals).toEqual(["U_OPERATOR"]);
    expect(policy.trustedBotPrincipals).toEqual([]);

    const eng = policy.identities[0]!;
    expect(eng.id).toBe("eng");
    expect(eng.venueIds).toEqual(["C1"]);
    expect(eng.learningSources).toEqual([]);
    expect(eng.grants).toEqual([]);
    expect(eng.budget.monthlyCap).toBe(100);
    expect(eng.budget.perTaskCap).toBeNull();
    expect(eng.ambient.enabledVenues).toEqual([]);
    expect(eng.ambient.dailyPostCap).toBe(5);

    expect(policy.tasks.nudgeAfterMs).toBeGreaterThan(0);
    expect(policy.budget.timezone).toBe("UTC");
    expect(policy.budget.unit).toBe("USD");
    expect(policy.budget.globalMonthlyCap).toBe(1000);
    expect(policy.budget.reserve).toBe(0);
    expect(policy.retention.auditRetentionMs).toBeNull();
  });

  test("explicit values override defaults", () => {
    const policy = toPolicy(
      parsePolicyYaml(
        MINIMAL_YAML +
          `
turns:
  interactive_timeout_ms: 9999
budget:
  global_monthly_cap: 1000
  timezone: America/New_York
  reserve: 50
`,
      ),
    );
    expect(policy.turns.interactiveTimeoutMs).toBe(9999);
    expect(policy.budget.timezone).toBe("America/New_York");
    expect(policy.budget.reserve).toBe(50);
  });

  test("a grant's preauthorized_action_classes defaults to empty (homebrew default: no class pre-authorized)", () => {
    const policy = toPolicy(
      parsePolicyYaml(
        MINIMAL_YAML +
          `
identities:
  - id: eng
    venue_ids: [C1]
    budget: { monthly_cap: 100 }
    grants:
      - tool: task_create
`,
      ),
    );
    expect(policy.identities[0]!.grants[0]!.preauthorizedActionClasses).toEqual([]);
  });

  // §9.5 — per-venue standing instructions: a map of venue id → instruction text, default empty;
  // non-string or blank values are dropped rather than injected into prompts.
  test("venue_instructions parses to a per-venue map (default empty, junk values dropped)", () => {
    expect(toPolicy(parsePolicyYaml(MINIMAL_YAML)).identities[0]!.venueInstructions).toEqual({});

    const policy = toPolicy(
      parsePolicyYaml(
        MINIMAL_YAML +
          `
identities:
  - id: eng
    venue_ids: [C1]
    budget: { monthly_cap: 100 }
    venue_instructions:
      C_ALERTS: "dedupe prod alerts, flag what matters"
      C_BLANK: "   "
      C_JUNK: 42
`,
      ),
    );
    expect(policy.identities[0]!.venueInstructions).toEqual({ C_ALERTS: "dedupe prod alerts, flag what matters" });
  });
});

describe("validatePolicy (SPEC §16.3)", () => {
  test("a valid minimal policy has no errors", () => {
    const policy = toPolicy(parsePolicyYaml(MINIMAL_YAML));
    expect(validatePolicy(policy, baseOpts())).toEqual([]);
  });

  test("missing surface credential env var fails validation", () => {
    const policy = toPolicy(parsePolicyYaml(MINIMAL_YAML));
    const errors = validatePolicy(policy, baseOpts({ envAvailable: () => false }));
    expect(errors.some((e) => e.message.includes("SLACK_BOT_TOKEN"))).toBe(true);
  });

  test("two identities bound to the same venue fails validation", () => {
    const policy = toPolicy(
      parsePolicyYaml(`
surface:
  kind: slack
  credentials:
    bot_token: $SLACK_BOT_TOKEN
identities:
  - id: eng
    venue_ids: [C1]
    budget: { monthly_cap: 100 }
  - id: sales
    venue_ids: [C1]
    budget: { monthly_cap: 100 }
budget:
  global_monthly_cap: 1000
`),
    );
    const errors = validatePolicy(policy, baseOpts());
    expect(errors.some((e) => e.message.includes("C1"))).toBe(true);
  });

  test("a grant referencing an unknown tool fails validation", () => {
    const policy = toPolicy(
      parsePolicyYaml(
        MINIMAL_YAML +
          `
identities:
  - id: eng
    venue_ids: [C1]
    budget: { monthly_cap: 100 }
    grants:
      - tool: nonexistent_tool
`,
      ),
    );
    const errors = validatePolicy(policy, baseOpts());
    expect(errors.some((e) => e.message.includes("nonexistent_tool"))).toBe(true);
  });

  test("a negative budget cap fails validation ('budgets parse')", () => {
    const policy = toPolicy(
      parsePolicyYaml(`
surface:
  kind: slack
  credentials:
    bot_token: $SLACK_BOT_TOKEN
identities:
  - id: eng
    venue_ids: [C1]
    budget: { monthly_cap: -5 }
budget:
  global_monthly_cap: 1000
`),
    );
    const errors = validatePolicy(policy, baseOpts());
    expect(errors.some((e) => e.message.includes("monthly_cap") || e.path.includes("budget"))).toBe(true);
  });

  test("an identity listing another identity's private venue as a learning source fails validation", () => {
    const policy = toPolicy(
      parsePolicyYaml(`
surface:
  kind: slack
  credentials:
    bot_token: $SLACK_BOT_TOKEN
identities:
  - id: eng
    venue_ids: [C1]
    budget: { monthly_cap: 100 }
  - id: sales
    venue_ids: [C2]
    learning_sources: [C1]
    budget: { monthly_cap: 100 }
budget:
  global_monthly_cap: 1000
`),
    );
    const errors = validatePolicy(policy, baseOpts({ privateVenues: new Set(["C1"]) }));
    expect(errors.some((e) => e.message.includes("C1"))).toBe(true);
  });

  test("without privateVenues info, the learning-source-privacy check is simply skipped (not fabricated)", () => {
    const policy = toPolicy(
      parsePolicyYaml(`
surface:
  kind: slack
  credentials:
    bot_token: $SLACK_BOT_TOKEN
identities:
  - id: eng
    venue_ids: [C1]
    budget: { monthly_cap: 100 }
  - id: sales
    venue_ids: [C2]
    learning_sources: [C1]
    budget: { monthly_cap: 100 }
budget:
  global_monthly_cap: 1000
`),
    );
    expect(validatePolicy(policy, baseOpts())).toEqual([]);
  });
});

describe("PolicyStore (SPEC §16.2 reload semantics)", () => {
  test("startup with an invalid policy throws (fails startup, per §16.3)", () => {
    let text = `
surface:
  kind: slack
  credentials:
    bot_token: $MISSING_VAR
identities: []
budget:
  global_monthly_cap: 1000
`;
    expect(() => new PolicyStore(() => text, baseOpts({ envAvailable: () => false }))).toThrow(
      PolicyValidationFailedError,
    );
  });

  test("a valid reload replaces the current policy", () => {
    let text = MINIMAL_YAML;
    const store = new PolicyStore(() => text, baseOpts());
    expect(store.current().budget.globalMonthlyCap).toBe(1000);

    text = MINIMAL_YAML.replace("global_monthly_cap: 1000", "global_monthly_cap: 2000");
    const result = store.reload();
    expect(result.ok).toBe(true);
    expect(store.current().budget.globalMonthlyCap).toBe(2000);
    expect(store.lastReloadError()).toBeNull();
  });

  test("an invalid reload keeps the last-known-good policy and records the error", () => {
    let text = MINIMAL_YAML;
    const store = new PolicyStore(() => text, baseOpts());

    text = `
surface:
  kind: slack
  credentials:
    bot_token: $SLACK_BOT_TOKEN
identities:
  - id: eng
    venue_ids: [C1]
    budget: { monthly_cap: 100 }
  - id: sales
    venue_ids: [C1]
    budget: { monthly_cap: 100 }
budget:
  global_monthly_cap: 1000
`;
    const result = store.reload();
    expect(result.ok).toBe(false);
    expect(store.current().identities).toHaveLength(1); // unchanged: still the original single-identity policy
    expect(store.lastReloadError()).not.toBeNull();
  });

  test("a malformed YAML reload is treated as invalid, not a thrown exception", () => {
    let text = MINIMAL_YAML;
    const store = new PolicyStore(() => text, baseOpts());

    text = "not: valid: yaml: [";
    const result = store.reload();
    expect(result.ok).toBe(false);
    expect(store.current().identities).toHaveLength(1);
  });
});
