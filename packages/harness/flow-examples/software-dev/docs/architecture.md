# TaskFlow 技术架构文档

> **版本**: v1.0  
> **作者**: 开发工程师  
> **日期**: 2025-05  
> **状态**: 设计完成

---

## 1. 架构概述

TaskFlow 采用前后端分离的单页应用（SPA）架构，前端使用 React + TypeScript，后端使用 Node.js + Express + TypeScript，数据库采用 SQLite。整体架构分为三个主要层次：表现层、业务逻辑层和数据访问层。

```
┌─────────────────────────────────────────────────────────┐
│                    表现层 (Frontend)                      │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  React 18 + TypeScript + Vite                      │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐  │ │
│  │  │   Pages     │ │ Components  │ │   Hooks     │  │ │
│  │  └─────────────┘ └─────────────┘ └─────────────┘  │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    业务逻辑层 (Backend API)               │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Express.js + TypeScript                           │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐  │ │
│  │  │ Controllers │ │  Services   │ │  Middleware  │  │ │
│  │  └─────────────┘ └─────────────┘ └─────────────┘  │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    数据访问层 (Database)                  │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  SQLite + better-sqlite3                           │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐  │ │
│  │  │    ORM/     │ │   Models    │ │   Migrations│  │ │
│  │  │   Query     │ │             │ │             │  │ │
│  │  └─────────────┘ └─────────────┘ └─────────────┘  │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 技术栈选型

### 2.1 前端技术栈

| 技术 | 版本 | 选型理由 |
|------|------|----------|
| React | 18.x | 生态成熟、组件化开发、TypeScript 支持良好 |
| TypeScript | 5.x | 类型安全、更好的 IDE 支持、减少运行时错误 |
| Vite | 5.x | 快速的开发服务器启动、优秀的 HMR 性能 |
| Tailwind CSS | 3.x | 原子化 CSS、快速开发、响应式设计支持 |
| React Router | 6.x | 声明式路由、嵌套路由支持 |
| Axios | 1.x | Promise-based HTTP 客户端、请求/响应拦截器 |
| Zustand | 4.x | 轻量级状态管理、TypeScript 友好 |
| React Hook Form | 7.x | 高性能表单处理、表单验证 |
| Lucide React | 最新 | 轻量级图标库、Tree-shaking 支持 |
| date-fns | 3.x | 模块化日期处理库 |

### 2.2 后端技术栈

| 技术 | 版本 | 选型理由 |
|------|------|----------|
| Node.js | 20.x LTS | 稳定的长期支持版本 |
| Express | 4.x | 成熟稳定的 Web 框架、中间件生态丰富 |
| TypeScript | 5.x | 与前端保持一致、类型安全 |
| better-sqlite3 | 最新 | 同步 SQLite 驱动、性能优秀 |
| JWT (jsonwebtoken) | 9.x | 标准的 JWT 实现 |
| bcryptjs | 2.x | 密码哈希、跨平台兼容 |
| Zod | 3.x | TypeScript-first 的数据验证库 |
| CORS | 2.x | 跨域资源共享中间件 |
| Morgan | 1.x | HTTP 请求日志中间件 |

### 2.3 开发工具链

| 工具 | 用途 |
|------|------|
| ESLint | 代码规范检查 |
| Prettier | 代码格式化 |
| Vitest | 单元测试框架 |
| Playwright | E2E 测试框架 |
| tsx | TypeScript 运行时 |
| concurrently | 并行运行前端和后端 |

---

## 3. 系统架构设计

### 3.1 整体架构

```
                    ┌──────────────┐
                    │   Browser    │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   Vite Dev   │
                    │   Server     │
                    │  (Port 5173) │
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │              │
                    ▼              ▼
            ┌──────────┐  ┌──────────────┐
            │ Static   │  │   API        │
            │ Files    │  │   Proxy      │
            └──────────┘  └──────┬───────┘
                                 │
                                 ▼
                          ┌──────────────┐
                          │   Express    │
                          │   Server     │
                          │  (Port 3000) │
                          └──────┬───────┘
                                 │
                                 ▼
                          ┌──────────────┐
                          │   SQLite     │
                          │   Database   │
                          │  (taskflow.db)│
                          └──────────────┘
```

### 3.2 前端架构

```
src/
├── assets/                 # 静态资源
├── components/             # 可复用组件
│   ├── ui/                 # 基础 UI 组件
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Modal.tsx
│   │   ├── Select.tsx
│   │   ├── Badge.tsx
│   │   └── Toast.tsx
│   ├── layout/             # 布局组件
│   │   ├── AppLayout.tsx
│   │   ├── Header.tsx
│   │   ├── Sidebar.tsx
│   │   └── MobileNav.tsx
│   └── task/               # 任务相关组件
│       ├── TaskCard.tsx
│       ├── TaskForm.tsx
│       ├── TaskList.tsx
│       ├── TaskFilters.tsx
│       └── TaskStatusBadge.tsx
├── hooks/                  # 自定义 Hooks
│   ├── useAuth.ts
│   ├── useTasks.ts
│   └── useFilters.ts
├── lib/                    # 工具库
│   ├── api.ts              # API 客户端
│   ├── auth.ts             # 认证工具
│   ├── validation.ts       # 验证规则
│   └── utils.ts            # 通用工具函数
├── pages/                  # 页面组件
│   ├── LoginPage.tsx
│   ├── RegisterPage.tsx
│   ├── TaskListPage.tsx
│   ├── TaskDetailPage.tsx
│   └── DashboardPage.tsx   # P1
├── stores/                 # 状态管理
│   ├── authStore.ts
│   └── taskStore.ts
├── types/                  # TypeScript 类型定义
│   ├── task.ts
│   ├── user.ts
│   └── api.ts
├── App.tsx                 # 应用根组件
├── main.tsx                # 入口文件
└── router.tsx              # 路由配置
```

### 3.3 后端架构

```
src/
├── config/                 # 配置文件
│   ├── database.ts
│   ├── jwt.ts
│   └── cors.ts
├── controllers/            # 控制器层
│   ├── authController.ts
│   ├── taskController.ts
│   └── tagController.ts    # P1
├── middleware/             # 中间件
│   ├── authMiddleware.ts
│   ├── validationMiddleware.ts
│   ├── errorHandler.ts
│   └── requestLogger.ts
├── models/                 # 数据模型
│   ├── userModel.ts
│   ├── taskModel.ts
│   └── tagModel.ts         # P1
├── routes/                 # 路由定义
│   ├── authRoutes.ts
│   ├── taskRoutes.ts
│   └── index.ts
├── services/               # 业务逻辑层
│   ├── authService.ts
│   ├── taskService.ts
│   └── tagService.ts       # P1
├── types/                  # TypeScript 类型定义
│   ├── task.ts
│   ├── user.ts
│   └── express.d.ts
├── utils/                  # 工具函数
│   ├── password.ts
│   ├── token.ts
│   └── validation.ts
├── validation/             # 数据验证
│   ├── authValidation.ts
│   └── taskValidation.ts
├── app.ts                  # Express 应用配置
└── server.ts               # 服务器启动入口
```

---

## 4. 数据流设计

### 4.1 认证流程

```
┌─────────┐      ┌─────────┐      ┌─────────┐      ┌─────────┐
│ Browser │      │ Frontend│      │ Backend │      │ Database│
└────┬────┘      └────┬────┘      └────┬────┘      └────┬────┘
     │                │                │                │
     │ 1.点击登录      │                │                │
     │───────────────>│                │                │
     │                │ 2.POST /api/auth/login           │
     │                │───────────────>│                │
     │                │                │ 3.查询用户      │
     │                │                │───────────────>│
     │                │                │ 4.返回用户数据  │
     │                │                │<───────────────│
     │                │                │ 5.验证密码      │
     │                │                │ 6.生成JWT       │
     │                │ 7.返回token     │                │
     │                │<───────────────│                │
     │                │ 8.存储token     │                │
     │ 9.跳转到任务页  │                │                │
     │<───────────────│                │                │
     │                │                │                │
```

### 4.2 任务 CRUD 流程

```
┌─────────┐      ┌─────────┐      ┌─────────┐      ┌─────────┐
│ Browser │      │ Frontend│      │ Backend │      │ Database│
└────┬────┘      └────┬────┘      └────┬────┘      └────┬────┘
     │                │                │                │
     │ 1.填写任务表单  │                │                │
     │───────────────>│                │                │
     │                │ 2.POST /api/tasks               │
     │                │───────────────>│                │
     │                │                │ 3.验证数据(Zod) │
     │                │                │ 4.创建任务      │
     │                │                │───────────────>│
     │                │                │ 5.返回新任务    │
     │                │                │<───────────────│
     │                │ 6.返回任务数据  │                │
     │                │<───────────────│                │
     │ 7.更新列表显示  │                │                │
     │<───────────────│                │                │
```

### 4.3 状态流转流程

```
┌─────────┐      ┌─────────┐      ┌─────────┐      ┌─────────┐
│ Browser │      │ Frontend│      │ Backend │      │ Database│
└────┬────┘      └────┬────┘      └────┬────┘      └────┬────┘
     │                │                │                │
     │ 1.点击状态按钮  │                │                │
     │───────────────>│                │                │
     │                │ 2.乐观更新UI    │                │
     │                │ 3.PATCH /api/tasks/:id/status    │
     │                │───────────────>│                │
     │                │                │ 4.验证状态转换  │
     │                │                │ 5.更新数据库    │
     │                │                │───────────────>│
     │                │                │ 6.返回更新结果  │
     │                │                │<───────────────│
     │                │ 7.确认更新      │                │
     │                │ 8.失败时回滚UI  │                │
     │<───────────────│                │                │
```

---

## 5. API 接口设计

### 5.1 认证相关 API

#### 5.1.1 用户注册

```
POST /api/auth/register
```

**请求体**:
```json
{
  "email": "user@example.com",
  "password": "password123",
  "confirmPassword": "password123"
}
```

**成功响应** (201 Created):
```json
{
  "success": true,
  "message": "注册成功",
  "data": {
    "id": "uuid-string",
    "email": "user@example.com",
    "createdAt": "2025-05-21T10:00:00Z"
  }
}
```

**错误响应** (400 Bad Request):
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "该邮箱已被注册",
    "details": [
      {
        "field": "email",
        "message": "该邮箱已被注册"
      }
    ]
  }
}
```

#### 5.1.2 用户登录

```
POST /api/auth/login
```

**请求体**:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**成功响应** (200 OK):
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 86400,
    "user": {
      "id": "uuid-string",
      "email": "user@example.com"
    }
  }
}
```

**错误响应** (401 Unauthorized):
```json
{
  "success": false,
  "error": {
    "code": "AUTH_FAILED",
    "message": "邮箱或密码错误"
  }
}
```

#### 5.1.3 获取当前用户信息

```
GET /api/users/me
Authorization: Bearer <token>
```

**成功响应** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "uuid-string",
    "email": "user@example.com",
    "createdAt": "2025-05-21T10:00:00Z",
    "updatedAt": "2025-05-21T10:00:00Z"
  }
}
```

### 5.2 任务相关 API

#### 5.2.1 获取任务列表

```
GET /api/tasks
Authorization: Bearer <token>
```

**查询参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| status | string | 否 | 筛选状态: todo, in_progress, completed |
| priority | string | 否 | 筛选优先级: high, medium, low |
| sortBy | string | 否 | 排序字段: due_date, created_at |
| sortOrder | string | 否 | 排序方式: asc, desc |
| page | number | 否 | 页码，默认 1 |
| limit | number | 否 | 每页数量，默认 20 |

**成功响应** (200 OK):
```json
{
  "success": true,
  "data": {
    "tasks": [
      {
        "id": "uuid-string",
        "title": "完成项目报告",
        "description": "需要在周五前完成季度项目报告",
        "priority": "high",
        "status": "todo",
        "dueDate": "2025-05-23",
        "createdAt": "2025-05-21T10:00:00Z",
        "updatedAt": "2025-05-21T10:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 50,
      "totalPages": 3
    }
  }
}
```

#### 5.2.2 创建任务

```
POST /api/tasks
Authorization: Bearer <token>
```

**请求体**:
```json
{
  "title": "完成项目报告",
  "description": "需要在周五前完成季度项目报告",
  "priority": "high",
  "dueDate": "2025-05-23"
}
```

**成功响应** (201 Created):
```json
{
  "success": true,
  "data": {
    "id": "uuid-string",
    "title": "完成项目报告",
    "description": "需要在周五前完成季度项目报告",
    "priority": "high",
    "status": "todo",
    "dueDate": "2025-05-23",
    "createdAt": "2025-05-21T10:00:00Z",
    "updatedAt": "2025-05-21T10:00:00Z"
  }
}
```

#### 5.2.3 获取任务详情

```
GET /api/tasks/:id
Authorization: Bearer <token>
```

**成功响应** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "uuid-string",
    "title": "完成项目报告",
    "description": "需要在周五前完成季度项目报告",
    "priority": "high",
    "status": "todo",
    "dueDate": "2025-05-23",
    "createdAt": "2025-05-21T10:00:00Z",
    "updatedAt": "2025-05-21T10:00:00Z"
  }
}
```

#### 5.2.4 更新任务

```
PUT /api/tasks/:id
Authorization: Bearer <token>
```

**请求体**:
```json
{
  "title": "更新后的任务标题",
  "description": "更新后的描述",
  "priority": "medium",
  "dueDate": "2025-05-25"
}
```

**成功响应** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "uuid-string",
    "title": "更新后的任务标题",
    "description": "更新后的描述",
    "priority": "medium",
    "status": "todo",
    "dueDate": "2025-05-25",
    "createdAt": "2025-05-21T10:00:00Z",
    "updatedAt": "2025-05-21T12:00:00Z"
  }
}
```

#### 5.2.5 删除任务

```
DELETE /api/tasks/:id
Authorization: Bearer <token>
```

**成功响应** (200 OK):
```json
{
  "success": true,
  "message": "任务已删除"
}
```

#### 5.2.6 更新任务状态

```
PATCH /api/tasks/:id/status
Authorization: Bearer <token>
```

**请求体**:
```json
{
  "status": "in_progress"
}
```

**成功响应** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "uuid-string",
    "status": "in_progress",
    "updatedAt": "2025-05-21T12:00:00Z"
  }
}
```

### 5.3 错误码定义

| 错误码 | HTTP 状态码 | 说明 |
|--------|-------------|------|
| VALIDATION_ERROR | 400 | 数据验证失败 |
| AUTH_FAILED | 401 | 认证失败 |
| TOKEN_EXPIRED | 401 | Token 已过期 |
| UNAUTHORIZED | 401 | 未授权访问 |
| FORBIDDEN | 403 | 无权限访问 |
| NOT_FOUND | 404 | 资源不存在 |
| CONFLICT | 409 | 资源冲突（如邮箱重复） |
| INTERNAL_ERROR | 500 | 服务器内部错误 |

---

## 6. 数据模型设计

### 6.1 用户表 (users)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
```

### 6.2 任务表 (tasks)

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT CHECK(priority IN ('high', 'medium', 'low')) DEFAULT 'medium',
  status TEXT CHECK(status IN ('todo', 'in_progress', 'completed')) DEFAULT 'todo',
  due_date DATE,
  sort_order REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_tasks_user_id ON tasks(user_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_priority ON tasks(priority);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);
CREATE INDEX idx_tasks_sort_order ON tasks(sort_order);
```

### 6.3 标签表 (tags) — P1

```sql
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, name)
);

CREATE INDEX idx_tags_user_id ON tags(user_id);
```

### 6.4 任务标签关联表 (task_tags) — P1

```sql
CREATE TABLE task_tags (
  task_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (task_id, tag_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
```

---

## 7. 安全设计

### 7.1 认证与授权

- **JWT Token**: 使用 HS256 算法签名，有效期 24 小时
- **Token 存储**: 前端 localStorage（简化实现，生产环境建议 httpOnly Cookie）
- **密码加密**: bcrypt，cost factor = 10
- **权限隔离**: 用户只能访问自己的任务数据

### 7.2 输入验证

- **前端验证**: React Hook Form + Zod 验证
- **后端验证**: Zod schema 验证
- **SQL 注入防护**: 使用参数化查询
- **XSS 防护**: 输出编码、CSP 策略

### 7.3 CORS 配置

```typescript
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? 'https://taskflow.example.com' 
    : 'http://localhost:5173',
  credentials: true,
  optionsSuccessStatus: 200
};
```

---

## 8. 性能优化策略

### 8.1 前端优化

- **代码分割**: React.lazy + Suspense 路由级代码分割
- **图片优化**: 使用 WebP 格式、懒加载
- **缓存策略**: API 响应缓存、静态资源缓存
- **Bundle 优化**: Tree-shaking、代码压缩

### 8.2 后端优化

- **数据库索引**: 为常用查询字段创建索引
- **查询优化**: 避免 N+1 查询、使用 JOIN
- **分页查询**: 使用 LIMIT/OFFSET 分页
- **连接池**: SQLite 连接复用

### 8.3 性能指标

| 指标 | 目标值 | 实现方式 |
|------|--------|----------|
| 页面首次加载 | < 2 秒 | 代码分割、资源压缩 |
| API 响应时间 | < 200ms | 索引优化、查询优化 |
| 任务承载量 | ≥ 500 条 | 分页加载、虚拟滚动 |

---

## 9. 测试策略

### 9.1 单元测试

- **覆盖率目标**: ≥ 70%
- **测试框架**: Vitest
- **测试范围**: 工具函数、业务逻辑、API 接口

### 9.2 集成测试

- **API 测试**: Supertest 测试 REST API
- **数据库测试**: 内存 SQLite 测试数据访问层

### 9.3 E2E 测试

- **测试框架**: Playwright
- **测试场景**: 关键用户流程

---

## 10. 部署架构

### 10.1 开发环境

```bash
# 启动开发服务器
npm run dev

# 前端: http://localhost:5173
# 后端: http://localhost:3000
```

### 10.2 生产部署

```dockerfile
# Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
RUN npm ci --production
EXPOSE 3000
CMD ["npm", "start"]
```

### 10.3 部署选项

| 选项 | 适用场景 | 复杂度 |
|------|----------|--------|
| 本地运行 | 开发、演示 | 低 |
| Docker | 生产环境 | 中 |
| PM2 | Node.js 生产环境 | 中 |
| Nginx 反向代理 | 高并发场景 | 高 |

---

## 11. 监控与日志

### 11.1 日志策略

- **请求日志**: Morgan 记录 HTTP 请求
- **错误日志**: Winston 记录应用错误
- **调试日志**: 开发环境详细日志

### 11.2 监控指标

- API 响应时间
- 错误率
- 数据库查询性能
- 内存使用情况

---

## 12. 扩展性考虑

### 12.1 水平扩展

- **无状态设计**: JWT Token 认证，服务器无状态
- **数据库**: SQLite 单文件，易于备份和迁移
- **缓存层**: 可添加 Redis 缓存热点数据

### 12.2 功能扩展

- **标签系统**: P1 功能，数据库表已预留
- **多人协作**: P3 功能，需要用户权限模型扩展
- **文件附件**: P3 功能，需要对象存储集成

---

## 13. 风险评估

| 风险 | 影响 | 应对措施 |
|------|------|----------|
| SQLite 并发性能 | 中 | 单用户场景无问题，多人协作需迁移数据库 |
| JWT Token 安全 | 中 | 前端存储风险，可升级 httpOnly Cookie |
| 数据丢失 | 高 | 定期备份、事务保护 |
| 性能瓶颈 | 中 | 数据库索引、查询优化、分页加载 |

---

## 14. 总结

TaskFlow 采用成熟的技术栈和清晰的架构设计，确保：

1. **开发效率**: TypeScript 全栈类型安全，减少运行时错误
2. **用户体验**: 响应式设计，快速加载，流畅交互
3. **可维护性**: 模块化设计，清晰的代码组织
4. **可扩展性**: 预留 P1/P2 功能扩展点
5. **安全性**: JWT 认证、输入验证、SQL 注入防护

技术选型理由充分，架构设计合理，能够满足 MVP 阶段的所有需求，并为后续功能扩展奠定良好基础。

---

## 15. 需求对齐确认

### 15.1 与任务目标（goal.md）对齐

| 目标要求 | 架构方案 | 状态 |
|----------|----------|------|
| 前端: React 18 + TypeScript + Vite | React 18.x + TypeScript 5.x + Vite 5.x | ✅ |
| 后端: Node.js + Express + TypeScript | Node.js 20.x + Express 4.x + TypeScript 5.x | ✅ |
| 数据库: SQLite | SQLite + better-sqlite3 | ✅ |
| 认证: JWT + bcrypt | jsonwebtoken 9.x + bcryptjs 2.x | ✅ |
| API 风格: RESTful JSON API | RESTful API 设计，统一 JSON 响应格式 | ✅ |
| 代码规范: ESLint + Prettier | ESLint + Prettier 已纳入工具链 | ✅ |
| 首次加载 < 2 秒 | 代码分割、资源压缩、Tree-shaking | ✅ |
| API 响应 < 200ms | 数据库索引、查询优化 | ✅ |
| 500 条任务无性能下降 | 分页加载、索引优化 | ✅ |
| 测试覆盖率 ≥ 70% | Vitest 单元测试 + Playwright E2E | ✅ |
| 一键启动 `npm start` | concurrently 并行运行前后端 | ✅ |
| Dockerfile 支持容器化 | 多阶段 Docker 构建 | ✅ |
| 不依赖外部服务 | SQLite 本地文件，无云服务依赖 | ✅ |

### 15.2 与 PRD（prd.md）对齐

| PRD 需求 | 架构覆盖 | 状态 |
|----------|----------|------|
| F01 用户注册与登录 | authController + authService + JWT/bcrypt | ✅ |
| F02 任务 CRUD | taskController + taskService + taskModel | ✅ |
| F03 任务列表与筛选 | GET /api/tasks 支持 status/priority/sortBy/page | ✅ |
| F04 任务状态流转 | PATCH /api/tasks/:id/status + 乐观更新 | ✅ |
| F05 响应式 Web 界面 | Tailwind CSS 响应式断点 + 移动端适配 | ✅ |
| F06 标签系统（P1） | tags + task_tags 表 + tagController/Service | ✅ |
| F07 任务搜索（P1） | GET /api/tasks/search + SQLite LIKE 查询 | ✅ |
| F08 统计仪表盘（P1） | GET /api/tasks/stats | ✅ |
| 密码 bcrypt 存储 | bcryptjs, cost factor = 10 | ✅ |
| JWT Token 有效期 ≤ 24h | jwt.ts 配置 expiresIn: 86400 | ✅ |
| 前后端双重校验 | React Hook Form + Zod（前端）/ Zod（后端） | ✅ |
| 权限隔离 | authMiddleware + user_id 过滤查询 | ✅ |
| 数据模型 users 表 | id/email/password_hash/created_at/updated_at | ✅ |
| 数据模型 tasks 表 | 含 sort_order 字段支持拖拽排序（P2） | ✅ |

### 15.3 PRD 开放问题决策

| 编号 | 问题 | 架构决策 |
|------|------|----------|
| Q01 | JWT Token 存储位置 | MVP 使用 localStorage，Axios 拦截器统一注入；生产环境可升级 httpOnly Cookie |
| Q02 | 任务排序持久化 | tasks 表 sort_order REAL 字段，浮点数权重方案 |
| Q03 | 搜索技术方案 | P1 使用 SQLite LIKE 查询（简单够用），后续可升级 FTS5 全文搜索 |
| Q04 | 任务回收站 | 本期不实现，DELETE 直接物理删除（ON DELETE CASCADE） |