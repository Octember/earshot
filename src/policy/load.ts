import { readFileSync } from "node:fs";
import { PolicySchema, type Policy } from "./schema";

export function loadPolicy(path: string): Policy {
  const policy = PolicySchema.parse(Bun.YAML.parse(readFileSync(path, "utf8")) ?? {});
  const venueOwner = new Map<string, string>();
  for (const identity of policy.identities)
    for (const venueId of identity.venue_ids) {
      const existing = venueOwner.get(venueId);
      if (existing && existing !== identity.id)
        throw new Error(`policy: venue ${venueId} is bound to both ${existing} and ${identity.id}`);
      venueOwner.set(venueId, identity.id);
    }
  return policy;
}
