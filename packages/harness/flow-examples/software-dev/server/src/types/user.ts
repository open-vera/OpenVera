export interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserInput {
  email: string;
  password: string;
}

export interface UserPublic {
  id: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}
