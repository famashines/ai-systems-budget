import { createJwtVerifier } from "@famashines/ai-systems-kit/auth";
import { commonEnv, loadConfig } from "@famashines/ai-systems-kit/config";
import { createEventStore, eventStoreMigration } from "@famashines/ai-systems-kit/event-store";
import { createService } from "@famashines/ai-systems-kit/http";
import { connectNats, describeError, startRelay } from "@famashines/ai-systems-kit/messaging";
import { connectMongo, runMigrations } from "@famashines/ai-systems-kit/mongo";
import { createLogger, startTelemetry } from "@famashines/ai-systems-kit/observability";
import { z } from "zod";
import { routes } from "./adapters/http.ts";
import { serveRpc } from "./adapters/rpc.ts";
import { createLedger } from "./application/ledger.ts";

export const service = "budget";

const httpUrl = z.url({ protocol: /^https?$/ });

const timeZone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Not a known IANA time zone");

export const envSchema = commonEnv.omit({ SERVICE_NAME: true }).extend({
  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z.string().min(1).default("budget"),
  NATS_SERVERS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(",")
        .map((server) => server.trim())
        .filter((server) => server !== ""),
    )
    .pipe(z.array(z.string()).min(1)),
  NATS_USER: z.string().min(1),
  NATS_PASSWORD: z.string().min(1),
  OIDC_ISSUER: httpUrl.default("https://auth.famashines.com/realms/ai-systems"),
  OIDC_JWKS_URL: httpUrl.optional(),
  OIDC_AUDIENCE: z.string().min(1).default("ai-systems-app"),
  OWNER_TIME_ZONE: timeZone.default("Europe/Berlin"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.url().optional(),
});

export type Config = z.output<typeof envSchema>;

export interface StartOptions {
  drainDelayMs?: number;
  sweepMs?: number;
}

export async function start(
  config: Readonly<Config>,
  { sweepMs = 1000, ...options }: StartOptions = {},
) {
  const release = config.RELEASE;
  const telemetry = startTelemetry({ serviceName: service, release });
  const logger = createLogger({ service, release, level: config.LOG_LEVEL });
  logger.info("connecting to MongoDB");
  const mongo = await connectMongo({
    url: config.MONGODB_URI,
    database: config.MONGODB_DATABASE,
    clientOptions: { serverSelectionTimeoutMS: 5000 },
  });
  const migrations = [eventStoreMigration];
  await runMigrations(mongo.db, migrations);
  const store = createEventStore(mongo.db);
  const ledger = createLedger({ store, timeZone: config.OWNER_TIME_ZONE, now: () => new Date() });
  logger.info("connecting to NATS");
  const nats = await connectNats({
    servers: config.NATS_SERVERS,
    user: config.NATS_USER,
    pass: config.NATS_PASSWORD,
    service,
    logger,
  });
  const relay = startRelay({ store, nats, streams: ["BUDGET"] });
  serveRpc(nats, ledger);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const sweep = async (): Promise<void> => {
    try {
      await ledger.expire();
    } catch (error) {
      logger.warn({ error: describeError(error) }, "the reservation expiry sweep failed");
    }
    if (!stopped) timer = setTimeout(() => void sweep(), sweepMs);
  };
  timer = setTimeout(() => void sweep(), sweepMs);
  const stopSweep = (): Promise<void> => {
    stopped = true;
    clearTimeout(timer);
    return Promise.resolve();
  };
  const verify = createJwtVerifier({
    issuer: config.OIDC_ISSUER,
    audience: config.OIDC_AUDIENCE,
    requiredRole: "owner",
    ...(config.OIDC_JWKS_URL === undefined ? {} : { jwksUrl: config.OIDC_JWKS_URL }),
    logger,
  });
  const app = createService({
    logger,
    routes: routes({ ledger, store, verify }),
    readiness: {
      mongo: mongo.ready,
      migrations: async () =>
        (await mongo.db
          .collection<{ _id: string }>("migrations")
          .countDocuments({ _id: { $in: migrations.map((migration) => migration.name) } })) ===
        migrations.length,
    },
    metrics: telemetry.metricsHandler,
    closeHooks: [telemetry.shutdown, mongo.close, nats.close, relay.close, stopSweep],
    ...options,
  });
  const address = await app.listen(config.PORT);
  logger.info({ port: address.port }, "budget started");
  return { app, address };
}

if (import.meta.main) {
  const exitEarly = (): never => process.exit(143);
  process.once("SIGTERM", exitEarly);
  process.once("SIGINT", exitEarly);
  const { app } = await start(loadConfig(envSchema));
  process.off("SIGTERM", exitEarly);
  process.off("SIGINT", exitEarly);
  app.handleSignals();
}
