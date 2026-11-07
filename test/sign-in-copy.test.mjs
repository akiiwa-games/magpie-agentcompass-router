import { test } from "node:test";
import assert from "node:assert/strict";

import { SIGN_IN_FIELDS, copySignIn, redactSecrets } from "./sign-in-copy.mjs";

const LONG = "x".repeat(60);
const CODEX = {
  auth_mode: "chatgpt",
  OPENAI_API_KEY: "sk-fake-key",
  last_refresh: "2026-11-07T00:00:00Z",
  tokens: { id_token: `id${LONG}`, access_token: `access${LONG}`, refresh_token: `refresh${LONG}`, account_id: "acc-1" },
};

test("a Codex copy keeps only the access token, and names what it drops", () => {
  const { copy, kept, dropped } = copySignIn("codex", CODEX);
  assert.deepEqual(copy, { tokens: { access_token: CODEX.tokens.access_token } });
  assert.deepEqual(kept, ["tokens.access_token"]);
  assert.deepEqual(dropped.sort(), ["OPENAI_API_KEY", "auth_mode", "last_refresh", "tokens.account_id", "tokens.id_token", "tokens.refresh_token"]);
});

test("a Claude copy keeps the access token and its scopes", () => {
  const { copy, dropped } = copySignIn("claude", {
    claudeAiOauth: { accessToken: `a${LONG}`, refreshToken: `r${LONG}`, expiresAt: 5, refreshTokenExpiresAt: 6, scopes: ["user:inference"], subscriptionType: "max" },
  });
  assert.deepEqual(copy, { claudeAiOauth: { accessToken: `a${LONG}`, scopes: ["user:inference"] } });
  assert.deepEqual(dropped.sort(), ["claudeAiOauth.expiresAt", "claudeAiOauth.refreshToken", "claudeAiOauth.refreshTokenExpiresAt", "claudeAiOauth.subscriptionType"]);
});

test("a Grok copy keeps the account's key, and its id stays out of the names", () => {
  const key = "https://auth.x.ai::00000000-0000-4000-8000-000000000000";
  const { copy, kept, dropped } = copySignIn("grok", {
    [key]: { key: `k${LONG}`, refresh_token: `r${LONG}`, expires_at: "2026", email: "someone@example.invalid", user_id: "u-1", principal_id: "u-1" },
  });
  assert.deepEqual(copy, { [key]: { key: `k${LONG}` } });
  assert.deepEqual(kept, ["<account>.key"]);
  assert.deepEqual(dropped.sort(), ["<account>.email", "<account>.expires_at", "<account>.principal_id", "<account>.refresh_token", "<account>.user_id"]);
  assert.ok(![...kept, ...dropped].join().includes("00000000"));
});

test("a field under a new name is dropped whatever it is called", () => {
  for (const name of ["refresh", "rt", "refreshJwt", "offline_token", "session"]) {
    const { copy, dropped } = copySignIn("codex", { tokens: { access_token: `a${LONG}`, [name]: `s${LONG}` } });
    assert.deepEqual(copy, { tokens: { access_token: `a${LONG}` } }, name);
    assert.deepEqual(dropped, [`tokens.${name}`]);
  }
});

test("a kept field holding a dropped secret stops the copy, and the error shows no value", () => {
  const secret = `refresh${LONG}`;
  assert.throws(
    () => copySignIn("codex", { tokens: { access_token: `{"inner":"${secret}"}`, refresh_token: secret } }),
    (err) => err.message.includes("holds the value of a dropped one") && !err.message.includes(secret)
  );
  assert.throws(
    () => copySignIn("claude", { claudeAiOauth: { accessToken: "a", scopes: [secret], rt: [{ deep: secret }] } }),
    /holds the value of a dropped one/
  );
});

test("a sign-in without its token, or an account without fields, is refused", () => {
  assert.throws(() => copySignIn("codex", { tokens: { account_id: "a" } }), /has no tokens\.access_token/);
  assert.throws(() => copySignIn("gemini", {}), /No sign-in fields/);
});

test("every account's token is among the fields it keeps", () => {
  for (const [account, spec] of Object.entries(SIGN_IN_FIELDS)) assert.ok(spec.keep[spec.token], account);
});

test("redactSecrets takes out emails, JWTs and long tokens, and leaves the rest of a message", () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6ImFAYi5jIn0.c2lnbmF0dXJl";
  const text = `HTTP 401 for someone@example.com: token ${jwt} rejected, key sk-ant-${"a".repeat(40)}, id 00000000-0000-4000-8000-000000000000, model gpt-6.1-sol`;
  const out = redactSecrets(text);
  for (const secret of ["someone@example.com", jwt, "a".repeat(40), "00000000"]) assert.ok(!out.includes(secret), secret);
  assert.match(out, /^HTTP 401 for <email>: token <jwt> rejected/);
  assert.match(out, /model gpt-6\.1-sol$/);
  assert.equal(redactSecrets(null), "");
});
