import {
  ReserveFundsReplyV1,
  ReserveFundsRequestV1,
  RpcSubject,
  SettleReservationReplyV1,
  SettleReservationRequestV1,
} from "@famashines/ai-systems-contracts";
import type { Nats } from "@famashines/ai-systems-kit/messaging";
import type { BudgetLedger } from "../application/ledger.ts";
import { guard } from "./http.ts";

export const allowReplyPrefixes = ["_INBOX_ai-proxy."] as const;

export function serveRpc(
  nats: Pick<Nats, "serve">,
  ledger: Pick<BudgetLedger, "reserve" | "settle">,
) {
  return [
    nats.serve(
      RpcSubject.budgetReserve,
      ReserveFundsRequestV1,
      ReserveFundsReplyV1,
      guard(ledger.reserve),
      { allowReplyPrefixes },
    ),
    nats.serve(
      RpcSubject.budgetSettle,
      SettleReservationRequestV1,
      SettleReservationReplyV1,
      guard(ledger.settle),
      { allowReplyPrefixes },
    ),
  ];
}
