// Shared test setup — installs a hand-rolled `chrome.*` mock on globalThis
// (chrome namespace, NOT browser.*). Foundation-owned; build agents import the
// helpers below and extend per-test with vi.fn() overrides. Call resetChrome()
// in a beforeEach to get a clean in-memory storage + fresh listener sets.
import { beforeEach, vi } from "vitest";

type Listener = (...args: unknown[]) => unknown;

export interface FakeEvent {
  addListener: (fn: Listener) => void;
  removeListener: (fn: Listener) => void;
  hasListener: (fn: Listener) => boolean;
  /** test helper: invoke all listeners, returning the first defined result */
  emit: (...args: unknown[]) => unknown;
  listeners: Set<Listener>;
}

function makeEvent(): FakeEvent {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    emit: (...args) => {
      let result: unknown;
      for (const fn of listeners) {
        const r = fn(...args);
        if (r !== undefined && result === undefined) result = r;
      }
      return result;
    },
  };
}

export interface FakeChrome {
  runtime: {
    id: string | undefined;
    sendMessage: ReturnType<typeof vi.fn>;
    onMessage: FakeEvent;
    lastError?: { message: string };
  };
  tabs: {
    sendMessage: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    onRemoved: FakeEvent;
    onUpdated: FakeEvent;
  };
  storage: {
    local: {
      _data: Record<string, unknown>;
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
      setAccessLevel: ReturnType<typeof vi.fn>;
    };
  };
  scripting: {
    executeScript: ReturnType<typeof vi.fn>;
    insertCSS: ReturnType<typeof vi.fn>;
  };
  cookies: {
    get: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    onChanged: FakeEvent;
  };
  webRequest: {
    onCompleted: FakeEvent;
  };
}

export function makeChrome(): FakeChrome {
  const store: Record<string, unknown> = {};
  return {
    runtime: {
      id: "test-extension-id",
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: makeEvent(),
    },
    tabs: {
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 1 }),
      remove: vi.fn().mockResolvedValue(undefined),
      onRemoved: makeEvent(),
      onUpdated: makeEvent(),
    },
    storage: {
      local: {
        _data: store,
        // chrome.storage.local.get supports four shapes (we mirror them):
        //   undefined → return the whole store
        //   string    → return {[key]: store[key]} if present
        //   array     → return {[k]: store[k]} for each present k
        //   object    → return defaults merged with stored values (defaults seed missing keys)
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
          if (keys == null) return { ...store };
          if (typeof keys === "string") {
            return keys in store ? { [keys]: store[keys] } : {};
          }
          if (Array.isArray(keys)) {
            const out: Record<string, unknown> = {};
            for (const k of keys) {
              if (k in store) out[k] = store[k];
            }
            return out;
          }
          // object form: defaults; merge stored over them.
          const out: Record<string, unknown> = { ...keys };
          for (const k of Object.keys(keys)) {
            if (k in store) out[k] = store[k];
          }
          return out;
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        }),
        // chrome.storage.local.remove accepts a string or array of strings.
        remove: vi.fn(async (keys: string | string[]) => {
          const arr = typeof keys === "string" ? [keys] : keys;
          for (const k of arr) delete store[k];
        }),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([]),
      insertCSS: vi.fn().mockResolvedValue(undefined),
    },
    cookies: {
      get: vi.fn().mockResolvedValue(null),
      remove: vi.fn().mockResolvedValue(undefined),
      onChanged: makeEvent(),
    },
    webRequest: {
      onCompleted: makeEvent(),
    },
  };
}

/** Install a fresh fake chrome on globalThis and return it. */
export function resetChrome(): FakeChrome {
  const c = makeChrome();
  (globalThis as { chrome?: unknown }).chrome = c;
  return c;
}

beforeEach(() => {
  resetChrome();
});
