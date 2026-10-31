# Changelog

## 0.1.0

- Monthly hard cap: `budget.BudgetSet` on the stream `budget-cap-month`.
  The cap applies to every month. With no cap set, every reserve is
  refused.
- `rpc.budget.reserve` and `rpc.budget.settle` (contracts v0.3.0) on core
  NATS. They answer only reply subjects that start with `_INBOX_ai-proxy.`
  (ADR 0025).
- Ledger of each month on the stream `budget-month-<YYYY-MM>`, with the
  month from the owner time zone (`OWNER_TIME_ZONE`, default
  `Europe/Berlin`): `FundsReserved`, `ReservationRefused`,
  `ReservationSettled`, `ReservationExpired`, `ThresholdCrossed` (50, 80
  and 100% of the soft and the hard cap).
- A reserve is held only if `spent + reserved + amount <= cap`. The check
  and the append use the stream version, so two pods cannot hold more
  than the cap together.
- Expiry: a sweep each second books a hold that is past its `expiresAt`
  at the full amount. A settle after `expiresAt` gets `expired`.
- `POST /internal/commands/set-budget` with a Keycloak bearer token of the
  `owner` role (`kit/auth`), and `GET /internal/events` (replay API).
- `/health`, `/ready` (MongoDB and migrations), `/metrics`.
- Outbox relay to the stream `BUDGET`, graceful shutdown.
- Container image on Node 26 slim, uid 1000, read-only root file system.
- Release workflow: image, CycloneDX SBOM, grype scan, push to GHCR by tag
  and digest, and a release pull request in `famashines/gitops`.
