export interface Disposable {
  dispose(): void | Promise<void>;
}

export type DisposableLike = Disposable | (() => void | Promise<void>);

export class DisposableStore implements Disposable {
  private readonly disposables: DisposableLike[] = [];
  private disposed = false;

  add(disposable: DisposableLike): DisposableLike {
    if (this.disposed) {
      void disposeOne(disposable);
      return disposable;
    }
    this.disposables.push(disposable);
    return disposable;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const errors: unknown[] = [];
    for (const disposable of this.disposables.splice(0).reverse()) {
      try {
        await disposeOne(disposable);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Multiple disposables failed");
    }
  }
}

async function disposeOne(disposable: DisposableLike): Promise<void> {
  if (typeof disposable === "function") {
    await disposable();
    return;
  }
  await disposable.dispose();
}
