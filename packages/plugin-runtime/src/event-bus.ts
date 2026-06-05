export type HookKind = "intercept" | "transform" | "observe" | "config";

export type HookFailurePolicy = "fail-open" | "fail-closed";

export interface HookRuntimeContext {
  pluginId: string;
  sessionId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface HookEvent<TValue = unknown> {
  name: string;
  value: TValue;
  ctx: HookRuntimeContext;
}

export interface InterceptHandled<TResult = unknown> {
  handled: true;
  result: TResult;
}

export interface InterceptContinue<TValue = unknown> {
  handled?: false;
  value?: TValue;
}

export type InterceptResult<TResult = unknown, TValue = unknown> =
  | InterceptHandled<TResult>
  | InterceptContinue<TValue>
  | TResult
  | null
  | undefined;

export type InterceptHook<TValue = unknown, TResult = unknown> = (
  event: HookEvent<TValue>,
) => Promise<InterceptResult<TResult, TValue>> | InterceptResult<TResult, TValue>;

export type TransformHook<TValue = unknown> = (event: HookEvent<TValue>) => Promise<TValue> | TValue;

export type ObserveHook<TValue = unknown> = (event: HookEvent<TValue>) => Promise<void> | void;

export interface HookRegistrationOptions {
  pluginId?: string;
  scope?: string;
  priority?: number;
  enforce?: "pre" | "post";
  timeoutMs?: number;
  critical?: boolean;
  failurePolicy?: HookFailurePolicy;
}

export interface HookRegistration extends Required<Omit<HookRegistrationOptions, "pluginId" | "timeoutMs">> {
  id: number;
  pluginId: string;
  event: string;
  kind: HookKind;
  timeoutMs?: number;
  handler: InterceptHook | TransformHook | ObserveHook;
}

export interface HookRegistrar {
  intercept<TValue = unknown, TResult = unknown>(
    event: string,
    handler: InterceptHook<TValue, TResult>,
    options?: HookRegistrationOptions,
  ): { dispose(): void };
  transform<TValue = unknown>(
    event: string,
    handler: TransformHook<TValue>,
    options?: HookRegistrationOptions,
  ): { dispose(): void };
  observe<TValue = unknown>(
    event: string,
    handler: ObserveHook<TValue>,
    options?: HookRegistrationOptions,
  ): { dispose(): void };
  config<TValue = unknown>(
    event: string,
    handler: TransformHook<TValue>,
    options?: HookRegistrationOptions,
  ): { dispose(): void };
}

export class HookExecutionError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "HookExecutionError";
    this.cause = cause;
  }
}

export class EventBus implements HookRegistrar {
  private readonly registrations: HookRegistration[] = [];
  private nextId = 1;

  intercept<TValue = unknown, TResult = unknown>(
    event: string,
    handler: InterceptHook<TValue, TResult>,
    options: HookRegistrationOptions = {},
  ): { dispose(): void } {
    return this.register("intercept", event, handler as InterceptHook, options);
  }

  transform<TValue = unknown>(
    event: string,
    handler: TransformHook<TValue>,
    options: HookRegistrationOptions = {},
  ): { dispose(): void } {
    return this.register("transform", event, handler as TransformHook, options);
  }

  observe<TValue = unknown>(
    event: string,
    handler: ObserveHook<TValue>,
    options: HookRegistrationOptions = {},
  ): { dispose(): void } {
    return this.register("observe", event, handler as ObserveHook, options);
  }

  config<TValue = unknown>(
    event: string,
    handler: TransformHook<TValue>,
    options: HookRegistrationOptions = {},
  ): { dispose(): void } {
    return this.register("config", event, handler as TransformHook, options);
  }

  async emitIntercept<TValue = unknown, TResult = unknown>(
    eventName: string,
    value: TValue,
    ctx: HookRuntimeContext,
  ): Promise<{ handled: true; result: TResult } | { handled: false; value: TValue }> {
    let currentValue = value;
    const hooks = this.matching("intercept", eventName);
    for (const hook of hooks) {
      const result = await this.runHook(
        hook,
        { name: eventName, value: currentValue, ctx },
      ) as InterceptResult<TResult, TValue>;
      if (result === null || result === undefined) continue;
      if (isInterceptHandled<TResult>(result)) {
        return { handled: true, result: result.result };
      }
      if (isInterceptContinue<TValue>(result)) {
        if ("value" in result && result.value !== undefined) {
          currentValue = result.value;
        }
        continue;
      }
      return { handled: true, result: result as TResult };
    }
    return { handled: false, value: currentValue };
  }

  async emitTransform<TValue = unknown>(
    eventName: string,
    value: TValue,
    ctx: HookRuntimeContext,
  ): Promise<TValue> {
    let currentValue = value;
    const hooks = this.matching("transform", eventName);
    for (const hook of hooks) {
      currentValue = await this.runHook(
        hook,
        { name: eventName, value: currentValue, ctx },
      ) as TValue;
    }
    return currentValue;
  }

  async emitConfig<TValue = unknown>(
    eventName: string,
    value: TValue,
    ctx: HookRuntimeContext,
  ): Promise<TValue> {
    let currentValue = value;
    const hooks = this.matching("config", eventName);
    for (const hook of hooks) {
      currentValue = await this.runHook(
        hook,
        { name: eventName, value: currentValue, ctx },
      ) as TValue;
    }
    return currentValue;
  }

  async emitObserve<TValue = unknown>(
    eventName: string,
    value: TValue,
    ctx: HookRuntimeContext,
  ): Promise<void> {
    const hooks = this.matching("observe", eventName);
    await Promise.all(
      hooks.map(async (hook) => {
        try {
          await this.runHook(hook, { name: eventName, value, ctx });
        } catch {
          // observe hooks fail-open by contract
        }
      }),
    );
  }

  removeByPlugin(pluginId: string): void {
    for (let idx = this.registrations.length - 1; idx >= 0; idx--) {
      if (this.registrations[idx]?.pluginId === pluginId) {
        this.registrations.splice(idx, 1);
      }
    }
  }

  list(): HookRegistration[] {
    return [...this.registrations];
  }

  createRegistrar(pluginId: string, scope: string): HookRegistrar {
    const withOwner = (options?: HookRegistrationOptions): HookRegistrationOptions => ({
      ...options,
      pluginId,
      scope: options?.scope ?? scope,
    });
    return {
      intercept: (event, handler, options) => this.intercept(event, handler, withOwner(options)),
      transform: (event, handler, options) => this.transform(event, handler, withOwner(options)),
      observe: (event, handler, options) => this.observe(event, handler, withOwner(options)),
      config: (event, handler, options) => this.config(event, handler, withOwner(options)),
    };
  }

  private register(
    kind: HookKind,
    event: string,
    handler: HookRegistration["handler"],
    options: HookRegistrationOptions,
  ): { dispose(): void } {
    const registration: HookRegistration = {
      id: this.nextId++,
      pluginId: options.pluginId ?? "anonymous",
      event,
      kind,
      scope: options.scope ?? "global",
      priority: options.priority ?? 0,
      enforce: options.enforce ?? "pre",
      critical: options.critical ?? false,
      failurePolicy: options.failurePolicy ?? (options.critical ? "fail-closed" : "fail-open"),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      handler,
    };
    this.registrations.push(registration);
    return {
      dispose: () => {
        const idx = this.registrations.findIndex((item) => item.id === registration.id);
        if (idx >= 0) this.registrations.splice(idx, 1);
      },
    };
  }

  private matching(kind: HookKind, eventName: string): HookRegistration[] {
    return this.registrations
      .filter((hook) => hook.kind === kind && matchesGlob(hook.event, eventName))
      .sort(compareHooks);
  }

  private async runHook(hook: HookRegistration, event: HookEvent): Promise<unknown> {
    try {
      return await withOptionalTimeout(
        Promise.resolve(hook.handler(event)),
        hook.timeoutMs,
        `Hook ${hook.pluginId}:${hook.event} timed out after ${hook.timeoutMs}ms`,
      );
    } catch (error) {
      if (hook.failurePolicy === "fail-open") {
        if (hook.kind === "intercept" || hook.kind === "observe") return undefined;
        return event.value;
      }
      throw new HookExecutionError(`Hook ${hook.pluginId}:${hook.event} failed`, error);
    }
  }
}

function compareHooks(a: HookRegistration, b: HookRegistration): number {
  const enforceOrder = enforceRank(a.enforce) - enforceRank(b.enforce);
  if (enforceOrder !== 0) return enforceOrder;
  const priorityOrder = b.priority - a.priority;
  if (priorityOrder !== 0) return priorityOrder;
  return a.id - b.id;
}

function enforceRank(value: "pre" | "post"): number {
  return value === "pre" ? 0 : 1;
}

function matchesGlob(pattern: string, eventName: string): boolean {
  if (pattern === eventName || pattern === "*") return true;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(eventName);
}

function isInterceptHandled<TResult>(value: unknown): value is InterceptHandled<TResult> {
  return typeof value === "object" && value !== null && (value as InterceptHandled).handled === true;
}

function isInterceptContinue<TValue>(value: unknown): value is InterceptContinue<TValue> {
  return typeof value === "object"
    && value !== null
    && (value as InterceptContinue).handled === false;
}

async function withOptionalTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, message: string): Promise<T> {
  if (timeoutMs === undefined) return promise;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
