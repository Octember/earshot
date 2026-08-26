// SPEC §16 — policy loading, defaulting, validation, and reload semantics.
import type { Policy } from "./schema";
import { readFileSync } from "node:fs";
import { parsePolicy } from "../schemas/policy-yaml";

export function parsePolicyYaml(yamlText: string): unknown {
  return Bun.YAML.parse(yamlText);
}

export function toPolicy(raw: unknown): Policy {
  return parsePolicy(raw);
}

export interface PolicyValidationError {
  path: string;
  message: string;
}

export interface ValidateOpts {
  knownTools: Set<string>;
  envAvailable?: (varName: string) => boolean;
  // Known private venues; omitted until surface adapter exists.
  privateVenues?: Set<string>;
}

function defaultEnvAvailable(varName: string): boolean {
  return typeof process.env[varName] === "string" && process.env[varName] !== "";
}

// SPEC §16.3 — startup validation.
export function validatePolicy(policy: Policy, opts: ValidateOpts): PolicyValidationError[] {
  const errors: PolicyValidationError[] = [];
  const envAvailable = opts.envAvailable ?? defaultEnvAvailable;

  for (const [key, ref] of Object.entries(policy.surface.credentials)) {
    if (!ref.startsWith("$")) {
      errors.push({
        path: `surface.credentials.${key}`,
        message: `credential must be a $VAR indirection, got a literal value`,
      });
      continue;
    }
    const varName = ref.slice(1);
    if (!envAvailable(varName)) {
      errors.push({
        path: `surface.credentials.${key}`,
        message: `missing environment variable ${varName}`,
      });
    }
  }

  const venueOwner = new Map<string, string>();
  for (const identity of policy.identities) {
    for (const venueId of identity.venueIds) {
      const existing = venueOwner.get(venueId);
      if (existing && existing !== identity.id) {
        errors.push({
          path: `identities.${identity.id}.venueIds`,
          message: `venue ${venueId} is bound to both ${existing} and ${identity.id}`,
        });
      } else {
        venueOwner.set(venueId, identity.id);
      }
    }
  }

  for (const identity of policy.identities) {
    for (const grant of identity.grants) {
      if (!opts.knownTools.has(grant.tool)) {
        errors.push({
          path: `identities.${identity.id}.grants`,
          message: `unknown tool ${grant.tool}`,
        });
      }
    }
  }

  if (!(policy.budget.globalMonthlyCap >= 0)) {
    errors.push({
      path: "budget.globalMonthlyCap",
      message: `global_monthly_cap must be a non-negative number`,
    });
  }
  for (const identity of policy.identities) {
    if (!(identity.budget.monthlyCap >= 0)) {
      errors.push({
        path: `identities.${identity.id}.budget.monthlyCap`,
        message: `monthly_cap must be a non-negative number`,
      });
    }
    if (identity.budget.perTaskCap !== null && !(identity.budget.perTaskCap >= 0)) {
      errors.push({
        path: `identities.${identity.id}.budget.perTaskCap`,
        message: `per_task_cap must be a non-negative number`,
      });
    }
  }

  if (opts.privateVenues) {
    for (const identity of policy.identities) {
      for (const source of identity.learningSources) {
        if (opts.privateVenues.has(source) && venueOwner.get(source) !== identity.id) {
          errors.push({
            path: `identities.${identity.id}.learningSources`,
            message: `${source} is a private venue not bound to ${identity.id}`,
          });
        }
      }
    }
  }

  return errors;
}

export class PolicyValidationFailedError extends Error {
  constructor(public readonly errors: PolicyValidationError[]) {
    super(
      `policy validation failed:\n${errors.map((err) => `  ${err.path}: ${err.message}`).join("\n")}`,
    );
    this.name = "PolicyValidationFailedError";
  }
}

export function fileSource(path: string): () => string {
  return () => readFileSync(path, "utf8");
}

// Keep last-known-good on invalid reload.
export class PolicyStore {
  private policy: Policy;
  private lastError: PolicyValidationError[] | null = null;

  constructor(
    private readonly source: () => string,
    private readonly opts: ValidateOpts,
  ) {
    const result = this.loadAndValidate();
    if ("errors" in result) throw new PolicyValidationFailedError(result.errors);
    this.policy = result.policy;
  }

  current(): Policy {
    return this.policy;
  }

  lastReloadError(): PolicyValidationError[] | null {
    return this.lastError;
  }

  reload(): { ok: true } | { ok: false; errors: PolicyValidationError[] } {
    const result = this.loadAndValidate();
    if ("errors" in result) {
      this.lastError = result.errors;
      return { ok: false, errors: result.errors };
    }
    this.lastError = null;
    this.policy = result.policy;
    return { ok: true };
  }

  private loadAndValidate(): { policy: Policy } | { errors: PolicyValidationError[] } {
    let raw: unknown;
    try {
      raw = parsePolicyYaml(this.source());
    } catch (error) {
      return {
        errors: [
          {
            path: "",
            message: `failed to read/parse policy: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
    const policy = toPolicy(raw);
    const errors = validatePolicy(policy, this.opts);
    return errors.length > 0 ? { errors } : { policy };
  }
}
