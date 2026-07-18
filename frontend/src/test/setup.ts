import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// Node >= 22 defines a globalThis.localStorage that is unusable unless
// --localstorage-file is set, and it shadows jsdom's storage in the vitest
// global scope. Replace it with an in-memory Storage when it is broken.
const storageBroken = (() => {
  try {
    return typeof globalThis.localStorage?.clear !== "function";
  } catch {
    return true;
  }
})();
if (storageBroken) {
  const makeStorage = (): Storage => {
    const data = new Map<string, string>();
    return {
      get length() { return data.size; },
      clear: () => data.clear(),
      getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
      key: (index: number) => [...data.keys()][index] ?? null,
      removeItem: (key: string) => { data.delete(key); },
      setItem: (key: string, value: string) => { data.set(key, String(value)); },
    };
  };
  for (const key of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, key, { value: makeStorage(), configurable: true, writable: true });
  }
}

beforeEach(() => {
  localStorage.clear();
  if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => "blob:mock");
  if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
