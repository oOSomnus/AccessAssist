// Per-tab serializer: page actions for one tab never overlap, and a stop
// cancels only the runs already queued when it arrived. A run also owns the
// crash marker, so a killed worker leaves `executing` behind for initialize.
export function createExecutionQueue({ session }) {
  const tabs = new Map(); // tabId -> { epoch, running, tail }
  const tabState = (tabId) => {
    let state = tabs.get(tabId);
    if (!state) tabs.set(tabId, state = { epoch: 0, running: null, tail: Promise.resolve() });
    return state;
  };
  return {
    run(tabId, task) {
      const state = tabState(tabId);
      const run = { epoch: state.epoch };
      const result = state.tail.then(async () => {
        state.running = run;
        // Written only once the run starts, so a queued run is never reported as interrupted.
        // shortcut: one global marker for all tabs; make it a per-tab key if concurrent multi-tab execution becomes common.
        await session.set({ executing: { tabId, at: Date.now() } }).catch(() => {});
        try {
          return { value: await task(), stopped: run.epoch !== state.epoch };
        } finally {
          if (state.running === run) state.running = null;
          await session.remove('executing').catch(() => {});
        }
      });
      state.tail = result.then(() => {}, () => {});
      return result;
    },
    stopped(tabId) {
      const state = tabs.get(tabId);
      return Boolean(state?.running && state.running.epoch !== state.epoch);
    },
    stop(tabId) {
      const state = tabs.get(tabId);
      if (state) state.epoch += 1;
    },
  };
}
