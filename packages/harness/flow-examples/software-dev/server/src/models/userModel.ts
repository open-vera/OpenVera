import { getDatabase } from "../config/database.js";
import { v4 as uuidv4 } from "uuid";
import type { User, CreateUserInput, UserPublic } from "../types/user.js";

function toUserPublic(user: User): UserPublic {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function findUserByEmail(email: string): User | undefined {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT id, email, password_hash as passwordHash, created_at as createdAt, updated_at as updatedAt
       FROM users WHERE email = ?`
    )
    .get(email) as User | undefined;
  return row;
}

export function findUserById(id: string): UserPublic | undefined {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT id, email, created_at as createdAt, updated_at as updatedAt
       FROM users WHERE id = ?`
    )
    .get(id) as UserPublic | undefined;
  return row;
}

export function createUser(input: CreateUserInput, passwordHash: string): UserPublic {
  const db = getDatabase();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO users (id, email, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, input.email, passwordHash, now, now);

  return {
    id,
    email: input.email,
    createdAt: now,
    updatedAt: now,
  };
}
