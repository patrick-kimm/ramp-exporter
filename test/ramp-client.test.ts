import { describe, expect, test } from "bun:test";
import { RampApiError, RampAuthError, RampClient } from "../src/ramp/client";
import { startMockRamp } from "./mock-ramp";

const creds = { clientId: "id", clientSecret: "secret" };
const fast = { rateLimitRps: 1000, sleepImpl: async () => {} };

describe("RampClient", () => {
  test("authenticates and paginates across all pages, verbatim", async () => {
    const users = [{ id: "u1" }, { id: "u2" }, { id: "u3" }, { id: "u4" }, { id: "u5" }];
    const mock = startMockRamp({ resources: { users }, pageSize: 2 });
    try {
      const client = new RampClient({ apiBase: mock.url, credentials: creds, scopes: ["users:read"], ...fast });
      const out: unknown[] = [];
      for await (const r of client.paginate("/users")) out.push(r);
      expect(out).toEqual(users);
      // 1 token + 3 pages (2+2+1)
      expect(mock.requests.filter((r) => r.path.endsWith("/users")).length).toBe(3);
    } finally {
      mock.stop();
    }
  });

  test("retries on 429 then succeeds", async () => {
    const users = [{ id: "u1" }];
    const mock = startMockRamp({ resources: { users }, failTimes: 2 });
    try {
      const client = new RampClient({ apiBase: mock.url, credentials: creds, maxRetries: 5, ...fast });
      const out: unknown[] = [];
      for await (const r of client.paginate("/users")) out.push(r);
      expect(out).toEqual(users);
    } finally {
      mock.stop();
    }
  });

  test("gives up after maxRetries with RampApiError", async () => {
    const mock = startMockRamp({ resources: { users: [{ id: "u1" }] }, failTimes: 99 });
    try {
      const client = new RampClient({ apiBase: mock.url, credentials: creds, maxRetries: 1, ...fast });
      const run = async () => {
        for await (const _ of client.paginate("/users")) void _;
      };
      await expect(run()).rejects.toBeInstanceOf(RampApiError);
    } finally {
      mock.stop();
    }
  });

  test("throws RampAuthError on bad credentials", async () => {
    const mock = startMockRamp({ rejectAuth: true });
    try {
      const client = new RampClient({ apiBase: mock.url, credentials: creds, ...fast });
      await expect(client.authenticate()).rejects.toBeInstanceOf(RampAuthError);
    } finally {
      mock.stop();
    }
  });
});
