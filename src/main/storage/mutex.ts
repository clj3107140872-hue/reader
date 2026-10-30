/**
 * Serializes async critical sections. Tasks run in call order; a failed task
 * does not block the next one.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.catch(() => undefined)
    return run
  }
}
