import { getDatabase } from "../config/database.js";
import type { Task, TaskPriority, TaskStatus, TaskQueryParams, PaginationMeta } from "../types/task.js";

interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  due_date: string | null;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    dueDate: row.due_date,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findById(id: string): Task | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function findByUser(
  userId: string,
  params: TaskQueryParams
): { tasks: Task[]; pagination: PaginationMeta } {
  const db = getDatabase();

  const conditions: string[] = ["user_id = ?"];
  const values: (string | number)[] = [userId];

  if (params.status) {
    conditions.push("status = ?");
    values.push(params.status);
  }
  if (params.priority) {
    conditions.push("priority = ?");
    values.push(params.priority);
  }
  if (params.search) {
    conditions.push("(title LIKE ? OR description LIKE ?)");
    const searchTerm = `%${params.search}%`;
    values.push(searchTerm, searchTerm);
  }

  const whereClause = conditions.join(" AND ");

  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM tasks WHERE ${whereClause}`)
    .get(...values) as { total: number };
  const total = countRow.total;

  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;

  const sortColumn = params.sortBy === "due_date" ? "due_date" : "created_at";
  const sortDir = params.sortOrder === "asc" ? "ASC" : "DESC";

  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE ${whereClause} ORDER BY ${sortColumn} ${sortDir} LIMIT ? OFFSET ?`
    )
    .all(...values, limit, offset) as TaskRow[];

  return {
    tasks: rows.map(rowToTask),
    pagination: { page, limit, total, totalPages },
  };
}

export function create(input: {
  id: string;
  userId: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  dueDate?: string;
}): Task {
  const db = getDatabase();
  const now = new Date().toISOString();
  const priority = input.priority ?? "medium";

  db.prepare(
    `INSERT INTO tasks (id, user_id, title, description, priority, status, due_date, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'todo', ?, NULL, ?, ?)`
  ).run(input.id, input.userId, input.title, input.description ?? null, priority, input.dueDate ?? null, now, now);

  return {
    id: input.id,
    userId: input.userId,
    title: input.title,
    description: input.description ?? null,
    priority,
    status: "todo",
    dueDate: input.dueDate ?? null,
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function update(
  id: string,
  input: {
    title?: string;
    description?: string | null;
    priority?: TaskPriority;
    dueDate?: string | null;
  }
): Task | null {
  const db = getDatabase();
  const existing = findById(id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: (string | null)[] = [];

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
  values.push(id);

  db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  return findById(id);
}

export function updateStatus(id: string, status: TaskStatus): Task | null {
  const db = getDatabase();
  const existing = findById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);

  return findById(id);
}

export function remove(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return result.changes > 0;
}
