// One owner for "is this still the same turn?". A turn ends when the next one
// starts (next) or when it is cancelled in place (cancel); its signal aborts either way.
export function createTurns() {
  let current;
  const make = () => {
    const controller = new AbortController();
    const turn = {
      signal: controller.signal,
      cancel: () => controller.abort(),
      isCurrent: () => current === turn,
      get stale() { return current !== turn || controller.signal.aborted; },
    };
    return turn;
  };
  current = make();
  return {
    get current() { return current; },
    next() { current.cancel(); current = make(); return current; },
  };
}
