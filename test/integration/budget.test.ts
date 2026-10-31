import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import {
  ReserveFundsReplyV1,
  ReserveFundsRequestV1,
  RpcSubject,
  SettleReservationReplyV1,
  SettleReservationRequestV1,
} from "@famashines/ai-systems-contracts";
import { loadConfig } from "@famashines/ai-systems-kit/config";
import { UnavailableError } from "@famashines/ai-systems-kit/http";
import { connectNats, type Nats } from "@famashines/ai-systems-kit/messaging";
import { connectMongo, type Mongo } from "@famashines/ai-systems-kit/mongo";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import {
  createStreams,
  startMongo,
  startNats,
  waitFor,
  type Started,
} from "@famashines/ai-systems-kit/testing";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { monthKey } from "../../src/domain/budget.ts";
import { envSchema, start } from "../../src/main.ts";

const budgetPublish = ["budget.>", "dlq.budget.>", "$JS.API.INFO", "$JS.API.STREAM.INFO.BUDGET"];
const budgetSubscribe = ["_INBOX_budget.>", "rpc.budget.reserve", "rpc.budget.settle"];

const aiProxyPublish = [
  "llm.>",
  "delta.>",
  "rpc.budget.reserve",
  "rpc.budget.settle",
  "dlq.ai-proxy.>",
  "$JS.API.INFO",
  "$JS.API.STREAM.INFO.LLM",
  "$JS.API.STREAM.INFO.ORCHESTRATION",
  "$JS.API.CONSUMER.CREATE.ORCHESTRATION.ai-proxy.orchestration.CallRequested",
  "$JS.API.CONSUMER.INFO.ORCHESTRATION.ai-proxy",
  "$JS.API.CONSUMER.MSG.NEXT.ORCHESTRATION.ai-proxy",
  "$JS.ACK.ORCHESTRATION.ai-proxy.>",
];

const orchestrationPublish = [
  "orchestration.>",
  "rpc.budget.reserve",
  "rpc.budget.settle",
  "dlq.orchestration.>",
  "$JS.API.INFO",
  "$JS.API.STREAM.INFO.ORCHESTRATION",
];

const adminPublish = [
  "$JS.API.>",
  "$JS.ACK.>",
  "orchestration.>",
  "conversation.>",
  "llm.>",
  "budget.>",
  "agents.>",
  "prompts.>",
  "dlq.>",
];

const list = (subjects: string[]): string => subjects.map((s) => `"${s}"`).join(", ");

const user = (name: string, publish: string[], subscribe: string[], extra = "") => `
      {
        user: ${name}, password: ${name}
        permissions {
          publish { allow: [${list(publish)}] }
          subscribe { allow: [${list(subscribe)}] }
          ${extra}
        }
      }`;

const natsConfig = `
jetstream { store_dir: /data }
accounts {
  AISYSTEMS {
    jetstream { max_file: 1073741824, max_memory: 0 }
    users = [
      ${user("ai-systems-admin", adminPublish, ["_INBOX_admin.>"])}
      ${user("ai-systems-budget", budgetPublish, budgetSubscribe, "allow_responses: true")}
      ${user("ai-systems-ai-proxy", aiProxyPublish, ["_INBOX_ai-proxy.>"])}
      ${user("ai-systems-orchestration", orchestrationPublish, ["_INBOX_orchestration.>"])}
    ]
  }
}
`;

const issuer = "https://auth.example.test/realms/ai-systems";
const logger = createLogger({ service: "test", release: "test", level: "silent" });
const owner = "owner-1";
let mongoContainer: Started;
let natsContainer: Started;
let mongo: Mongo;
let admin: Nats;
let aiProxy: Nats;
let orchestration: Nats;
let manager: JetStreamManager;
let jwks: Server;
let jwksUrl = "";
let privateKey: CryptoKey;
const pods: Awaited<ReturnType<typeof start>>[] = [];
let base = "";

const token = (roles: string[]) =>
  new SignJWT({ typ: "Bearer", azp: "ai-systems-app", realm_access: { roles } })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience("ai-systems-app")
    .setSubject(owner)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

const startPod = async (): Promise<string> => {
  const config = loadConfig(envSchema, {
    MONGODB_URI: mongoContainer.url,
    NATS_SERVERS: natsContainer.url,
    NATS_USER: "ai-systems-budget",
    NATS_PASSWORD: "ai-systems-budget",
    OIDC_ISSUER: issuer,
    OIDC_JWKS_URL: jwksUrl,
    LOG_LEVEL: "silent",
  });
  const pod = await start({ ...config, PORT: 0 }, { drainDelayMs: 0, sweepMs: 200 });
  pods.push(pod);
  const url = `http://127.0.0.1:${String(pod.address.port)}`;
  await waitFor(async () => (await fetch(`${url}/ready`)).ok);
  return url;
};

const client = (name: string) =>
  connectNats({
    servers: natsContainer.url,
    user: `ai-systems-${name}`,
    pass: `ai-systems-${name}`,
    service: name,
    logger,
  });

before(async () => {
  [mongoContainer, natsContainer] = await Promise.all([
    startMongo(),
    startNats({ config: natsConfig }),
  ]);
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  jwks = createServer((_request, response) => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  jwksUrl = `http://127.0.0.1:${String((jwks.address() as AddressInfo).port)}/certs`;
  mongo = await connectMongo({ url: mongoContainer.url, database: "budget" });
  admin = await client("admin");
  manager = await jetstreamManager(admin.connection);
  await createStreams(admin.connection, [{ name: "BUDGET", subjects: ["budget.>"] }]);
  base = await startPod();
  await startPod();
  aiProxy = await client("ai-proxy");
  orchestration = await client("orchestration");
});

after(async () => {
  for (const pod of pods) assert.equal(await pod.app.close(), true);
  await Promise.all([admin.close(), aiProxy.close(), orchestration.close(), mongo.close()]);
  await new Promise((resolve) => jwks.close(resolve));
  await Promise.all([mongoContainer.stop(), natsContainer.stop()]);
});

const month = () => monthKey(new Date(), "Europe/Berlin");
const events = () =>
  mongo.db.collection<{
    _id: string;
    streamId: string;
    type: string;
    payload: Record<string, unknown>;
    publishedAt: Date | null;
  }>("events");

const reserve = (amountMicroUsd: number, ttlMs?: number, reservationId = randomUUID()) =>
  aiProxy.request(RpcSubject.budgetReserve, ReserveFundsRequestV1, ReserveFundsReplyV1, {
    reservationId,
    taskId: randomUUID(),
    agentId: randomUUID(),
    amountMicroUsd,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });

const settle = (reservationId: string, actualMicroUsd: number) =>
  aiProxy.request(RpcSubject.budgetSettle, SettleReservationRequestV1, SettleReservationReplyV1, {
    reservationId,
    actualMicroUsd,
  });

const setBudget = async (hardCapMicroUsd: number, softCapMicroUsd?: number, roles = ["owner"]) =>
  fetch(`${base}/internal/commands/set-budget`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await token(roles)}`,
    },
    body: JSON.stringify({
      commandId: randomUUID(),
      type: "budget.SetBudget",
      actor: { kind: "owner", id: owner },
      payload: {
        scope: { kind: "month" },
        hardCapMicroUsd,
        ...(softCapMicroUsd === undefined ? {} : { softCapMicroUsd }),
      },
    }),
  });

test("with no cap set, every reserve is refused", async () => {
  const reply = await reserve(0);
  assert.deepEqual(reply, {
    ok: false,
    reservationId: reply.reservationId,
    scope: { kind: "month", key: month() },
    reason: "No monthly cap is set",
  });
});

test("only the owner sets the cap", async () => {
  const anonymous = await fetch(`${base}/internal/commands/set-budget`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(anonymous.status, 401);
  assert.equal((await setBudget(1000, undefined, ["guest"])).status, 403);
  assert.equal((await setBudget(1000)).status, 201);
});

test("many reserves at once, on two pods, never hold more than the cap", async () => {
  const replies = await Promise.all(Array.from({ length: 60 }, () => reserve(30)));
  assert.equal(replies.filter((reply) => reply.ok).length, 33);
  const held = await events()
    .find({ streamId: `budget-month-${month()}`, type: "budget.FundsReserved" })
    .toArray();
  assert.equal(held.length, 33);
  assert.equal(
    held.reduce((sum, event) => sum + Number(event.payload.amountMicroUsd), 0),
    990,
  );
  for (const reply of replies.filter((item) => item.ok)) {
    assert.equal((await settle(reply.reservationId, 0)).state, "settled");
  }
});

test("settle books the full cost, also above the hold, and a repeat gives the first amount", async () => {
  assert.equal((await setBudget(1_000_000, 10_000)).status, 201);
  const { reservationId } = await reserve(5000);
  assert.deepEqual(await settle(reservationId, 9000), {
    state: "settled",
    reservationId,
    actualMicroUsd: 9000,
  });
  assert.deepEqual(await settle(reservationId, 1), {
    state: "already_settled",
    reservationId,
    actualMicroUsd: 9000,
  });
  const unknown = randomUUID();
  assert.deepEqual(await settle(unknown, 1), { state: "unknown", reservationId: unknown });
  const crossed = await events().find({ type: "budget.ThresholdCrossed" }).toArray();
  assert.deepEqual(
    crossed.map((event) => [event.payload.cap, event.payload.percent]),
    [
      ["soft", 50],
      ["soft", 80],
    ],
  );
});

test("the same reservation id with other values is a conflict", async () => {
  const reservationId = randomUUID();
  const request = {
    reservationId,
    taskId: randomUUID(),
    agentId: randomUUID(),
    amountMicroUsd: 10,
  };
  const call = (amountMicroUsd: number) =>
    aiProxy.request(RpcSubject.budgetReserve, ReserveFundsRequestV1, ReserveFundsReplyV1, {
      ...request,
      amountMicroUsd,
    });
  const first = await call(10);
  assert.deepEqual(await call(10), first);
  await assert.rejects(call(11), (error: { code?: string }) => error.code === "conflict");
});

test("a hold with no settle expires at the full amount", async () => {
  const { reservationId } = await reserve(700, 1000);
  await waitFor(
    async () =>
      (await events().countDocuments({
        type: "budget.ReservationExpired",
        "payload.reservationId": reservationId,
      })) === 1,
    10_000,
  );
  assert.deepEqual(await settle(reservationId, 1), {
    state: "expired",
    reservationId,
    amountMicroUsd: 700,
  });
  assert.equal(
    await events().countDocuments({
      type: "budget.ReservationExpired",
      "payload.reservationId": reservationId,
    }),
    1,
  );
});

test("a request with a reply inbox that is not allowed gets no answer", async () => {
  await assert.rejects(
    orchestration.request(
      RpcSubject.budgetReserve,
      ReserveFundsRequestV1,
      ReserveFundsReplyV1,
      {
        reservationId: randomUUID(),
        taskId: randomUUID(),
        agentId: randomUUID(),
        amountMicroUsd: 1,
      },
      1000,
    ),
    UnavailableError,
  );
  const before = await events().countDocuments();
  await assert.rejects(
    orchestration.request(
      RpcSubject.budgetSettle,
      SettleReservationRequestV1,
      SettleReservationReplyV1,
      { reservationId: randomUUID(), actualMicroUsd: 1 },
      1000,
    ),
    UnavailableError,
  );
  assert.equal(await events().countDocuments(), before);
});

test("a request that is not valid gets validation_failed and writes nothing", async () => {
  const before = await events().countDocuments();
  const reply = await aiProxy.connection.request(
    RpcSubject.budgetReserve,
    JSON.stringify({ reservationId: "x", amountMicroUsd: -1 }),
    { timeout: 2000 },
  );
  assert.equal(reply.headers?.get("error-code"), "validation_failed");
  assert.equal(await events().countDocuments(), before);
});

test("every event reaches the stream BUDGET once", async () => {
  await waitFor(async () => (await events().countDocuments({ publishedAt: null })) === 0);
  const { state } = await manager.streams.info("BUDGET");
  assert.equal(state.messages, await events().countDocuments());
});
