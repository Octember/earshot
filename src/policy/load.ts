import type { Policy } from "./schema";
import { PolicyYamlSchema } from "../schemas/policy-yaml";

interface PolicyValidationError {
  path: string;
  message: string;
}

export function validatePolicy(policy: Policy): PolicyValidationError[] {
  const errors: PolicyValidationError[] = [];

  for (const [key, ref] of Object.entries(policy.surface.credentials)) {
    if (!ref.startsWith("$")) {
      errors.push({
        path: `surface.credentials.${key}`,
        message: `credential must be a $VAR indirection, got a literal value`,
      });
      continue;
    }
    const varName = ref.slice(1);
    if (!process.env[varName]) {
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

export class PolicyStore {
  private policy: Policy;

  constructor(private readonly source: () => string) {
    const result = this.loadAndValidate();
    if ("errors" in result) throw new PolicyValidationFailedError(result.errors);
    this.policy = result.policy;
  }

  current(): Policy {
    return this.policy;
  }

  reload(): { ok: true } | { ok: false; errors: PolicyValidationError[] } {
    const result = this.loadAndValidate();
    if ("errors" in result) {
      return { ok: false, errors: result.errors };
    }
    this.policy = result.policy;
    return { ok: true };
  }

  private loadAndValidate(): { policy: Policy } | { errors: PolicyValidationError[] } {
    let raw: unknown;
    try {
      raw = Bun.YAML.parse(this.source());
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
    const policy = PolicyYamlSchema.parse(raw ?? {});
    const errors = validatePolicy(policy);
    return errors.length > 0 ? { errors } : { policy };
  }
}
