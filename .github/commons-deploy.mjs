// Uploads the build output to Commons, then publishes it as a version. Commons stores files by
// content, so only files it does not have yet are sent: a push that changes one file uploads one.
// Authenticates with this workflow's OIDC token (audience: the Commons URL); no secrets needed.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const origin = process.env.COMMONS_URL;
const candidates = [process.env.OUTPUT_DIR, "dist", "build", "out", "public"].filter(Boolean);
let root = null;
for (const d of candidates) {
  try {
    if ((await stat(d)).isDirectory()) { root = d; break; }
  } catch {}
}
if (!root) { console.error("No build output found in " + candidates.join(", ")); process.exit(1); }

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const idRes = await fetch(process.env.ACTIONS_ID_TOKEN_REQUEST_URL + "&audience=" + encodeURIComponent(origin), {
  headers: { Authorization: "Bearer " + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
});
if (!idRes.ok) { console.error("Could not get an OIDC token. Is 'id-token: write' set?"); process.exit(1); }
const auth = { Authorization: "Bearer " + (await idRes.json()).value };

const all = [];
for (const p of await walk(root)) {
  const path = relative(root, p).split("\\").join("/");
  if (path.split("/").some((s) => s.startsWith("."))) continue;
  const bytes = await readFile(p);
  all.push({ file: p, path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const listing = all.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
const check = await fetch(origin + "/github/deploy/check", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ files: listing }) });
if (!check.ok) { console.error(await check.text()); process.exit(1); }
const { missing, skip } = await check.json();
for (const path of skip) console.log("skipped (type not served): " + path);
const need = new Set(missing);
const todo = all.filter((f) => !skip.includes(f.path) && need.delete(f.sha256));
let i = 0;
async function worker() {
  while (i < todo.length) {
    const f = todo[i++];
    const res = await fetch(origin + "/github/deploy/file?path=" + encodeURIComponent(f.path), { method: "PUT", headers: auth, body: await readFile(f.file) });
    if (!res.ok) { console.error(f.path + ": " + (await res.text())); process.exit(1); }
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
console.log("Uploaded " + todo.length + " of " + all.length + " files; the rest were already on Commons.");
const res = await fetch(origin + "/github/deploy/finish", {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ files: listing.filter((f) => !skip.includes(f.path)), message: process.env.COMMIT_MESSAGE || "" }),
});
console.log(await res.text());
if (!res.ok) process.exit(1);
