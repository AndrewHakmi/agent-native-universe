import type { AgentId, DiscoveryAdvertisement } from "../core/types.js";
import { deepClone } from "../core/utils.js";

/**
 * A transport surface for capability advertisements. It does not select peers
 * or create links; every NanoAgent independently evaluates the same local view.
 */
export class DiscoveryMesh {
  #advertisements = new Map<AgentId, DiscoveryAdvertisement>();

  publish(advertisement: DiscoveryAdvertisement): void {
    this.#advertisements.set(advertisement.agentId, deepClone(advertisement));
  }

  withdraw(agentId: AgentId): void { this.#advertisements.delete(agentId); }

  expire(now = Date.now()): AgentId[] {
    const expired: AgentId[] = [];
    for (const [agentId, advertisement] of this.#advertisements) {
      if (advertisement.expiresAt <= now) {
        this.#advertisements.delete(agentId);
        expired.push(agentId);
      }
    }
    return expired;
  }

  visibleTo(agentId: AgentId, now = Date.now()): DiscoveryAdvertisement[] {
    this.expire(now);
    return [...this.#advertisements.values()]
      .filter(advertisement => advertisement.agentId !== agentId)
      .map(advertisement => deepClone(advertisement));
  }

  get(agentId: AgentId, now = Date.now()): DiscoveryAdvertisement | undefined {
    this.expire(now);
    const advertisement = this.#advertisements.get(agentId);
    return advertisement ? deepClone(advertisement) : undefined;
  }

  snapshot(now = Date.now()): DiscoveryAdvertisement[] {
    this.expire(now);
    return [...this.#advertisements.values()].map(advertisement => deepClone(advertisement));
  }
}
