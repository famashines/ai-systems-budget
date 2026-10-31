import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MongoNetworkError } from "mongodb";
import type { JwtVerifier } from "@famashines/ai-systems-kit/auth";
import { createService, ForbiddenError, UnauthorizedError } from "@famashines/ai-systems-kit/http";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import { createMemoryEventStore, fakeClock, fakeIds } from "@famashines/ai-systems-kit/testing";
import { routes, toDomainError } from "../../src/adapters/http.ts";
import { createLedger } from "../../src/application/ledger.ts";
import { ReservationConflictError } from "../../src/domain/budget.ts";

const clock = fakeClock();
const store = createMemoryEventStore({ now: clock.now, newId: fakeIds(1) });
const ledger = createLedger({ store, timeZone: "Europe/Berlin", now: clock.now });
const tokens: Record<string, JwtVerifier> = {
  owner: () => Promise.resolve({ sub: "owner-1", roles: ["owner"], exp: 0 }),
  guest: () => Promise.reject(new ForbiddenError("The role is missing")),
};
const verify: JwtVerifier = (token) =>
  (tokens[token] ?? (() => Promise.reject(new UnauthorizedError())))(token);
let failing = false;
const app = createService({
  logger: createLogger({ service: "budget", release: "test", level: "silent" }),
  routes: routes({
    ledger: {
      setBudget: (...args) =>
        failing ? Promise.reject(new MongoNetworkError("down")) : ledger.setBudget(...args),
    },
    store,
    verify,
  }),
  drainDelayMs: 0,
});
let base: string;

before(async () => {
  const { port } = await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${String(port)}`;
});

after(async () => {
  await app.close();
});

const commandIds = fakeIds(3);

const envelope = (overrides: Record<string, unknown> = {}) => ({
  commandId: commandIds(),
  type: "budget.SetBudget",
  actor: { kind: "owner", id: "owner-1" },
  payload: { scope: { kind: "month" }, hardCapMicroUsd: 50_000, softCapMicroUsd: 40_000 },
  ...overrides,
});

const setBudget = (body: unknown, token: string | null = "owner") =>
  fetch(`${base}/internal/commands/set-budget`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

const problem = async (response: Response) => ({
  status: response.status,
  code: ((await response.json()) as { code: string }).code,
});

test("the owner sets the month cap: 201, then 200 with the same answer for the same id", async () => {
  const command = envelope();
  const first = await setBudget(command);
  assert.equal(first.status, 201);
  const answer = (await first.json()) as { version: number };
  const second = await setBudget(command);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), answer);
  const [event] = await store.readStream("budget-cap-month");
  assert.deepEqual(event?.payload, command.payload);
});

test("no token gives 401, a token without the owner role gives 403", async () => {
  assert.deepEqual(await problem(await setBudget(envelope(), null)), {
    status: 401,
    code: "unauthorized",
  });
  assert.deepEqual(await problem(await setBudget(envelope(), "guest")), {
    status: 403,
    code: "forbidden",
  });
});

test("an actor that is not the subject of the token gives 403", async () => {
  const body = envelope({ actor: { kind: "owner", id: "someone-else" } });
  assert.deepEqual(await problem(await setBudget(body)), { status: 403, code: "forbidden" });
});

test("a bad body, another scope or a soft cap above the hard cap gives 400", async () => {
  for (const body of [
    envelope({ type: "budget.Other" }),
    envelope({ actor: { kind: "agent", id: "owner-1" } }),
    envelope({ payload: { scope: { kind: "month" }, hardCapMicroUsd: 1, softCapMicroUsd: 2 } }),
    envelope({ payload: { scope: { kind: "month", key: "2026-10" }, hardCapMicroUsd: 1 } }),
    envelope({
      payload: { scope: { kind: "task", key: commandIds() }, hardCapMicroUsd: 1 },
    }),
  ]) {
    assert.deepEqual(await problem(await setBudget(body)), {
      status: 400,
      code: "validation_failed",
    });
  }
});

test("a wrong expected version gives 409", async () => {
  assert.deepEqual(await problem(await setBudget(envelope({ expectedVersion: 0 }))), {
    status: 409,
    code: "conflict",
  });
});

test("MongoDB down gives 503", async () => {
  failing = true;
  try {
    assert.deepEqual(await problem(await setBudget(envelope())), {
      status: 503,
      code: "unavailable",
    });
  } finally {
    failing = false;
  }
});

test("the replay API gives the events in position order, with no token", async () => {
  const response = await fetch(`${base}/internal/events?afterPosition=0&limit=1`);
  assert.equal(response.status, 200);
  const { events } = (await response.json()) as { events: { position: number }[] };
  assert.deepEqual(
    events.map((event) => event.position),
    [1],
  );
  assert.equal((await fetch(`${base}/internal/events?limit=0`)).status, 400);
});

test("a reservation conflict is a conflict error", () => {
  const error = toDomainError(new ReservationConflictError()) as { code: string; status: number };
  assert.equal(error.code, "conflict");
  assert.equal(error.status, 409);
});
