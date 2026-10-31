import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "@famashines/ai-systems-kit/config";
import { envSchema } from "../../src/main.ts";

const env = {
  MONGODB_URI: "mongodb://mongo:27017/?replicaSet=rs0",
  NATS_SERVERS: " nats://a:4222 ,, nats://b:4222,",
  NATS_USER: "ai-systems-budget",
  NATS_PASSWORD: "secret",
};

test("the defaults: database budget, Berlin time, the Keycloak realm", () => {
  const config = loadConfig(envSchema, env);
  assert.deepEqual(config.NATS_SERVERS, ["nats://a:4222", "nats://b:4222"]);
  assert.equal(config.MONGODB_DATABASE, "budget");
  assert.equal(config.OWNER_TIME_ZONE, "Europe/Berlin");
  assert.equal(config.OIDC_ISSUER, "https://auth.famashines.com/realms/ai-systems");
  assert.equal(config.OIDC_AUDIENCE, "ai-systems-app");
  assert.equal(config.OIDC_JWKS_URL, undefined);
});

test("a known time zone is accepted", () => {
  assert.equal(
    loadConfig(envSchema, { ...env, OWNER_TIME_ZONE: "Asia/Karachi" }).OWNER_TIME_ZONE,
    "Asia/Karachi",
  );
});

for (const [name, value] of [
  ["OWNER_TIME_ZONE", "Mars/Olympus"],
  ["NATS_SERVERS", " , ,"],
  ["OIDC_ISSUER", "ftp://auth.example"],
]) {
  test(`${String(name)} "${String(value)}" is refused`, () => {
    assert.throws(() => loadConfig(envSchema, { ...env, [String(name)]: value }), ConfigError);
  });
}
