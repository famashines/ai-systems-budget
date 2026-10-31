import {
  Actor,
  CommandEnvelopeV1,
  SetBudgetCommandPayloadV1,
} from "@famashines/ai-systems-contracts";
import { bearerHook, subjectOf, type JwtVerifier } from "@famashines/ai-systems-kit/auth";
import type { EventStore } from "@famashines/ai-systems-kit/event-store";
import {
  ConflictError,
  ForbiddenError,
  UnavailableError,
  validate,
  ValidationError,
  type Reply,
  type Request,
  type Route,
} from "@famashines/ai-systems-kit/http";
import { isInfrastructure } from "@famashines/ai-systems-kit/messaging";
import { z } from "zod";
import type { BudgetLedger } from "../application/ledger.ts";
import { ReservationConflictError, ScopeNotEnforcedError } from "../domain/budget.ts";

const SetBudgetBody = CommandEnvelopeV1(SetBudgetCommandPayloadV1).extend({
  type: z.literal("budget.SetBudget"),
  actor: Actor.extend({ kind: z.literal("owner") }),
});

const count = (fallback: string, schema: z.ZodInt) =>
  z.string().regex(/^\d+$/).default(fallback).transform(Number).pipe(schema);

const EventsQuery = z.object({
  afterPosition: count("0", z.int().min(0)),
  limit: count("100", z.int().min(1).max(1000)),
});

export function toDomainError(error: unknown): unknown {
  if (error instanceof ReservationConflictError) return new ConflictError(error.message);
  if (error instanceof ScopeNotEnforcedError) {
    return new ValidationError("The request is not valid", [
      { path: "payload.scope.kind", code: "invalid_value", message: error.message },
    ]);
  }
  if (isInfrastructure(error)) return new UnavailableError("The database is not available");
  return error;
}

export const guard =
  <I, O>(handler: (input: I) => Promise<O>) =>
  async (input: I): Promise<O> => {
    try {
      return await handler(input);
    } catch (error) {
      throw toDomainError(error);
    }
  };

export interface HttpDeps {
  ledger: Pick<BudgetLedger, "setBudget">;
  store: Pick<EventStore, "readAll">;
  verify: JwtVerifier;
}

export function routes({ ledger, store, verify }: HttpDeps): Route[] {
  const owner = bearerHook(verify);
  const setBudget = async (request: Request): Promise<Reply> => {
    await owner(request);
    const { body } = await validate(request, { body: SetBudgetBody });
    if (body.actor.id !== subjectOf(request).sub) {
      throw new ForbiddenError("The actor is not the subject of the token");
    }
    const { answer, replayed } = await ledger.setBudget(body, request.correlationId);
    return { status: replayed ? 200 : 201, body: answer };
  };
  return [
    { method: "POST", path: "/internal/commands/set-budget", handler: guard(setBudget) },
    {
      method: "GET",
      path: "/internal/events",
      handler: guard(async (request) => {
        const { query } = await validate(request, { query: EventsQuery });
        return { body: { events: await store.readAll(query) } };
      }),
    },
  ];
}
