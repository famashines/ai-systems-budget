import type {
  Actor,
  ReserveFundsReplyV1,
  ReserveFundsRequestV1,
  SetBudgetCommandPayloadV1,
  SettleReservationReplyV1,
  SettleReservationRequestV1,
} from "@famashines/ai-systems-contracts";
import { ConcurrencyError, type EventStore } from "@famashines/ai-systems-kit/event-store";
import { UnavailableError } from "@famashines/ai-systems-kit/http";
import {
  capOf,
  decideExpiry,
  decideReserve,
  decideSetBudget,
  decideSettle,
  emptyLedger,
  evolveLedger,
  monthKey,
  previousMonth,
  type Booking,
  type Cap,
  type Change,
  type Ledger,
} from "../domain/budget.ts";

export const capStreamId = "budget-cap-month";
export const monthStreamId = (month: string): string => `budget-month-${month}`;

export const caller: Actor = { kind: "system", id: "ai-proxy" };
export const sweeper: Actor = { kind: "system", id: "budget" };

export const maxAttempts = 10;

export interface SetBudgetInput {
  commandId: string;
  expectedVersion?: number;
  actor: Actor;
  payload: SetBudgetCommandPayloadV1;
}

export interface Deps {
  store: EventStore;
  timeZone: string;
  now: () => Date;
}

interface Loaded {
  ledger: Ledger;
  version: number;
}

const isBudget = (event: { type: string }): event is Change => event.type.startsWith("budget.");

export function createLedger({ store, timeZone, now }: Deps) {
  let cap: { value: Cap | undefined; version: number } = { value: undefined, version: 0 };
  const ledgers = new Map<string, Loaded>();
  let tail: Promise<unknown> = Promise.resolve();

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work);
    tail = run.catch(() => undefined);
    return run;
  }

  async function write<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await serial(work);
      } catch (error) {
        if (!(error instanceof ConcurrencyError)) throw error;
      }
    }
    throw new UnavailableError("The budget changed too often, try again");
  }

  async function loadCap(): Promise<Cap | undefined> {
    for (const event of await store.readStream(capStreamId, { fromVersion: cap.version + 1 })) {
      cap = {
        value: event.type === "budget.BudgetSet" ? capOf(event.payload) : cap.value,
        version: event.version,
      };
    }
    return cap.value;
  }

  async function loadMonth(month: string): Promise<Loaded> {
    const loaded = ledgers.get(month) ?? { ledger: emptyLedger(month), version: 0 };
    const streamId = monthStreamId(month);
    for (const event of await store.readStream(streamId, { fromVersion: loaded.version + 1 })) {
      if (isBudget(event)) evolveLedger(loaded.ledger, event);
      loaded.version = event.version;
    }
    ledgers.set(month, loaded);
    return loaded;
  }

  async function months(at: Date): Promise<[Loaded, Loaded]> {
    const current = monthKey(at, timeZone);
    const previous = previousMonth(current);
    for (const month of ledgers.keys()) {
      if (month !== current && month !== previous) ledgers.delete(month);
    }
    return [await loadMonth(current), await loadMonth(previous)];
  }

  const holding = (loaded: Loaded[], reservationId: string): Loaded | undefined =>
    loaded.find(({ ledger }) => ledger.reservations.has(reservationId));

  async function book(loaded: Loaded, bookings: Booking[], actor: Actor): Promise<void> {
    const events = bookings.flatMap(({ reservationId, taskId, changes }) =>
      changes.map((change) => ({
        ...change,
        correlationId: taskId,
        causationId: reservationId,
        actor,
      })),
    );
    if (events.length === 0) return;
    await store.append({
      streamId: monthStreamId(loaded.ledger.month),
      expectedVersion: loaded.version,
      events,
    });
  }

  return {
    reserve: (request: ReserveFundsRequestV1): Promise<ReserveFundsReplyV1> =>
      write(async () => {
        const at = now();
        const [current, previous] = await months(at);
        const loaded = holding([previous], request.reservationId) ?? current;
        const { reply, changes } = decideReserve(loaded.ledger, await loadCap(), request, at);
        const { reservationId, taskId } = request;
        await book(loaded, [{ reservationId, taskId, changes }], caller);
        return reply;
      }),

    settle: (request: SettleReservationRequestV1): Promise<SettleReservationReplyV1> =>
      write(async () => {
        const at = now();
        const [current, previous] = await months(at);
        const loaded = holding([current, previous], request.reservationId) ?? current;
        const { reply, changes } = decideSettle(loaded.ledger, await loadCap(), request, at);
        const { reservationId } = request;
        const taskId = loaded.ledger.reservations.get(reservationId)?.taskId ?? reservationId;
        await book(loaded, [{ reservationId, taskId, changes }], caller);
        return reply;
      }),

    expire: (): Promise<number> =>
      write(async () => {
        const at = now();
        const loaded = await months(at);
        const value = await loadCap();
        let expired = 0;
        for (const month of loaded) {
          const bookings = decideExpiry(month.ledger, value, at);
          await book(month, bookings, sweeper);
          expired += bookings.length;
        }
        return expired;
      }),

    setBudget: (
      { commandId, expectedVersion, actor, payload }: SetBudgetInput,
      correlationId: string,
    ) =>
      (expectedVersion === undefined ? write : serial)(async () => {
        const changes = decideSetBudget(payload);
        await loadCap();
        const last = expectedVersion ?? cap.version;
        const answer = { version: last + changes.length };
        const result = await store.append({
          streamId: capStreamId,
          expectedVersion: last,
          events: changes.map((change) => ({
            ...change,
            correlationId,
            causationId: commandId,
            actor,
          })),
          command: { commandId, answer },
        });
        return { answer: result.answer ?? answer, replayed: result.replayed };
      }),
  };
}

export type BudgetLedger = ReturnType<typeof createLedger>;
