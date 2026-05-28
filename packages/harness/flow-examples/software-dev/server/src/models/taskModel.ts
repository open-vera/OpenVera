import { getDatabase } from "../config/database.js";
import { v4 as uuidv4 } from "uuid";
import type {
  Task,
  CreateTaskInput,
  UpdateTaskInput,
  TaskQueryParams,
  TaskListResponse,
  PaginationMeta,
} from "../types/task.js";

const COLUMN_MAP: Record<string, string> = {
  due_date: "due_date",
  created_at: "created_at",
};

function mapRow(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    title: row.title as string,
    description: (row.description as string) ?? null,
    priority: row.priority as Task["priority"],
    status: row.status as Task["status"],
    dueDate: (row.due_date as string) ?? null,
    sortOrder: (row.sort_order as number) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function findTasksByUserId(
  userId: string,
  params: TaskQueryParams
): TaskListResponse {
  const db = getDatabase();
  const conditions = ["user_id = ?"];
  const values: unknown[] = [userId];

  if (params.status) {
    conditions.push("status = ?");
    values.push(params.status);
  }

  if (params.priority) {
    conditions.push("priority = ?");
    values.push(params.priority);
  }

  const whereClause = conditions.join(" AND ");

  // Count total
  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM tasks WHERE ${whereClause}`)
    .get(...values) as { total: number };
  const total = countRow.total;

  // Pagination
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const offset = (page - 1) * limit;
  const totalPages = Math.ceil(total / limit);

  // Sorting
  const sortColumn = COLUMN_MAP[params.sortBy ?? "created_at"] ?? "created_at";
  const sortOrder = params.sortOrder === "asc" ? "ASC" : "DESC";

  const rows = db
    .prepare(
      `SELECT id, user_id, title, description, priority, status, due_date, sort_order, created_at, updated_at
       FROM tasks
       WHERE ${whereClause}
       ORDER BY ${sortColumn} ${sortOrder}
       LIMIT ? OFFSET ?`
    )
    .all(...values, limit, offset) as Record<string, unknown>[];

  const pagination: PaginationMeta = { page, limit, total, totalPages };

  return {
    tasks: rows.map(mapRow),
    pagination,
  };
}

export function findTaskById(id: string, userId: string): Task | undefined {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT id, user_id, title, description, priority, status, due_date, sort_order, created_at, updated_at
       FROM tasks WHERE id = ? AND user_id = ?`
    )
    .get(id, userId) as Record<string, unknown> | undefined;

  return row ? mapRow(row) : undefined;
}

export function createTask(userId: string, input: CreateTaskInput): Task {
  const db = getDatabase();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO tasks (id, user_id, title, description, priority, due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    input.title,
    input.description ?? null,
    input.priority ?? "medium",
    input.dueDate ?? null,
    now,
    now
  );

  return {
    id,
    userId,
    title: input.title,
    description: input.description ?? null,
    priority: input.priority ?? "medium",
    status: "todo",
    dueDate: input.dueDate ?? null,
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateTask(
  id: string,
  userId: string,
  input: UpdateTaskInput
): Task | undefined {
  const db = getDatabase();
  const existing = findTaskById(id, userId);
  if (!existing) return undefined;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.title !== undefined) {
    fields.push("title = ?");
    values.push(input.title);
  }
  if (input.description !== undefined) {
    fields.push("description = ?");
    values.push(input.description);
  }
  if (input.priority !== undefined) {
    fields.push("priority = ?");
    values.push(input.priority);
  }
  if (input.dueDate !== undefined) {
    fields.push("due_date = ?");
    values.push(input.dueDate);
  }

  if (fields.length === 0) return existing;

  const now = new Date().toISOString();
  fields.push("updated_at = ?");
  values.push(now);

  db.prepare(
    `UPDATE tasks SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`
  ).run(...values, id, userId);

  return {
    ...existing,
    ...(input.title !== undefined && { title: input.title }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.priority !== undefined && { priority: input.priority }),
    ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
    updatedAt: now,
  };
}

export function updateTaskStatus(
  id: string,
  userId: string,
  status: Task["status"]
): Task | undefined {
  const db = getDatabase();
  const existing = findTaskById(id, userId);
  if (!existing) return undefined;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).run(status, now, id, userId);

  return { ...existing, status, updatedAt: now };
}

export function deleteTask(id: string, userId: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare(`DELETE FROM tasks WHERE id = ? AND user_id = ?`)
    .run(id, userId);

  return result.changes > 0;
}
