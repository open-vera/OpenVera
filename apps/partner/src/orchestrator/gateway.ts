import type { GatewayStatus } from "@/types";
import { AgentInstanceRunner } from "./agent-instance.js";

export class Gateway {
  private readonly instances = new Map<string, AgentInstanceRunner>();
  readonly maxInstances: number;

  constructor(maxInstances = 3) {
    this.maxInstances = maxInstances;
  }

  createInstance(sessionId: string): AgentInstanceRunner | null {
    if (this.instances.size >= this.maxInstances) {
      return null;
    }
    const instance = new AgentInstanceRunner(sessionId);
    this.instances.set(instance.id, instance);
    return instance;
  }

  getInstance(id: string): AgentInstanceRunner | undefined {
    return this.instances.get(id);
  }

  removeInstance(id: string): void {
    this.instances.delete(id);
  }

  status(): GatewayStatus {
    const active = [...this.instances.values()].filter(
      (item) => item.status === "running",
    ).length;
    return {
      activeInstances: active,
      maxInstances: this.maxInstances,
      isHealthy: true,
    };
  }
}
