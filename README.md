# ai-systems-budget

The Budget Ledger service of ai-systems. It holds money before each LLM
call and books the real cost after it, so the owner never spends more
than the monthly hard cap (ADR 0015). It is event-sourced in MongoDB. The
`events` collection is the outbox: a relay publishes each event to the
NATS JetStream stream `BUDGET`. The service is internal and has no
Ingress.

```
ai-proxy --rpc.budget.reserve--> budget --FundsReserved | ReservationRefused
ai-proxy --rpc.budget.settle---> budget --ReservationSettled (+ ThresholdCrossed)
sweep (each second)              budget --ReservationExpired (+ ThresholdCrossed)
owner --api-gateway--POST /internal/commands/set-budget--> budget --BudgetSet
                                                  | one transaction for each change
                                                  v
                                   MongoDB budget: events, commands
                                                  | outbox relay, Nats-Msg-Id = eventId
                                                  v
                                   NATS stream BUDGET (budget.>)
projections --GET /internal/events--> budget (rebuild only)
```

Architecture and reasons: `ai-systems-docs` (`ARCHITECTURE.md` 7 and 9,
ADR 0015, 0021, 0023, 0025). Schemas: `@famashines/ai-systems-contracts`
v0.3.0 (`src/budget.ts`, README "Budget rpc").

## Streams

| Stream                   | Events                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `budget-cap-month`       | `budget.BudgetSet` for the scope `{ kind: "month" }`. The last one is the cap of every month.         |
| `budget-month-<YYYY-MM>` | `FundsReserved`, `ReservationRefused`, `ReservationSettled`, `ReservationExpired`, `ThresholdCrossed` |

The month is the calendar month in `OWNER_TIME_ZONE` (default
`Europe/Berlin`), from the clock of the service. The caller does not send
a month or scopes.

## Rules

- No cap set: every reserve is refused with the scope
  `{ kind: "month", key: "<YYYY-MM>" }` and the reason
  `No monthly cap is set`.
- A reserve is held only if `spent + reserved + amount <= hardCap`. Else
  it is refused with the reason
  `The monthly cap has no room for this call`. A refusal is an event too.
- A repeated reserve with the same `reservationId`, `taskId`, `agentId`
  and `amountMicroUsd` gives the first answer again, with no new event.
  The same `reservationId` with another of these values gives the error
  code `conflict`. `ttlMs` is not compared: the events do not keep it.
- `expiresAt` is the time of the reserve plus `ttlMs` (default 10
  minutes).
- Settle:

  | State of the hold        | Reply                                   | Event                |
  | ------------------------ | --------------------------------------- | -------------------- |
  | held, before `expiresAt` | `settled` with the actual amount        | `ReservationSettled` |
  | held, at or after it     | `expired` with the full reserved amount | `ReservationExpired` |
  | settled                  | `already_settled` with the first amount | none                 |
  | expired                  | `expired` with the full reserved amount | none                 |
  | refused, or no such id   | `unknown`                               | none                 |

- A settle above the reserved amount is booked in full, also above the
  cap. Then `overCapMicroUsd` shows it and every next reserve is refused.
- The sweep runs each second and expires each hold that is at or past its
  `expiresAt`, booked at the full amount.
- `ThresholdCrossed`: when a booking takes `spent` from below to at or
  above 50, 80 or 100% of the soft cap or of the hard cap. One event for
  each line that the booking crosses. The integer check is
  `before * 100 < cap * percent <= after * 100`.
- Month numbers (`monthNumbers` in `src/domain/budget.ts`, the rule of
  `BudgetMonthV1`): `remaining = max(0, cap - spent - reserved)` and
  `overCap = max(0, spent - cap)`. With no cap, `capMicroUsd` is `null`
  and both are `0`. projections serves the read model; it must use the
  same rule.
- A reservation is looked up in the current month and the month before.
  So a settle or a repeated reserve just after the start of a month finds
  a hold of the last month and books it in that month.

## rpc

Core NATS request-reply, not in a stream. `kit/messaging` `serve()` with a
queue group, so one pod answers.

| Subject              | Request                      | Reply                      |
| -------------------- | ---------------------------- | -------------------------- |
| `rpc.budget.reserve` | `ReserveFundsRequestV1`      | `ReserveFundsReplyV1`      |
| `rpc.budget.settle`  | `SettleReservationRequestV1` | `SettleReservationReplyV1` |

- Reply allow-list (ADR 0025): the service answers only a request whose
  reply subject starts with `_INBOX_ai-proxy.`. It drops all other
  requests before the parse, with no answer, and counts them in
  `rpc_requests_dropped_total`. In contracts v0.3.0 ai-proxy is the only
  caller (it reserves and settles each attempt). Orchestration does not
  call budget, so `_INBOX_orchestration.` is not on the list.
- zod checks the request before any database work. A bad request gets the
  error code `validation_failed`.
- Errors in the `error-code` header: `conflict` (same id, other values),
  `unavailable` (MongoDB down, or the stream changed 10 times in a row),
  `internal`. The caller fails closed on each of them, and on a timeout.

Events of a reserve or a settle have `correlationId` = the `taskId`,
`causationId` = the `reservationId`, and the actor
`{ kind: "system", id: "ai-proxy" }`. The sweep uses the actor
`{ kind: "system", id: "budget" }`.

## Concurrency

Each change reads the streams, decides, and appends with
`expectedVersion` = the last version that it read. A concurrent append
from another pod gives `ConcurrencyError`; the service reads again and
decides again, at most 10 times. In one pod, the changes run one after the
other. The integration test sends 60 reserves at the same time to two pods
and checks that exactly the amount that fits is held.

## API

| Method | Path                                           | Does                                                      |
| ------ | ---------------------------------------------- | --------------------------------------------------------- |
| POST   | `/internal/commands/set-budget`                | Set the monthly cap. Needs an owner bearer token.         |
| GET    | `/internal/events?afterPosition=<n>&limit=<m>` | Replay API: all events in position order. No token.       |
| GET    | `/health`                                      | Liveness: 200 while the process runs                      |
| GET    | `/ready`                                       | Readiness: MongoDB and migrations (`mongo`, `migrations`) |
| GET    | `/metrics`                                     | Prometheus metrics                                        |

### `POST /internal/commands/set-budget`

The request needs `Authorization: Bearer <access token>`, checked by
`kit/auth` with the role `owner` (issuer `OIDC_ISSUER`, audience
`OIDC_AUDIENCE`). api-gateway sends the token of the owner on. The body is
a `CommandEnvelopeV1` with a `SetBudgetCommandPayloadV1`:

```json
{
  "commandId": "6f1c2b9e-1d1a-4c55-9b0e-3a7f0d5e8c21",
  "type": "budget.SetBudget",
  "actor": { "kind": "owner", "id": "<sub of the token>" },
  "payload": {
    "scope": { "kind": "month" },
    "hardCapMicroUsd": 5000000,
    "softCapMicroUsd": 4000000
  }
}
```

| Status | When                                                                                   | Body                                   |
| ------ | -------------------------------------------------------------------------------------- | -------------------------------------- |
| 201    | The cap is set                                                                         | `{ "version": <n> }` of the cap stream |
| 200    | The same `commandId` came before                                                       | The first answer again. No new event.  |
| 400    | The body is not valid, the soft cap is above the hard cap, or the scope is not `month` | Problem JSON with `errors`             |
| 401    | No token, or a token that is not valid                                                 | Problem JSON                           |
| 403    | No `owner` role, or `actor.id` is not the `sub` of the token                           | Problem JSON                           |
| 409    | `expectedVersion` is not the last version of `budget-cap-month`                        | Problem JSON, `code` `conflict`        |
| 503    | MongoDB does not answer, or Keycloak cannot be read                                    | Problem JSON, `code` `unavailable`     |

Only the month scope has a cap in M2 (ADR 0015). The scopes `project`,
`agent` and `task` give 400 until M4 adds their rules, so the service
never keeps a cap that it does not enforce.

### `GET /internal/events`

The same as orchestration: `afterPosition` (default `0`) and `limit`
(default `100`, at most `1000`), digits only. The answer is
`{ "events": [ ... ] }` with the `position` of each event.

## Configuration

| Variable                                                            | Default                                         | Content                                  |
| ------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| `MONGODB_URI`                                                       | required                                        | MongoDB connection string (replica set)  |
| `MONGODB_DATABASE`                                                  | `budget`                                        | Database name                            |
| `NATS_SERVERS`                                                      | required                                        | NATS URLs, comma-separated; at least one |
| `NATS_USER`                                                         | required                                        | `ai-systems-budget` on the cluster       |
| `NATS_PASSWORD`                                                     | required                                        | From the SealedSecret                    |
| `OIDC_ISSUER`                                                       | `https://auth.famashines.com/realms/ai-systems` | Keycloak realm                           |
| `OIDC_JWKS_URL`                                                     | `<issuer>/protocol/openid-connect/certs`        | JWKS inside the cluster                  |
| `OIDC_AUDIENCE`                                                     | `ai-systems-app`                                | Audience and `azp` of the token          |
| `OWNER_TIME_ZONE`                                                   | `Europe/Berlin`                                 | IANA time zone of the budget month       |
| `PORT`                                                              | `8080`                                          | HTTP port                                |
| `LOG_LEVEL`                                                         | `info`                                          | pino level                               |
| `RELEASE`                                                           | `local`                                         | Release id in logs and metrics           |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | not set                                         | Traces go over OTLP only when one is set |

A bad value stops the process at start with the variable name. An empty
value is a value: delete the line to get the default. The kit service
name is fixed to `budget`, so the NATS inbox prefix is `_INBOX_budget`.

NATS grants that the service needs (gitops, user `ai-systems-budget`):
publish `budget.>`, `dlq.budget.>`, `$JS.API.INFO`,
`$JS.API.STREAM.INFO.BUDGET`; subscribe `_INBOX_budget.>`,
`rpc.budget.reserve`, `rpc.budget.settle`; `allow_responses: true`.

NATS and the relay are not readiness checks. When NATS is down, no rpc
comes in, so no call gets money (fail closed), and the events of a
SetBudget wait in the outbox. NATS must be available at start.

## Run locally

Node 26 (`nvm use`), a MongoDB replica set, and NATS with JetStream and
the stream `BUDGET` (`compose.yaml` in `ai-systems-kit`).

```sh
npm ci
cp .env.example .env
node --env-file=.env src/main.ts
```

## Container image

```sh
docker build --build-arg RELEASE=$(git rev-parse HEAD) -t ai-systems-budget .
```

Node 26 slim, pinned by digest, with no npm and no test packages. The
entrypoint is `node src/main.ts` as uid 1000. It writes nothing to disk.

Release: when `ci` passes on a push to `main`,
`.github/workflows/release.yml` builds and scans the image, pushes
`ghcr.io/famashines/ai-systems-budget:sha-<commit>`, and opens a pull
request in `famashines/gitops` for
`kubernetes/ai-systems/ai-systems-budget/prod`. It needs the org secret
`GITOPS_TOKEN` with access to this repo, and the gitops app of task M2-09.

## Test

| Command                    | Does                                                 |
| -------------------------- | ---------------------------------------------------- |
| `npm run verify`           | type check, lint, unit tests with the coverage gates |
| `npm run test:integration` | MongoDB and NATS in Testcontainers (needs Docker)    |

## Known limits

- One lock for all changes in a pod: about 80 reserves each second
  (measured: 100 reserves at once on two pods in 1.2 s). Use a lock for
  each stream if that is too slow.
- A pod keeps the state of the current and the last month in memory and
  reads only the new events of a stream. The first change after a start
  reads the full month streams.
- A settle or a repeated reserve that comes more than one month later
  does not find its hold: it gets `unknown`, or a new reserve.
- The month cap is read at the time of the change. A reserve that runs at
  the same time as a SetBudget can use the cap from before it.
