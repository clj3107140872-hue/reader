export class Semaphore {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) {
      this.active++
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    try {
      return await task()
    } finally {
      // The woken waiter inherits the releasing slot, so `active` never dips
      // below the number of tasks that are about to run.
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}

/** Serializes work per key while allowing different keys to run together. */
export class KeyedLocks {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.catch(() => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return run
  }
}
