import assert from "node:assert/strict";
import { test } from "node:test";
import { eventRegistry } from "@famashines/ai-systems-contracts";
import {
  crossings,
  decideExpiry,
  decideReserve,
  decideSettle,
  emptyLedger,
  evolveLedger,
  monthNumbers,
  ReservationConflictError,
  type Cap,
  type Change,
  type Ledger,
} from "../../src/domain/budget.ts";

const runs = 300;
const steps = 80;
const month = "2026-10";

function generator(seed: number) {
  let state = seed;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number): number => Math.floor(next() * (max + 1));
  const pick = <T>(items: readonly T[]): T | undefined => items[int(items.length - 1)];
  return { next, int, pick };
}

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const taskId = id(900_000);
const agentId = id(900_001);

interface Period {
  cap: Cap;
  startSpent: number;
  crossed: string[];
}

function check(seed: number): void {
  const random = generator(seed);
  const ledger = emptyLedger(month);
  const log: Change[] = [];
  const firstReplies = new Map<string, unknown>();
  const firstSettles = new Map<string, number>();
  const requests = new Map<string, { amountMicroUsd: number; ttlMs: number }>();
  const periods: Period[] = [];
  let cap: Cap | undefined;
  let now = Date.parse("2026-10-10T12:00:00.000Z");
  let nextId = 1;
  const where = `seed ${String(seed)}`;

  const apply = (changes: Change[]): void => {
    for (const change of changes) {
      const before = { spent: ledger.spent, reserved: ledger.reserved };
      if (change.type === "budget.FundsReserved") {
        assert.ok(cap, `${where}: a reserve without a cap`);
        assert.ok(
          before.spent + before.reserved + change.payload.amountMicroUsd <= cap.hard,
          `${where}: a reserve over the cap`,
        );
      }
      if (change.type === "budget.ThresholdCrossed") {
        periods.at(-1)?.crossed.push(`${change.payload.cap}:${String(change.payload.percent)}`);
      }
      eventRegistry[change.type][1].parse(change.payload);
      evolveLedger(ledger, change);
      log.push(change);
    }
  };

  for (let step = 0; step < steps; step += 1) {
    const roll = random.next();
    const known = [...requests.keys()];
    if (roll < 0.1) {
      const hard = random.int(5000);
      const soft = random.next() < 0.5 ? random.int(hard) : undefined;
      cap = soft === undefined ? { hard } : { hard, soft };
      periods.push({ cap, startSpent: ledger.spent, crossed: [] });
    } else if (roll < 0.45) {
      const reservationId = id(nextId);
      nextId += 1;
      const request = {
        reservationId,
        taskId,
        agentId,
        amountMicroUsd: random.int(1500),
        ttlMs: 1000 + random.int(4000),
      };
      const decision = decideReserve(ledger, cap, request, new Date(now));
      assert.equal(decision.reply.ok, decision.changes[0]?.type === "budget.FundsReserved");
      requests.set(reservationId, request);
      firstReplies.set(reservationId, decision.reply);
      apply(decision.changes);
    } else if (roll < 0.5) {
      const reservationId = random.pick(known);
      const request = reservationId === undefined ? undefined : requests.get(reservationId);
      if (reservationId === undefined || request === undefined) continue;
      const same = { reservationId, taskId, agentId, ...request };
      const again = decideReserve(ledger, cap, same, new Date(now));
      assert.deepEqual(again.reply, firstReplies.get(reservationId), `${where}: a repeat`);
      assert.deepEqual(again.changes, []);
      assert.throws(
        () =>
          decideReserve(
            ledger,
            cap,
            { ...same, amountMicroUsd: request.amountMicroUsd + 1 },
            new Date(now),
          ),
        ReservationConflictError,
      );
    } else if (roll < 0.75) {
      const reservationId =
        random.next() < 0.1 ? id(nextId + 1000) : (random.pick(known) ?? id(nextId + 1000));
      const reserved = requests.get(reservationId)?.amountMicroUsd ?? 0;
      const actualMicroUsd = random.int(reserved * 2 + 10);
      const before = ledger.reservations.get(reservationId);
      const decision = decideSettle(ledger, cap, { reservationId, actualMicroUsd }, new Date(now));
      const state = decision.reply.state;
      if (before === undefined || before.state === "refused") assert.equal(state, "unknown");
      if (before?.state === "expired") assert.equal(state, "expired");
      if (before?.state === "settled") {
        assert.deepEqual(decision.reply, {
          state: "already_settled",
          reservationId,
          actualMicroUsd: firstSettles.get(reservationId),
        });
      }
      if (before?.state === "held") {
        assert.equal(state, Date.parse(before.expiresAt) <= now ? "expired" : "settled");
      }
      if (state === "settled") firstSettles.set(reservationId, actualMicroUsd);
      if (before?.state !== "held") assert.deepEqual(decision.changes, []);
      apply(decision.changes);
    } else if (roll < 0.85) {
      now += random.int(3000);
    } else {
      const bookings = decideExpiry(ledger, cap, new Date(now));
      for (const booking of bookings) {
        assert.equal(ledger.reservations.get(booking.reservationId)?.state, "held");
        apply(booking.changes);
      }
      assert.deepEqual(decideExpiry(ledger, cap, new Date(now)), [], `${where}: expiry twice`);
    }

    let held = 0;
    let spent = 0;
    for (const reservation of ledger.reservations.values()) {
      if (reservation.state === "held") held += reservation.amount;
      if (reservation.state === "settled") spent += reservation.actual;
      if (reservation.state === "expired") spent += reservation.amount;
    }
    assert.equal(ledger.reserved, held, `${where}: reserved is the sum of the holds`);
    assert.equal(ledger.spent, spent, `${where}: spent is the sum of the bookings`);

    const numbers = monthNumbers(ledger, cap);
    assert.equal(numbers.capMicroUsd, cap?.hard ?? null);
    assert.equal(
      numbers.remainingMicroUsd,
      cap ? Math.max(0, cap.hard - ledger.spent - ledger.reserved) : 0,
    );
    assert.equal(numbers.overCapMicroUsd, cap ? Math.max(0, ledger.spent - cap.hard) : 0);
    assert.ok(numbers.remainingMicroUsd >= 0 && numbers.overCapMicroUsd >= 0);
  }

  const replayed = log.reduce<Ledger>(evolveLedger, emptyLedger(month));
  assert.deepEqual(replayed, ledger, `${where}: replay gives the same state`);

  periods.forEach((period, index) => {
    const endSpent = periods[index + 1]?.startSpent ?? ledger.spent;
    const expected = crossings(month, period.cap, period.startSpent, endSpent).map((change) =>
      change.type === "budget.ThresholdCrossed"
        ? `${change.payload.cap}:${String(change.payload.percent)}`
        : "",
    );
    assert.deepEqual(
      [...period.crossed].sort(),
      [...expected].sort(),
      `${where}: each threshold is crossed once`,
    );
  });
}

test("random reserves, settles and expiries keep the budget rules", () => {
  for (let seed = 1; seed <= runs; seed += 1) check(seed);
});

test("a crossing is the first spend at or above the percent of the cap", () => {
  const random = generator(7);
  for (let run = 0; run < 1000; run += 1) {
    const hard = random.int(10_000);
    const soft = random.int(hard);
    const before = random.int(12_000);
    const after = before + random.int(12_000);
    const found = crossings(month, { hard, soft }, before, after).map((change) =>
      change.type === "budget.ThresholdCrossed"
        ? [change.payload.cap, change.payload.percent, change.payload.capMicroUsd]
        : [],
    );
    const expected = (
      [
        ["soft", soft],
        ["hard", hard],
      ] as const
    ).flatMap(([kind, amount]) =>
      [50, 80, 100]
        .filter((percent) => {
          const line = (amount * percent) / 100;
          return before < line && after >= line;
        })
        .map((percent) => [kind, percent, amount]),
    );
    assert.deepEqual(found, expected, `run ${String(run)}`);
  }
});
