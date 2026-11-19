/** Thrown by `Slots` when every slot is taken and the wait list is full. */
export class SlotsFullError extends Error {
  constructor() {
    super("every slot is taken and the wait list is full");
    this.name = "SlotsFullError";
  }
}

/**
 * Runs at most `size` tasks at once; the rest wait their turn in arrival
 * order, up to `maxWaiting` of them, and past that `use` throws SlotsFullError.
 */
export class Slots {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(
    size: number,
    private readonly maxWaiting: number = Infinity,
  ) {
    this.free = size;
  }

  async use<T>(task: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else if (this.waiting.length >= this.maxWaiting) throw new SlotsFullError();
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}
