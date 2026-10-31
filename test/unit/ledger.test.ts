import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ConcurrencyError, type EventStore } from "@famashines/ai-systems-kit/event-store";
import { UnavailableError } from "@famashines/ai-systems-kit/http";
import { createMemoryEventStore, fakeClock, fakeIds } from "@famashines/ai-systems-kit/testing";
import {
  caller,
  capStreamId,
  createLedger,
  maxAttempts,
  monthStreamId,
  sweeper,
} from "../../src/application/ledger.ts";

const owner = { kind: "owner", id: "owner-1" } as const;
const ids = fakeIds(7);
const taskId = ids();
const agentId = ids();

const setup = (start = new Date("2026-10-10T12:00:00.000Z")) => {
  const clock = fakeClock(start);
  const store = createMemoryEventStore({ now: clock.now, newId: fakeIds(1) });
  const ledger = createLedger({ store, timeZone: "Europe/Berlin", now: clock.now });
  return { clock, store, ledger };
};

const setCap = (
  ledger: ReturnType<typeof createLedger>,
  hardCapMicroUsd: number,
  softCapMicroUsd?: number,
) =>
  ledger.setBudget(
    {
      commandId: ids(),
      actor: owner,
      payload: {
        scope: { kind: "month" },
        hardCapMicroUsd,
        ...(softCapMicroUsd === undefined ? {} : { softCapMicroUsd }),
      },
    },
    ids(),
  );

const reserve = (amountMicroUsd: number, reservationId = ids(), ttlMs = 60_000) => ({
  reservationId,
  taskId,
  agentId,
  amountMicroUsd,
  ttlMs,
});

describe("SetBudget", () => {
  test("appends BudgetSet with the command id, and a repeat gives the same answer", async () => {
    const { store, ledger } = setup();
    const command = {
      commandId: ids(),
      actor: owner,
      payload: { scope: { kind: "month" as const }, hardCapMicroUsd: 500 },
    };
    const correlationId = ids();
    assert.deepEqual(await ledger.setBudget(command, correlationId), {
      answer: { version: 1 },
      replayed: false,
    });
    assert.deepEqual(await ledger.setBudget(command, correlationId), {
      answer: { version: 1 },
      replayed: true,
    });
    assert.deepEqual(await setCap(ledger, 600), { answer: { version: 2 }, replayed: false });
    const [first] = await store.readStream(capStreamId);
    assert.equal(first?.type, "budget.BudgetSet");
    assert.equal(first.causationId, command.commandId);
    assert.equal(first.correlationId, correlationId);
    assert.deepEqual(first.actor, owner);
  });

  test("a wrong expected version is a conflict, with no retry", async () => {
    const { ledger } = setup();
    await setCap(ledger, 500);
    await assert.rejects(
      ledger.setBudget(
        {
          commandId: ids(),
          expectedVersion: 0,
          actor: owner,
          payload: { scope: { kind: "month" }, hardCapMicroUsd: 1 },
        },
        ids(),
      ),
      ConcurrencyError,
    );
  });
});

describe("reserve and settle", () => {
  test("with no cap, a reserve is refused and the refusal is an event", async () => {
    const { store, ledger } = setup();
    const reply = await ledger.reserve(reserve(1));
    assert.equal(reply.ok, false);
    const [event] = await store.readStream(monthStreamId("2026-10"));
    assert.equal(event?.type, "budget.ReservationRefused");
    assert.deepEqual(event.actor, caller);
    assert.equal(event.correlationId, taskId);
    assert.equal(event.causationId, reply.reservationId);
  });

  test("many reserves at once never hold more than the cap", async () => {
    const { store, ledger } = setup();
    await setCap(ledger, 1000);
    const replies = await Promise.all(
      Array.from({ length: 60 }, () => ledger.reserve(reserve(30))),
    );
    assert.equal(replies.filter((reply) => reply.ok).length, 33);
    const events = await store.readStream(monthStreamId("2026-10"));
    const held = events.reduce(
      (sum, event) =>
        event.type === "budget.FundsReserved" ? sum + event.payload.amountMicroUsd : sum,
      0,
    );
    assert.equal(held, 990);
  });

  test("a settle books the cost and crosses the soft cap", async () => {
    const { store, ledger } = setup();
    await setCap(ledger, 1000, 100);
    const { reservationId } = await ledger.reserve(reserve(500));
    assert.deepEqual(await ledger.settle({ reservationId, actualMicroUsd: 90 }), {
      state: "settled",
      reservationId,
      actualMicroUsd: 90,
    });
    const types = (await store.readStream(monthStreamId("2026-10"))).map((event) => event.type);
    assert.deepEqual(types, [
      "budget.FundsReserved",
      "budget.ReservationSettled",
      "budget.ThresholdCrossed",
      "budget.ThresholdCrossed",
    ]);
    assert.deepEqual(await ledger.settle({ reservationId, actualMicroUsd: 1 }), {
      state: "already_settled",
      reservationId,
      actualMicroUsd: 90,
    });
  });

  test("a reservation of the month before is settled in that month", async () => {
    const { clock, store, ledger } = setup(new Date("2026-10-31T22:59:00.000Z"));
    await setCap(ledger, 1000);
    const first = reserve(100, ids(), 600_000);
    const { reservationId } = await ledger.reserve(first);
    clock.advance(2 * 60_000);
    assert.deepEqual(await ledger.reserve(first), {
      ok: true,
      reservationId,
      expiresAt: "2026-10-31T23:09:00.000Z",
    });
    assert.equal((await ledger.settle({ reservationId, actualMicroUsd: 40 })).state, "settled");
    assert.equal((await store.readStream(monthStreamId("2026-10"))).length, 2);
    assert.equal((await store.readStream(monthStreamId("2026-11"))).length, 0);
    assert.equal(
      (await ledger.settle({ reservationId: ids(), actualMicroUsd: 1 })).state,
      "unknown",
    );
  });
});

describe("expiry", () => {
  test("the sweep books a due hold at the full amount, once", async () => {
    const { clock, store, ledger } = setup();
    await setCap(ledger, 1000);
    const { reservationId } = await ledger.reserve(reserve(200, ids(), 1000));
    assert.equal(await ledger.expire(), 0);
    clock.advance(1000);
    assert.equal(await ledger.expire(), 1);
    assert.equal(await ledger.expire(), 0);
    const last = (await store.readStream(monthStreamId("2026-10"))).at(-1);
    assert.equal(last?.type, "budget.ReservationExpired");
    assert.deepEqual(last.actor, sweeper);
    assert.deepEqual(await ledger.settle({ reservationId, actualMicroUsd: 1 }), {
      state: "expired",
      reservationId,
      amountMicroUsd: 200,
    });
  });
});

describe("two writers", () => {
  test("a second ledger on the same store reads the first one's events before it decides", async () => {
    const { clock, store, ledger } = setup();
    const other = createLedger({ store, timeZone: "Europe/Berlin", now: clock.now });
    await setCap(ledger, 100);
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, index) => (index % 2 ? ledger : other).reserve(reserve(10))),
    );
    assert.equal(replies.filter((reply) => reply.ok).length, 10);
  });

  test("a version conflict is tried again, and after the last try the call is refused", async () => {
    const { store } = setup();
    let calls = 0;
    const failing: EventStore = {
      ...store,
      append: () => {
        calls += 1;
        return Promise.reject(new ConcurrencyError());
      },
    };
    const ledger = createLedger({ store: failing, timeZone: "UTC", now: () => new Date() });
    await assert.rejects(ledger.reserve(reserve(1)), UnavailableError);
    assert.equal(calls, maxAttempts);
  });

  test("an error that is not a version conflict is not tried again", async () => {
    const { store } = setup();
    let calls = 0;
    const failing: EventStore = {
      ...store,
      append: () => {
        calls += 1;
        return Promise.reject(new Error("boom"));
      },
    };
    const ledger = createLedger({ store: failing, timeZone: "UTC", now: () => new Date() });
    await assert.rejects(ledger.reserve(reserve(1)), /boom/);
    assert.equal(calls, 1);
    await assert.rejects(ledger.reserve(reserve(1)), /boom/);
  });
});
