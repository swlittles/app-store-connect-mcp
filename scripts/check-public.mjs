#!/usr/bin/env node
// Fails if anything private is about to be published: key files, private key text, personal
// emails, home-directory paths, or strings listed in a local, untracked denylist.
//
//   npm run check:public
//
// Put personal strings (your name, team ID, real app IDs, key IDs) one per line in
// .public-denylist at the repository root. That file is gitignored, so the list itself stays private.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => existsSync(f));

const problems = [];
const KEY_FILE = /\.(p8|pem|p12|pfx|key|cer|mobileprovision)$|(^|\/)\.env(\.|$)/i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /@(example\.(com|org|net)|users\.noreply\.github\.com|anthropic\.com)$/i;
const HOME_PATH = /\/(Users|home)\/(?!you\b)[A-Za-z0-9._-]+/g;
const denylist = existsSync(".public-denylist")
  ? readFileSync(".public-denylist", "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  : [];

for (const file of files) {
  if (KEY_FILE.test(file)) problems.push(`${file}: looks like a key or secrets file`);
  if (file.endsWith(".gz") || file === ".public-denylist") continue;
  const text = readFileSync(file, "utf8");
  if (PRIVATE_KEY.test(text)) problems.push(`${file}: contains private key text`);
  for (const email of text.match(EMAIL) ?? []) {
    if (!ALLOWED_EMAIL.test(email)) problems.push(`${file}: email address ${email}`);
  }
  for (const path of text.match(HOME_PATH) ?? []) problems.push(`${file}: home directory path ${path}`);
  const lower = text.toLowerCase();
  for (const word of denylist) {
    if (lower.includes(word.toLowerCase())) problems.push(`${file}: contains a denylisted string (${word.slice(0, 3)}…)`);
  }
}

// Commit metadata is public too.
const identities = execFileSync("git", ["log", "--all", "--format=%ae%n%ce"], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const email of new Set(identities)) {
  if (!ALLOWED_EMAIL.test(email)) problems.push(`git history: commit email ${email}`);
}

if (problems.length) {
  console.error(`Not safe to publish:\n${[...new Set(problems)].map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`OK: ${files.length} files and the git history contain no keys or personal info${denylist.length ? ` (checked ${denylist.length} denylisted strings)` : ""}.`);
