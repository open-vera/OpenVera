import * as userModel from "../models/userModel.js";
import { hashPassword, comparePassword } from "../utils/password.js";
import { generateToken } from "../utils/token.js";
import { createAppError } from "../middleware/errorHandler.js";
import type { UserPublic, CreateUserInput } from "../types/user.js";

export interface AuthResult {
  token: string;
  expiresIn: number;
  user: UserPublic;
}

export async function register(input: CreateUserInput): Promise<UserPublic> {
  const existing = userModel.findUserByEmail(input.email);
  if (existing) {
    throw createAppError(409, "CONFLICT", "该邮箱已被注册");
  }

  const passwordHash = await hashPassword(input.password);
  return userModel.createUser(input, passwordHash);
}

export async function login(input: CreateUserInput): Promise<AuthResult> {
  const user = userModel.findUserByEmail(input.email);
  if (!user) {
    throw createAppError(401, "AUTH_FAILED", "邮箱或密码错误");
  }

  const valid = await comparePassword(input.password, user.passwordHash);
  if (!valid) {
    throw createAppError(401, "AUTH_FAILED", "邮箱或密码错误");
  }

  const token = generateToken({ userId: user.id, email: user.email });
  const expiresIn = 86400; // 24 hours in seconds

  return {
    token,
    expiresIn,
    user: {
      id: user.id,
      email: user.email,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  };
}

export function getCurrentUser(userId: string): UserPublic {
  const user = userModel.findUserById(userId);
  if (!user) {
    throw createAppError(404, "NOT_FOUND", "用户不存在");
  }
  return user;
}
