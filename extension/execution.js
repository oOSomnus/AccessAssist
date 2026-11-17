// Per-tab serializer: page actions for one tab never overlap, and a stop
// cancels only the runs already queued when it arrived.
export function createExecutionQueue() {
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
        try {
          return { value: await task(), stopped: run.epoch !== state.epoch };
        } finally {
          if (state.running === run) state.running = null;
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
