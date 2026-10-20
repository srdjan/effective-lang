// Debouncing of file system events. An editor save often gives several events in
// a row. `debounceBatches` joins the events that arrive within `delayMs` of the
// previous one into one batch of sorted, unique paths.

interface Timer {
  readonly promise: Promise<"quiet">;
  cancel(): void;
}

function timer(ms: number): Timer {
  let id: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"quiet">((resolve) => {
    id = setTimeout(() => resolve("quiet"), ms);
  });
  return { promise, cancel: () => clearTimeout(id) };
}

export async function* debounceBatches(
  source: AsyncIterable<readonly string[]>,
  delayMs: number,
): AsyncGenerator<readonly string[]> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    let pending: Promise<IteratorResult<readonly string[]>> | undefined;
    while (true) {
      pending ??= iterator.next();
      const first = await pending;
      pending = undefined;
      if (first.done) return;
      const batch = new Set<string>(first.value);
      let ended = false;
      while (true) {
        pending = iterator.next();
        const wait = timer(delayMs);
        const raced = await Promise.race([pending, wait.promise]);
        wait.cancel();
        if (raced === "quiet") break;
        pending = undefined;
        if (raced.done) {
          ended = true;
          break;
        }
        for (const path of raced.value) batch.add(path);
      }
      yield [...batch].sort();
      if (ended) return;
    }
  } finally {
    await iterator.return?.();
  }
}
