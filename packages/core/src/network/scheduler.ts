/**
 * Task Scheduler — Distributed task allocation and load balancing for multi-agent systems.
 *
 * Assigns tasks to available agents based on capability matching,
 * current load, and priority.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentCapability {
  agentId: string;
  skills: string[];
  maxConcurrent: number;
  priority: number;
  currentLoad: number;
}

export interface TaskRequest {
  id: string;
  requiredSkills: string[];
  priority: "low" | "normal" | "high" | "urgent";
  payload: unknown;
  deadline?: string;
}

export interface TaskAssignment {
  taskId: string;
  agentId: string;
  assignedAt: string;
  status: "assigned" | "in_progress" | "completed" | "failed";
  result?: unknown;
}

// ── Task Scheduler ──────────────────────────────────────────────────────────

export class TaskScheduler {
  private agents = new Map<string, AgentCapability>();
  private assignments = new Map<string, TaskAssignment>();
  private taskQueue: TaskRequest[] = [];

  /**
   * Register an agent with its capabilities.
   */
  registerAgent(capability: AgentCapability): void {
    this.agents.set(capability.agentId, { ...capability });
  }

  /**
   * Unregister an agent.
   */
  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * Update agent load.
   */
  updateLoad(agentId: string, load: number): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.currentLoad = load;
    }
  }

  /**
   * Submit a task for scheduling.
   */
  submitTask(task: TaskRequest): TaskAssignment | null {
    const agent = this.findBestAgent(task);
    if (!agent) {
      this.taskQueue.push(task);
      return null;
    }

    return this.assignTask(task, agent);
  }

  /**
   * Complete a task assignment.
   */
  completeTask(taskId: string, result?: unknown): boolean {
    const assignment = this.assignments.get(taskId);
    if (!assignment) return false;

    assignment.status = "completed";
    assignment.result = result;

    // Decrease agent load
    const agent = this.agents.get(assignment.agentId);
    if (agent) {
      agent.currentLoad = Math.max(0, agent.currentLoad - 1);
    }

    // Try to assign queued tasks
    this.processQueue();

    return true;
  }

  /**
   * Mark a task as failed.
   */
  failTask(taskId: string): boolean {
    const assignment = this.assignments.get(taskId);
    if (!assignment) return false;

    assignment.status = "failed";

    const agent = this.agents.get(assignment.agentId);
    if (agent) {
      agent.currentLoad = Math.max(0, agent.currentLoad - 1);
    }

    return true;
  }

  /**
   * Get assignment for a task.
   */
  getAssignment(taskId: string): TaskAssignment | undefined {
    return this.assignments.get(taskId);
  }

  /**
   * Get all assignments for an agent.
   */
  getAgentAssignments(agentId: string): TaskAssignment[] {
    return [...this.assignments.values()].filter((a) => a.agentId === agentId);
  }

  /**
   * Get queue length.
   */
  getQueueLength(): number {
    return this.taskQueue.length;
  }

  /**
   * Get agent status.
   */
  getAgentStatus(): AgentCapability[] {
    return [...this.agents.values()];
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private findBestAgent(task: TaskRequest): AgentCapability | null {
    const candidates: AgentCapability[] = [];

    for (const agent of this.agents.values()) {
      // Check if agent has required skills
      const hasSkills = task.requiredSkills.every((skill) =>
        agent.skills.includes(skill),
      );
      if (!hasSkills) continue;

      // Check if agent has capacity
      if (agent.currentLoad >= agent.maxConcurrent) continue;

      candidates.push(agent);
    }

    if (candidates.length === 0) return null;

    // Sort by: priority (higher first), then load (lower first)
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.currentLoad - b.currentLoad;
    });

    return candidates[0];
  }

  private assignTask(task: TaskRequest, agent: AgentCapability): TaskAssignment {
    const assignment: TaskAssignment = {
      taskId: task.id,
      agentId: agent.agentId,
      assignedAt: new Date().toISOString(),
      status: "assigned",
    };

    this.assignments.set(task.id, assignment);
    agent.currentLoad++;

    return assignment;
  }

  private processQueue(): void {
    const remaining: TaskRequest[] = [];

    for (const task of this.taskQueue) {
      const agent = this.findBestAgent(task);
      if (agent) {
        this.assignTask(task, agent);
      } else {
        remaining.push(task);
      }
    }

    this.taskQueue = remaining;
  }
}
