import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  decideExpiry,
  decideReserve,
  decideSetBudget,
  decideSettle,
  emptyLedger,
  evolveLedger,
  monthKey,
  monthNumbers,
  previousMonth,
  ReservationConflictError,
  ScopeNotEnforcedError,
  type Cap,
  type Change,
} from "../../src/domain/budget.ts";

const month = "2026-10";
const now = new Date("2026-10-10T12:00:00.000Z");
const later = (ms: number): Date => new Date(now.getTime() + ms);
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const taskId = id(100);
const agentId = id(101);
const request = (n: number, amountMicroUsd: number, ttlMs = 60_000) => ({
  reservationId: id(n),
  taskId,
  agentId,
  amountMicroUsd,
  ttlMs,
});

const given = (cap: Cap | undefined, ...amounts: number[]) => {
  const ledger = emptyLedger(month);
  amounts.forEach((amount, index) => {
    for (const change of decideReserve(ledger, cap, request(index + 1, amount), now).changes) {
      evolveLedger(ledger, change);
    }
  });
  return ledger;
};

const apply = (ledger: ReturnType<typeof emptyLedger>, changes: Change[]) => {
  for (const change of changes) evolveLedger(ledger, change);
};

describe("reserve", () => {
  test("given no cap, when a reserve comes, then it is refused for the month", () => {
    const { reply, changes } = decideReserve(emptyLedger(month), undefined, request(1, 0), now);
    assert.deepEqual(reply, {
      ok: false,
      reservationId: id(1),
      scope: { kind: "month", key: month },
      reason: "No monthly cap is set",
    });
    assert.equal(changes[0]?.type, "budget.ReservationRefused");
  });

  test("given room, when a reserve comes, then it holds the amount until the ttl", () => {
    const { reply, changes } = decideReserve(
      emptyLedger(month),
      { hard: 100 },
      request(1, 100),
      now,
    );
    assert.deepEqual(reply, {
      ok: true,
      reservationId: id(1),
      expiresAt: later(60_000).toISOString(),
    });
    assert.deepEqual(changes, [
      {
        type: "budget.FundsReserved",
        schemaVersion: 1,
        payload: {
          reservationId: id(1),
          taskId,
          agentId,
          scopes: [{ kind: "month", key: month }],
          amountMicroUsd: 100,
          expiresAt: later(60_000).toISOString(),
        },
      },
    ]);
  });

  test("given holds, when a reserve is above the rest, then it is refused", () => {
    const ledger = given({ hard: 100 }, 60);
    const { reply } = decideReserve(ledger, { hard: 100 }, request(2, 41), now);
    assert.equal(reply.ok, false);
    assert.equal(decideReserve(ledger, { hard: 100 }, request(3, 40), now).reply.ok, true);
  });

  test("given a reservation, when the same id comes again, then the first answer comes", () => {
    const ledger = given({ hard: 100 }, 60, 60);
    assert.deepEqual(decideReserve(ledger, { hard: 1000 }, request(2, 60), now), {
      reply: {
        ok: false,
        reservationId: id(2),
        scope: { kind: "month", key: month },
        reason: "The monthly cap has no room for this call",
      },
      changes: [],
    });
    assert.equal(decideReserve(ledger, { hard: 100 }, request(1, 60), later(1)).reply.ok, true);
  });

  test("given a reservation, when the same id comes with other values, then it is a conflict", () => {
    const ledger = given({ hard: 100 }, 60);
    assert.throws(
      () => decideReserve(ledger, { hard: 100 }, request(1, 61), now),
      ReservationConflictError,
    );
    assert.throws(
      () => decideReserve(ledger, { hard: 100 }, { ...request(1, 60), taskId: id(7) }, now),
      ReservationConflictError,
    );
    assert.throws(
      () => decideReserve(ledger, { hard: 100 }, { ...request(1, 60), agentId: id(7) }, now),
      ReservationConflictError,
    );
  });
});

describe("settle", () => {
  test("given a hold, when it is settled above the amount, then the full cost is booked", () => {
    const cap = { hard: 100 };
    const ledger = given(cap, 50);
    const { reply, changes } = decideSettle(
      ledger,
      cap,
      { reservationId: id(1), actualMicroUsd: 130 },
      now,
    );
    assert.deepEqual(reply, { state: "settled", reservationId: id(1), actualMicroUsd: 130 });
    apply(ledger, changes);
    assert.deepEqual(monthNumbers(ledger, cap), {
      month,
      capMicroUsd: 100,
      spentMicroUsd: 130,
      reservedMicroUsd: 0,
      remainingMicroUsd: 0,
      overCapMicroUsd: 30,
    });
    assert.deepEqual(
      changes.filter((change) => change.type === "budget.ThresholdCrossed").map((c) => c.payload),
      [50, 80, 100].map((percent) => ({
        scope: { kind: "month", key: month },
        cap: "hard",
        percent,
        spentMicroUsd: 130,
        capMicroUsd: 100,
      })),
    );
  });

  test("given a settled hold, when it is settled again, then the first amount comes", () => {
    const ledger = given({ hard: 100 }, 50);
    apply(
      ledger,
      decideSettle(ledger, undefined, { reservationId: id(1), actualMicroUsd: 20 }, now).changes,
    );
    assert.deepEqual(
      decideSettle(ledger, undefined, { reservationId: id(1), actualMicroUsd: 99 }, now),
      {
        reply: { state: "already_settled", reservationId: id(1), actualMicroUsd: 20 },
        changes: [],
      },
    );
  });

  test("given a hold past its ttl, when it is settled, then it expires at the full amount", () => {
    const ledger = given({ hard: 100 }, 50);
    const { reply, changes } = decideSettle(
      ledger,
      { hard: 100 },
      { reservationId: id(1), actualMicroUsd: 1 },
      later(60_000),
    );
    assert.deepEqual(reply, { state: "expired", reservationId: id(1), amountMicroUsd: 50 });
    assert.equal(changes[0]?.type, "budget.ReservationExpired");
    apply(ledger, changes);
    assert.equal(ledger.spent, 50);
    assert.deepEqual(
      decideSettle(ledger, undefined, { reservationId: id(1), actualMicroUsd: 1 }, now).reply,
      reply,
    );
  });

  test("given no hold or a refusal, when a settle comes, then the state is unknown", () => {
    const ledger = given(undefined, 50);
    for (const reservationId of [id(1), id(9)]) {
      assert.deepEqual(decideSettle(ledger, undefined, { reservationId, actualMicroUsd: 1 }, now), {
        reply: { state: "unknown", reservationId },
        changes: [],
      });
    }
  });
});

describe("expiry", () => {
  test("given holds, when the sweep runs, then only the due holds expire, with the thresholds", () => {
    const cap = { hard: 1000, soft: 100 };
    const ledger = emptyLedger(month);
    apply(ledger, decideReserve(ledger, cap, request(1, 60, 1000), now).changes);
    apply(ledger, decideReserve(ledger, cap, request(2, 60, 5000), now).changes);
    const bookings = decideExpiry(ledger, cap, later(1000));
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0]?.reservationId, id(1));
    assert.deepEqual(
      bookings[0].changes.map((change) => change.payload),
      [
        { reservationId: id(1), amountMicroUsd: 60 },
        {
          scope: { kind: "month", key: month },
          cap: "soft",
          percent: 50,
          spentMicroUsd: 60,
          capMicroUsd: 100,
        },
      ],
    );
    for (const booking of bookings) apply(ledger, booking.changes);
    const next = decideExpiry(ledger, cap, later(5000));
    assert.deepEqual(
      next[0]?.changes.map(
        (change) => change.type === "budget.ThresholdCrossed" && change.payload.percent,
      ),
      [false, 80, 100],
    );
  });
});

describe("numbers", () => {
  test("with no cap the cap is null and the rest and the overspend are 0", () => {
    assert.deepEqual(monthNumbers(given(undefined), undefined), {
      month,
      capMicroUsd: null,
      spentMicroUsd: 0,
      reservedMicroUsd: 0,
      remainingMicroUsd: 0,
      overCapMicroUsd: 0,
    });
  });

  test("with a soft cap the soft cap is in the numbers", () => {
    assert.equal(
      monthNumbers(given({ hard: 10, soft: 5 }, 4), { hard: 10, soft: 5 }).softCapMicroUsd,
      5,
    );
    assert.equal(
      monthNumbers(given({ hard: 10, soft: 5 }, 4), { hard: 10, soft: 5 }).remainingMicroUsd,
      6,
    );
  });
});

describe("SetBudget", () => {
  test("the month scope gives BudgetSet", () => {
    const payload = { scope: { kind: "month" as const }, hardCapMicroUsd: 10 };
    assert.deepEqual(decideSetBudget(payload), [
      { type: "budget.BudgetSet", schemaVersion: 1, payload },
    ]);
  });

  test("another scope is refused until it has a cap rule", () => {
    assert.throws(
      () => decideSetBudget({ scope: { kind: "agent", key: agentId }, hardCapMicroUsd: 10 }),
      ScopeNotEnforcedError,
    );
  });
});

describe("months", () => {
  test("the month is the calendar month in the owner time zone", () => {
    const instant = new Date("2026-10-31T23:30:00.000Z");
    assert.equal(monthKey(instant, "Europe/Berlin"), "2026-11");
    assert.equal(monthKey(instant, "UTC"), "2026-10");
    assert.equal(monthKey(new Date("2026-03-31T22:30:00.000Z"), "Europe/Berlin"), "2026-04");
  });

  test("the month before January is December of the year before", () => {
    assert.equal(previousMonth("2027-01"), "2026-12");
    assert.equal(previousMonth("2026-11"), "2026-10");
    assert.equal(previousMonth("2026-10"), "2026-09");
  });

  test("an event for a hold that is not there is an error", () => {
    assert.throws(() =>
      evolveLedger(emptyLedger(month), {
        type: "budget.ReservationExpired",
        schemaVersion: 1,
        payload: { reservationId: id(1), amountMicroUsd: 1 },
      }),
    );
  });
});
