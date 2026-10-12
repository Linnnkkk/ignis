export class EventEmitter {
  static defaultMaxListeners = 10;

  static setMaxListeners(n, ...targets) {
    if (typeof n !== "number" || n < 0 || Number.isNaN(n)) {
      throw new RangeError("The maximum listener count must be a non-negative number");
    }
    if (targets.length === 0) {
      EventEmitter.defaultMaxListeners = n;
    }
    for (const target of targets) {
      if (target && typeof target.setMaxListeners === "function") {
        target.setMaxListeners(n);
      } else if (!(typeof EventTarget !== "undefined" && target instanceof EventTarget)) {
        throw new TypeError("Expected an EventEmitter or EventTarget");
      }
    }
  }

  constructor() {
    this._events = {};
    this._maxListeners = EventEmitter.defaultMaxListeners;
  }

  on(event, listener) {
    if (!this._events[event]) {
      this._events[event] = [];
    }

    this._events[event].push(listener);

    return this;
  }

  once(event, listener) {
    const wrapped = (...args) => {
      this.removeListener(event, wrapped);
      listener.apply(this, args);
    };

    wrapped._original = listener;
    return this.on(event, wrapped);
  }

  emit(event, ...args) {
    const listeners = this._events[event];

    if (!listeners || listeners.length === 0) {
      return false;
    }

    // Iterate a snapshot: a once-listener removes itself from this array during emit, which would corrupt a live iteration.
    // eslint-disable-next-line unicorn/no-useless-spread
    for (const fn of [...listeners]) {
      fn.apply(this, args);
    }

    return true;
  }

  removeListener(event, listener) {
    const arr = this._events[event];
    if (!arr) {
      return this;
    }

    const idx = arr.findIndex(
      (fn) => fn === listener || fn._original === listener,
    );

    if (idx >= 0) {
      arr.splice(idx, 1);
    }

    return this;
  }

  off(event, listener) {
    return this.removeListener(event, listener);
  }

  removeAllListeners(event) {
    if (event) {
      delete this._events[event];
    } else {
      this._events = {};
    }

    return this;
  }

  listeners(event) {
    return (this._events[event] || []).slice();
  }

  listenerCount(event) {
    return (this._events[event] || []).length;
  }

  addListener(event, listener) {
    return this.on(event, listener);
  }

  prependListener(event, listener) {
    if (!this._events[event]) {
      this._events[event] = [];
    }

    this._events[event].unshift(listener);

    return this;
  }

  eventNames() {
    return Object.keys(this._events);
  }

  setMaxListeners(n) {
    if (typeof n !== "number" || n < 0 || Number.isNaN(n)) {
      throw new RangeError("The maximum listener count must be a non-negative number");
    }
    this._maxListeners = n;
    return this;
  }

  getMaxListeners() {
    return this._maxListeners;
  }
}

export const setMaxListeners = EventEmitter.setMaxListeners;

export default EventEmitter;
