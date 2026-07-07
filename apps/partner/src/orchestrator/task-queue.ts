import type { Task } from "@/types";

export class TaskQueue {
  private readonly queue: Task[] = [];

  enqueue(task: Task): void {
    this.queue.push(task);
  }

  dequeue(): Task | undefined {
    return this.queue.shift();
  }

  peek(): Task | undefined {
    return this.queue[0];
  }

  size(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue.length = 0;
  }
}
