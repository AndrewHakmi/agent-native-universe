import type { AgentId } from "./types.js";
import { PermissionViolation } from "./errors.js";

export interface ConstitutionRule {
  id: string;
  description: string;
  check(ctx: { actor: AgentId; action: string; resource?: string; risk?: string }): boolean;
}

export class Constitution {
  constructor(readonly rules: ConstitutionRule[]) {}
  authorize(ctx: { actor: AgentId; action: string; resource?: string; risk?: string }): void {
    for (const rule of this.rules) if (!rule.check(ctx)) throw new PermissionViolation(`Constitution denied by ${rule.id}: ${rule.description}`);
  }
}
