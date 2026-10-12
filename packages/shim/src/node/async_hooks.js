// Minimal async_hooks. Browsers cannot propagate context across awaits, so the
// store is only visible during the synchronous part of run(). Callers that use
// `getStore() ?? default` (e.g. the Claude Agent SDK bundled in Copilot) work.
export class AsyncLocalStorage {
  #store = undefined;

  run(store, fn, ...args) {
    const prev = this.#store;
    this.#store = store;
    try {
      return fn(...args);
    } finally {
      this.#store = prev;
    }
  }

  exit(fn, ...args) {
    return this.run(undefined, fn, ...args);
  }

  getStore() {
    return this.#store;
  }

  enterWith(store) {
    this.#store = store;
  }

  disable() {
    this.#store = undefined;
  }
}

export default { AsyncLocalStorage };
