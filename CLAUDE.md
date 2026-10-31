# CLAUDE.md for ai-systems-budget

Rules for all ai-systems repos: `ai-systems-docs/CLAUDE.md`
(local: `../../docs/CLAUDE.md`). What the service does: `README.md`.

## Commands

| Command                    | Does                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `npm ci`                   | install from the lock file (builds kit and contracts on install) |
| `npm run check`            | `tsc --noEmit` (TypeScript 7)                                    |
| `npm run lint`             | ESLint (strict type-checked) and Prettier check                  |
| `npm test`                 | unit tests, two coverage gates (see below)                       |
| `npm run verify`           | check, lint and test                                             |
| `npm run test:integration` | `test/integration` with Testcontainers (needs Docker)            |
| `npm start`                | `node src/main.ts`                                               |

## Layout

```
src
├── domain/budget.ts         decide, evolve, month numbers, thresholds; no I/O
├── application/ledger.ts    load streams, decide, append with the version, retry
├── adapters/http.ts         SetBudget (owner token), replay API, error mapping
├── adapters/rpc.ts          rpc.budget.reserve and .settle, reply allow-list
└── main.ts                  config, wiring by constructor, sweep, start, shutdown
test
├── unit                     node:test, kit in-memory event store, property tests
└── integration              MongoDB and NATS in Testcontainers, two pods
```

No own migrations: budget has only the kit collections (ARCHITECTURE 7).

## Coverage gates (ADR 0017)

`npm test` runs the unit tests two times, because node:test thresholds are
for all included files together:

- `test:domain`: `src/domain`, 90% lines and 85% branches.
- `test:unit`: `src` without `main.ts`, 70% lines.

`main.ts` is wiring. The integration test covers it through `start()`.

## Property tests

`test/unit/budget-properties.test.ts` has a small seeded generator (no
dependency). A failure message has the seed. Run the same seed again to
see the same sequence.

## Integration tests

The NATS config in the test has the grants of the users
`ai-systems-budget`, `ai-systems-ai-proxy`, `ai-systems-orchestration`
(after gitops #185, with no `rpc.budget.*`) and `ai-systems-admin` from
gitops (`kubernetes/infrastructure/nats/values.yaml`). Change them
together with gitops. The user `ai-systems-intruder` is only in the test:
it may publish on `rpc.budget.*` with its own inbox, to check the reply
allow-list. The test starts two pods on one MongoDB, so the version check
between pods runs. It signs tokens with `jose` against a local JWKS. Wait
with `waitFor`, never with a fixed sleep. Pass `drainDelayMs: 0` to
`start()`.

The CI job `integration` runs on `ubuntu-22.04`: `mongo:8.0.34` does not
start on the kernel of `ubuntu-24.04`. See the kit `CLAUDE.md`.

## Dependencies

- Kit and contracts come from git tags. A new tag needs a new
  `allowScripts` entry with the commit of the tag
  (`npm install-scripts approve <package>`).
- The kit asks for contracts v0.1.0; npm dedupes it to the v0.3.0 of this
  service, so there is one copy. Check with
  `npm ls @famashines/ai-systems-contracts zod mongodb`. Two copies would
  make the kit event store refuse the `budget.*` events.
- `mongodb` and `zod` have the exact versions that the kit pins.
- TypeScript 6 (`typescript`, for ESLint) and 7 (`typescript-7`, for
  `check`): ADR 0022. Never run `npx tsc`.
- The Docker build stage uses the full Node image, because npm needs `git`
  to install the kit and contracts. The runtime stage is slim.
