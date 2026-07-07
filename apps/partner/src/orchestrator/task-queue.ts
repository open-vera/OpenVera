import type { Task } from "@/types";

export class TaskQueue {
  private readonly queue: Task[] = [];

  enqueue(task: Task): void {
    this.queue.push(task);
  }

  dequeue(): Task | undefined {
    return this.queue.shift();
  }

  promote(taskId: string): boolean {
    const index = this.queue.findIndex((task) => task.id === taskId);
    if (index <= 0) return index === 0;
    const [task] = this.queue.splice(index, 1);
    if (!task) return false;
    this.queue.unshift(task);
    return true;
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
