/**
 * The handful of assertions the tests were written against, on top of
 * Vitest's expect. Keeping the names keeps each test's intent readable: an
 * assertStringIncludes says what was looked for, where expect chains bury it.
 */

import { expect } from "vite-plus/test";

export function assert(cond: unknown, msg?: string): asserts cond {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  expect(actual, msg).toStrictEqual(expected);
}

export function assertMatch(actual: string, re: RegExp, msg?: string): void {
  expect(actual, msg).toMatch(re);
}

export function assertStringIncludes(actual: string, expected: string, msg?: string): void {
  expect(actual, msg).toContain(expected);
}

export function assertThrows<E extends Error>(
  fn: () => unknown,
  type: new (...args: never[]) => E,
): E {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(type);
    return e as E;
  }
  throw new Error("expected a throw");
}
