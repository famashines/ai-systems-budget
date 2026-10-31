import type {
  BudgetMonthV1,
  BudgetScope,
  RegisteredEvent,
  ReserveFundsReplyV1,
  ReserveFundsRequestV1,
  SetBudgetCommandPayloadV1,
  SettleReservationReplyV1,
  SettleReservationRequestV1,
} from "@famashines/ai-systems-contracts";

export type BudgetEvent = Extract<RegisteredEvent, { type: `budget.${string}` }>;
type ChangeOf<E> = E extends unknown
  ? Pick<E, Extract<keyof E, "type" | "schemaVersion" | "payload">>
  : never;
export type Change = ChangeOf<BudgetEvent>;

export interface Cap {
  hard: number;
  soft?: number;
}

interface Held {
  taskId: string;
  agentId: string;
  amount: number;
}

export type Reservation =
  | (Held & { state: "held"; expiresAt: string })
  | (Held & { state: "expired"; expiresAt: string })
  | (Held & { state: "settled"; expiresAt: string; actual: number })
  | (Held & { state: "refused"; scope: BudgetScope; reason: string });

export interface Ledger {
  month: string;
  spent: number;
  reserved: number;
  reservations: Map<string, Reservation>;
  sent: Set<string>;
}

export interface Decision<R> {
  reply: R;
  changes: Change[];
}

export interface Booking {
  reservationId: string;
  taskId: string;
  changes: Change[];
}

export interface Sweep {
  thresholds: Change[];
  bookings: Booking[];
}

export type MonthNumbers = Omit<BudgetMonthV1, "rev" | "asOf">;

export class ReservationConflictError extends Error {
  constructor() {
    super("The reservation id is in use with other values");
    this.name = "ReservationConflictError";
  }
}

export class ScopeNotEnforcedError extends Error {
  constructor() {
    super("Only the month scope has a cap in this version");
    this.name = "ScopeNotEnforcedError";
  }
}

export const percents = [50, 80, 100] as const;

export const emptyLedger = (month: string): Ledger => ({
  month,
  spent: 0,
  reserved: 0,
  reservations: new Map(),
  sent: new Set(),
});

export const thresholdKey = (cap: "soft" | "hard", percent: number): string =>
  `${cap}:${String(percent)}`;

export function monthKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}`;
}

export function previousMonth(month: string): string {
  const [year = 0, number = 0] = month.split("-").map(Number);
  return number === 1
    ? `${String(year - 1)}-12`
    : `${String(year)}-${String(number - 1).padStart(2, "0")}`;
}

export const capOf = ({ hardCapMicroUsd, softCapMicroUsd }: SetBudgetCommandPayloadV1): Cap =>
  softCapMicroUsd === undefined
    ? { hard: hardCapMicroUsd }
    : { hard: hardCapMicroUsd, soft: softCapMicroUsd };

const heldOf = (ledger: Ledger, reservationId: string): Extract<Reservation, { state: "held" }> => {
  const found = ledger.reservations.get(reservationId);
  if (found?.state !== "held") throw new Error(`The reservation ${reservationId} is not held`);
  return found;
};

export function evolveLedger(ledger: Ledger, change: Change): Ledger {
  switch (change.type) {
    case "budget.FundsReserved": {
      const { reservationId, taskId, agentId, amountMicroUsd, expiresAt } = change.payload;
      ledger.reservations.set(reservationId, {
        state: "held",
        taskId,
        agentId,
        amount: amountMicroUsd,
        expiresAt,
      });
      ledger.reserved += amountMicroUsd;
      break;
    }
    case "budget.ReservationRefused": {
      const { reservationId, taskId, agentId, amountMicroUsd, scope, reason } = change.payload;
      ledger.reservations.set(reservationId, {
        state: "refused",
        taskId,
        agentId,
        amount: amountMicroUsd,
        scope,
        reason,
      });
      break;
    }
    case "budget.ReservationSettled": {
      const held = heldOf(ledger, change.payload.reservationId);
      ledger.reservations.set(change.payload.reservationId, {
        ...held,
        state: "settled",
        actual: change.payload.actualMicroUsd,
      });
      ledger.reserved -= held.amount;
      ledger.spent += change.payload.actualMicroUsd;
      break;
    }
    case "budget.ReservationExpired": {
      const held = heldOf(ledger, change.payload.reservationId);
      ledger.reservations.set(change.payload.reservationId, { ...held, state: "expired" });
      ledger.reserved -= held.amount;
      ledger.spent += held.amount;
      break;
    }
    case "budget.ThresholdCrossed":
      ledger.sent.add(thresholdKey(change.payload.cap, change.payload.percent));
      break;
    case "budget.BudgetSet":
      break;
  }
  return ledger;
}

export function monthNumbers(ledger: Ledger, cap: Cap | undefined): MonthNumbers {
  const { month, spent, reserved } = ledger;
  const base = { month, spentMicroUsd: spent, reservedMicroUsd: reserved };
  if (cap === undefined) {
    return { ...base, capMicroUsd: null, remainingMicroUsd: 0, overCapMicroUsd: 0 };
  }
  return {
    ...base,
    capMicroUsd: cap.hard,
    ...(cap.soft === undefined ? {} : { softCapMicroUsd: cap.soft }),
    remainingMicroUsd: Math.max(0, cap.hard - spent - reserved),
    overCapMicroUsd: Math.max(0, spent - cap.hard),
  };
}

export function dueThresholds(
  month: string,
  cap: Cap | undefined,
  spent: number,
  sent: Set<string>,
): Change[] {
  if (cap === undefined || spent === 0) return [];
  const due: Change[] = [];
  for (const [kind, amount] of [
    ["soft", cap.soft],
    ["hard", cap.hard],
  ] as const) {
    if (amount === undefined) continue;
    for (const percent of percents) {
      const key = thresholdKey(kind, percent);
      if (spent * 100 < amount * percent || sent.has(key)) continue;
      sent.add(key);
      due.push({
        type: "budget.ThresholdCrossed",
        schemaVersion: 1,
        payload: {
          scope: { kind: "month", key: month },
          cap: kind,
          percent,
          spentMicroUsd: spent,
          capMicroUsd: amount,
        },
      });
    }
  }
  return due;
}

const replyOf = (reservationId: string, found: Reservation): ReserveFundsReplyV1 =>
  found.state === "refused"
    ? { ok: false, reservationId, scope: found.scope, reason: found.reason }
    : { ok: true, reservationId, expiresAt: found.expiresAt };

export function decideReserve(
  ledger: Ledger,
  cap: Cap | undefined,
  request: ReserveFundsRequestV1,
  now: Date,
): Decision<ReserveFundsReplyV1> {
  const { reservationId, taskId, agentId, amountMicroUsd, ttlMs } = request;
  const found = ledger.reservations.get(reservationId);
  if (found) {
    if (found.taskId !== taskId || found.agentId !== agentId || found.amount !== amountMicroUsd) {
      throw new ReservationConflictError();
    }
    return { reply: replyOf(reservationId, found), changes: [] };
  }
  const scope = { kind: "month" as const, key: ledger.month };
  const reason =
    cap === undefined
      ? "No monthly cap is set"
      : ledger.spent + ledger.reserved + amountMicroUsd > cap.hard
        ? "The monthly cap has no room for this call"
        : undefined;
  if (reason !== undefined) {
    return {
      reply: { ok: false, reservationId, scope, reason },
      changes: [
        {
          type: "budget.ReservationRefused",
          schemaVersion: 1,
          payload: { reservationId, taskId, agentId, scope, amountMicroUsd, reason },
        },
      ],
    };
  }
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return {
    reply: { ok: true, reservationId, expiresAt },
    changes: [
      {
        type: "budget.FundsReserved",
        schemaVersion: 1,
        payload: { reservationId, taskId, agentId, scopes: [scope], amountMicroUsd, expiresAt },
      },
    ],
  };
}

const expire = (
  ledger: Ledger,
  cap: Cap | undefined,
  reservationId: string,
  amount: number,
  spent: number,
  sent: Set<string>,
): Change[] => [
  {
    type: "budget.ReservationExpired",
    schemaVersion: 1,
    payload: { reservationId, amountMicroUsd: amount },
  },
  ...dueThresholds(ledger.month, cap, spent + amount, sent),
];

export function decideSettle(
  ledger: Ledger,
  cap: Cap | undefined,
  request: SettleReservationRequestV1,
  now: Date,
): Decision<SettleReservationReplyV1> {
  const { reservationId, actualMicroUsd } = request;
  const found = ledger.reservations.get(reservationId);
  if (found === undefined || found.state === "refused") {
    return { reply: { state: "unknown", reservationId }, changes: [] };
  }
  if (found.state === "settled") {
    return {
      reply: { state: "already_settled", reservationId, actualMicroUsd: found.actual },
      changes: [],
    };
  }
  const expired = { state: "expired" as const, reservationId, amountMicroUsd: found.amount };
  if (found.state === "expired") return { reply: expired, changes: [] };
  if (Date.parse(found.expiresAt) <= now.getTime()) {
    return {
      reply: expired,
      changes: expire(ledger, cap, reservationId, found.amount, ledger.spent, new Set(ledger.sent)),
    };
  }
  return {
    reply: { state: "settled", reservationId, actualMicroUsd },
    changes: [
      {
        type: "budget.ReservationSettled",
        schemaVersion: 1,
        payload: { reservationId, reservedMicroUsd: found.amount, actualMicroUsd },
      },
      ...dueThresholds(ledger.month, cap, ledger.spent + actualMicroUsd, new Set(ledger.sent)),
    ],
  };
}

export function decideSweep(
  ledger: Ledger,
  cap: Cap | undefined,
  now: Date,
  { thresholds }: { thresholds: boolean },
): Sweep {
  const sent = new Set(ledger.sent);
  const due = thresholds ? dueThresholds(ledger.month, cap, ledger.spent, sent) : [];
  const bookings: Booking[] = [];
  let spent = ledger.spent;
  for (const [reservationId, found] of ledger.reservations) {
    if (found.state !== "held" || Date.parse(found.expiresAt) > now.getTime()) continue;
    bookings.push({
      reservationId,
      taskId: found.taskId,
      changes: expire(ledger, cap, reservationId, found.amount, spent, sent),
    });
    spent += found.amount;
  }
  return { thresholds: due, bookings };
}

export function decideSetBudget(payload: SetBudgetCommandPayloadV1): Change[] {
  if (payload.scope.kind !== "month") throw new ScopeNotEnforcedError();
  return [{ type: "budget.BudgetSet", schemaVersion: 1, payload }];
}
