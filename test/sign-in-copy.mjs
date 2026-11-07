/**
 * What a real sign-in may take into the sandbox for Scenario 13.
 *
 * Fields are kept by name: one not listed here is dropped, whatever a vendor calls it next. Refresh tokens never go in: they
 * rotate, and a client refreshing a copy of one would sign the machine's own agent out.
 *
 * Usage (before the sandbox loses sight of the host): sign-in-copy.mjs <account> <sign-in file> <copy>. Prints field names only.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const GROK_ACCOUNT = /^https:\/\/auth\.x\.ai::/;

// Each field with why the account can't do without it. Each was tried by leaving it out: a field a run passes without isn't here
export const SIGN_IN_FIELDS = {
  codex: {
    token: "tokens.access_token",
    keep: {
      "tokens.access_token": "the credential itself",
    },
  },
  claude: {
    token: "claudeAiOauth.accessToken",
    keep: {
      "claudeAiOauth.accessToken": "the credential itself",
      "claudeAiOauth.scopes": "without them the gateway doesn't list the account's models (tried: Scenario 13 stops there)",
    },
  },
  grok: {
    account: GROK_ACCOUNT,
    token: "<account>.key",
    keep: {
      "<account>.key": "the credential itself",
    },
  },
};

/** Takes emails, JWTs and long tokens out of a text bound for a log or a report. */
export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/[^\s"'<>(),;:]+@[^\s"'<>(),;:]+/g, "<email>")
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "<jwt>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<token>");
}

/** The fields of `signIn` this account keeps, and the names of those it drops. */
export function copySignIn(account, signIn) {
  const spec = SIGN_IN_FIELDS[account];
  if (!spec) throw new Error(`No sign-in fields for ${account}`);
  const kept = [];
  const dropped = [];
  const droppedValues = [];
  const collect = (value, field) => {
    if (typeof value === "string") {
      // Long enough not to be an id a kept field repeats
      if (value.length >= 40 || (/refresh/i.test(field) && value.length >= 8)) droppedValues.push(value);
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value)) collect(v, field);
    }
  };
  const walk = (value, at) => {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      const field = `${at}${spec.account?.test(key) ? "<account>" : key}`;
      if (Object.hasOwn(spec.keep, field)) {
        out[key] = v;
        kept.push(field);
      } else if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(spec.keep).some((k) => k.startsWith(`${field}.`))) {
        out[key] = walk(v, `${field}.`);
      } else {
        dropped.push(redactSecrets(field));
        collect(v, field);
      }
    }
    return out;
  };
  const copy = walk(signIn, "");
  if (!kept.includes(spec.token)) throw new Error(`${account}: the sign-in has no ${spec.token}`);
  const text = JSON.stringify(copy);
  if (droppedValues.some((value) => text.includes(value))) {
    throw new Error(`${account}: a kept field holds the value of a dropped one`);
  }
  return { copy, kept, dropped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [account, source, target] = process.argv.slice(2);
  let signIn;
  try {
    signIn = JSON.parse(fs.readFileSync(source, "utf8"));
  } catch {
    throw new Error(`${account}: the sign-in file can't be read as JSON`);
  }
  const { copy, kept, dropped } = copySignIn(account, signIn);
  fs.writeFileSync(target, JSON.stringify(copy), { mode: 0o600 });
  fs.writeFileSync(`${target}.fields`, JSON.stringify({ kept, dropped }), { mode: 0o600 });
  console.log(`[Sign-in copy] ${account}: kept ${kept.join(", ")}; dropped ${dropped.join(", ") || "nothing"}`);
}
