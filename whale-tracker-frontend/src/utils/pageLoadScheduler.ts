/** Start each page once; finish the visible page before preloading its peer. */
export function createPageLoadScheduler<T extends string>(loaders: Record<T, () => Promise<unknown>>) {
  const pending = new Map<T, Promise<unknown>>();
  function load(page: T) {
    let promise = pending.get(page);
    if (!promise) {
      promise = Promise.resolve().then(loaders[page]).catch(error => {
        pending.delete(page);
        throw error;
      });
      pending.set(page, promise);
    }
    return promise;
  }
  async function start(primary: T, secondary: T, active = () => true) {
    await load(primary).catch(() => undefined);
    if (active()) await load(secondary).catch(() => undefined);
  }
  return { load, start };
}
