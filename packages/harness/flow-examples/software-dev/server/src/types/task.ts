export type TaskPriority = "high" | "medium" | "low";
export type TaskStatus = "todo" | "in_progress" | "completed";

export interface Task {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string | null;
  sortOrder: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  dueDate?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  dueDate?: string | null;
}

export interface TaskQueryParams {
  status?: TaskStatus;
  priority?: TaskPriority;
  sortBy?: "due_date" | "created_at";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
  search?: string;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface TaskListResponse {
  tasks: Task[];
  pagination: PaginationMeta;
}
