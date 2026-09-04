import { readFileSync } from "node:fs";
import type { Policy } from "./schema";
import { PolicyYamlSchema } from "../schemas/policy-yaml";

export function loadPolicy(path: string): Policy {
  const policy = PolicyYamlSchema.parse(Bun.YAML.parse(readFileSync(path, "utf8")) ?? {});
  const errors: string[] = [];

  for (const [key, ref] of Object.entries(policy.surface.credentials)) {
    if (!ref.startsWith("$"))
      errors.push(`surface.credentials.${key}: credential must be a $VAR indirection`);
    else if (!process.env[ref.slice(1)])
      errors.push(`surface.credentials.${key}: missing environment variable ${ref.slice(1)}`);
  }

  const venueOwner = new Map<string, string>();
  for (const identity of policy.identities)
    for (const venueId of identity.venueIds) {
      const existing = venueOwner.get(venueId);
      if (existing && existing !== identity.id)
        errors.push(
          `identities.${identity.id}.venueIds: venue ${venueId} is bound to both ${existing} and ${identity.id}`,
        );
      venueOwner.set(venueId, identity.id);
    }

  if (errors.length > 0)
    throw new Error(`policy validation failed:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  return policy;
}
