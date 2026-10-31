import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcSubject } from "@famashines/ai-systems-contracts";
import type { Nats } from "@famashines/ai-systems-kit/messaging";
import { allowReplyPrefixes, serveRpc } from "../../src/adapters/rpc.ts";
import { ReservationConflictError } from "../../src/domain/budget.ts";

test("reserve and settle answer only the ai-proxy inbox, and a conflict is a conflict error", async () => {
  const served: { subject: string; handler: (input: unknown) => unknown; prefixes: unknown }[] = [];
  const nats = {
    serve: (subject, _schemaIn, _schemaOut, handler, options) => {
      served.push({
        subject,
        handler: handler as (input: unknown) => unknown,
        prefixes: options.allowReplyPrefixes,
      });
      return {} as ReturnType<Nats["serve"]>;
    },
  } as Pick<Nats, "serve">;
  serveRpc(nats, {
    reserve: () => Promise.reject(new ReservationConflictError()),
    settle: (input) => Promise.resolve({ state: "unknown", reservationId: input.reservationId }),
  });
  assert.deepEqual(allowReplyPrefixes, ["_INBOX_ai-proxy."]);
  assert.deepEqual(
    served.map(({ subject, prefixes }) => [subject, prefixes]),
    [
      [RpcSubject.budgetReserve, allowReplyPrefixes],
      [RpcSubject.budgetSettle, allowReplyPrefixes],
    ],
  );
  await assert.rejects(
    Promise.resolve(served[0]?.handler({})),
    (error: { code?: string }) => error.code === "conflict",
  );
  assert.deepEqual(await served[1]?.handler({ reservationId: "r" }), {
    state: "unknown",
    reservationId: "r",
  });
});
