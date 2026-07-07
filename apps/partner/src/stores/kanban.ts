import { defineStore } from "pinia";
import type { Task } from "@/types";

export const useKanbanStore = defineStore("kanban", {
  state: () => ({
    tasks: [] as Task[],
  }),
  actions: {
    addTask(task: Task) {
      this.tasks.push(task);
    },
    removeTask(id: string) {
      this.tasks = this.tasks.filter((item) => item.id !== id);
    },
  },
});
