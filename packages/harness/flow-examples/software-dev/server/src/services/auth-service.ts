import { v4 as uuidv4 } from "uuid";
import * as userModel from "../models/userModel.js";
import { hashPassword, comparePassword } from "../utils/password.js";
import { generateToken } from "../utils/token.js";
import type { UserPublic } from "../types/user.js";
import type { RegisterInput, LoginInput } from "../validation/authValidation.js";

interface AuthError {
  code: string;
  message: string;
  field?: string;
}

interface RegisterResult {
  success: true;
  data: UserPublic;
}

interface LoginResult {
  success: true;
  data: { token: string; expiresIn: number; user: UserPublic };
}

interface AuthFailure {
  success: false;
  error: AuthError;
}

type RegisterResponse = RegisterResult | AuthFailure;
type LoginResponse = LoginResult | AuthFailure;

function toPublicUser(user: { id: string; email: string; createdAt: string; updatedAt: string }): UserPublic {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function register(input: RegisterInput): Promise<RegisterResponse> {
  const existing = userModel.findByEmail(input.email);
  if (existing) {
    return {
      success: false,
      error: { code: "CONFLICT", message: "该邮箱已被注册", field: "email" },
    };
  }

  const id = uuidv4();
  const passwordHashed = await hashPassword(input.password);

  const user = userModel.create({
    id,
    email: input.email,
    passwordHash: passwordHashed,
  });

  return { success: true, data: toPublicUser(user) };
}

export async function login(input: LoginInput): Promise<LoginResponse> {
  const user = userModel.findByEmail(input.email);
  if (!user) {
    return {
      success: false,
      error: { code: "AUTH_FAILED", message: "邮箱或密码错误" },
    };
  }

  const valid = await comparePassword(input.password, user.passwordHash);
  if (!valid) {
    return {
      success: false,
      error: { code: "AUTH_FAILED", message: "邮箱或密码错误" },
    };
  }

  const token = generateToken({ userId: user.id, email: user.email });
  const expiresIn = 86400; // 24h in seconds

  return {
    success: true,
    data: { token, expiresIn, user: toPublicUser(user) },
  };
}

export function getUserById(id: string): UserPublic | null {
  const user = userModel.findById(id);
  return user ? toPublicUser(user) : null;
}
