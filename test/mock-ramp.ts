import { startMockSource, type MockSource } from "./mock-source";

export type MockRamp = MockSource;

export interface MockRampOptions {
  /** resource name (last path segment) -> all of its records */
  resources?: Record<string, unknown[]>;
  pageSize?: number;
  /** Return 429 this many times before succeeding (counts down globally). */
  failTimes?: number;
  validToken?: string;
  /** Make the token endpoint reject credentials. */
  rejectAuth?: boolean;
  /** Make the token endpoint reject with this status and body (e.g. a 403 naming a missing scope). */
  rejectAuthWith?: { status: number; body: string };
}

export function startMockRamp(opts: MockRampOptions = {}): MockRamp {
  return startMockSource({
    style: "ramp",
    bySegment: opts.resources,
    pageSize: opts.pageSize,
    failTimes: opts.failTimes,
    token: opts.validToken,
    rejectAuth: opts.rejectAuth,
    rejectAuthWith: opts.rejectAuthWith,
  });
}
