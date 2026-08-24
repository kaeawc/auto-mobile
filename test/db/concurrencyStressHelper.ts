export interface ConcurrentSameKeyStressOptions<T> {
  count: number;
  act: (index: number) => Promise<T>;
}

/**
 * Fire same-key repository calls from one release point so their individual DB
 * statements contend through the real dialect connection mutex.
 */
export async function runConcurrentSameKeyStress<T>({
  count,
  act,
}: ConcurrentSameKeyStressOptions<T>): Promise<T[]> {
  if (count < 1) {
    throw new Error("concurrency stress count must be at least 1");
  }

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tasks = Array.from({ length: count }, async (_unused, index) => {
    await gate;
    return act(index);
  });

  release();
  return Promise.all(tasks);
}
