import express from "express";
import http from "http";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { randomBytes, createHash } from "crypto";
import { OAuth2Client } from "google-auth-library";
import { AuctionState, Character, CharacterLimits, GameMode, Player, SiteConfig, SiteMediaField, Team } from "../src/types";
import { demoCharacters, defaultLimits } from "../src/data";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" }, maxHttpBufferSize: 25 * 1024 * 1024 });

const rooms = new Map<string, AuctionState>();
const timers = new Map<string, NodeJS.Timeout>();
const unsoldCountsByRoom = new Map<string, Map<string, number>>();
// One entry per Google account per room: room code -> (email -> player socket id).
const emailsByRoom = new Map<string, Map<string, string>>();
// Per-room bookkeeping that survives a server restart (saved in rooms.json).
const roomActivity = new Map<string, number>();
const originalCharacters = new Map<string, Character[]>();
const ROOM_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_ROUNDS = 5;
const MAX_SOLO_PLAYERS = 12;

// --------------------------------------------------------------------------------
// Site-wide (owner-only) landing page background + auction page sounds. Persists
// on disk across restarts until the owner changes it again — separate from any
// single room's background. Change OWNER_KEY here (or set the AUCTION_OWNER_KEY
// env var) to whatever only you know, so nobody else can overwrite these from
// their phone.
const OWNER_KEY = process.env.AUCTION_OWNER_KEY || "loki-owner-2026";
const SITE_MEDIA_FIELDS: SiteMediaField[] = ["background", "backgroundVideo", "bgm", "soldSound", "queueSound", "trashSound", "heartbeatSound"];
// Video wallpapers are much bigger than images/short sound clips, so they get their own,
// larger size ceiling (still comfortably under the server's 25MB socket/body limit).
const SITE_VIDEO_MAX_BYTES = 18_000_000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------------------------------------
// PERMANENT STORAGE. Render's free server wipes its own disk on every redeploy /
// restart / sleep, so anything written next to this file disappears. To keep your
// wallpapers, sounds, character images and approved accounts "until you change
// them", they are saved in a Supabase Storage bucket (free) when these two env vars
// are set on Render:  SUPABASE_URL  and  SUPABASE_SERVICE_KEY  (bucket name defaults
// to "auction-data", override with SUPABASE_BUCKET). Without them it falls back to
// the local data/ folder (fine for your own laptop, NOT permanent on Render).
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "auction-data";
const REMOTE_STORE = !!(SUPABASE_URL && SUPABASE_KEY);
const LOCAL_DIR = path.join(__dirname, "data");
const safeName = (n: string) => n.replace(/[^a-zA-Z0-9_.-]/g, "_");
const sbHeaders = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, ...extra });

async function storePut(name: string, value: string): Promise<boolean> {
  const key = safeName(name);
  try {
    if (REMOTE_STORE) {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${key}`, {
        method: "POST", headers: sbHeaders({ "x-upsert": "true", "Content-Type": "text/plain" }), body: value,
      });
      if (!r.ok) { console.error(`[store] save ${key} failed: ${r.status} ${await r.text().catch(() => "")}`); return false; }
    } else {
      fs.mkdirSync(LOCAL_DIR, { recursive: true });
      fs.writeFileSync(path.join(LOCAL_DIR, key), value);
    }
    return true;
  } catch (e) { console.error(`[store] save ${key} error`, e); return false; }
}
// Like storeGet, but tells "file does not exist" apart from "storage is down / errored".
// Used for the files that hold lists (sessions, approved accounts, library, rooms) so a
// temporary Supabase hiccup at start-up can never be mistaken for an empty list and then
// overwrite the real one.
async function storeGetSafe(name: string): Promise<{ value: string | null; error: boolean }> {
  const key = safeName(name);
  try {
    if (REMOTE_STORE) {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${key}`, { headers: sbHeaders() });
      if (r.ok) return { value: await r.text(), error: false };
      if (r.status >= 500 || r.status === 429 || r.status === 401 || r.status === 403) return { value: null, error: true };
      return { value: null, error: false }; // 400/404 = not created yet
    }
    const f = path.join(LOCAL_DIR, key);
    return { value: fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : null, error: false };
  } catch { return { value: null, error: true }; }
}
async function storeGet(name: string): Promise<string | null> {
  const key = safeName(name);
  try {
    if (REMOTE_STORE) {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${key}`, { headers: sbHeaders() });
      if (!r.ok) return null;
      return await r.text();
    }
    const f = path.join(LOCAL_DIR, key);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : null;
  } catch { return null; }
}
async function storeDelete(name: string): Promise<void> {
  const key = safeName(name);
  try {
    if (REMOTE_STORE) await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${key}`, { method: "DELETE", headers: sbHeaders() });
    else { const f = path.join(LOCAL_DIR, key); if (fs.existsSync(f)) fs.unlinkSync(f); }
  } catch { /* non-fatal */ }
}
async function ensureBucket() {
  if (!REMOTE_STORE) return;
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: "POST", headers: sbHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id: SUPABASE_BUCKET, name: SUPABASE_BUCKET, public: false, file_size_limit: 50 * 1024 * 1024 }),
    }); // "already exists" is fine
  } catch { /* ignore */ }
}

// --------------------------------------------------------------------------------
// MEDIA — every uploaded image / sound / video is stored ONCE, by content hash, in
// permanent storage and served from /media/<hash> with a 1-year cache. The game state,
// the site config and the library only ever hold that short URL — never a giant
// base64 string — so nothing is re-sent every second, and a link never breaks after a
// refresh, restart or redeploy. (Browser blob: URLs are rejected here on purpose.)
const mediaMem = new Map<string, { mime: string; buf: Buffer }>();
const mediaPersisted = new Set<string>();
const pendingMedia = new Set<Promise<void>>();
const MEDIA_MIME = /^(image|audio|video)\/[a-z0-9.+-]+$/i;
const MEDIA_URL_RE = /\/media\/([a-f0-9]{20})(?:[?#].*)?$/;
function parseDataUrl(v: string): { mime: string; b64: string } | null {
  if (!v.startsWith("data:")) return null;
  const i = v.indexOf(";base64,");
  if (i < 0) return null;
  const mime = v.slice(5, i).split(";")[0].toLowerCase();
  if (!MEDIA_MIME.test(mime)) return null;
  return { mime, b64: v.slice(i + 8) };
}
function registerMedia(dataUrl: string): string | undefined {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return undefined;
  const buf = Buffer.from(parsed.b64, "base64");
  if (!buf.length) return undefined;
  const hash = createHash("sha1").update(buf).digest("hex").slice(0, 20);
  if (!mediaMem.has(hash)) mediaMem.set(hash, { mime: parsed.mime, buf });
  if (!mediaPersisted.has(hash)) {
    mediaPersisted.add(hash);
    const p: Promise<void> = storePut(`media-${hash}.txt`, dataUrl).then((ok) => { if (!ok) mediaPersisted.delete(hash); }).finally(() => { pendingMedia.delete(p); });
    pendingMedia.add(p);
  }
  return `/media/${hash}`;
}
async function flushMedia() { await Promise.all([...pendingMedia]); }
// Turns whatever the browser sent into the one form we store: /media/<hash>.
function normalizeImage(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  if (v.startsWith("data:")) return registerMedia(v);
  const m = MEDIA_URL_RE.exec(v);
  if (m) return `/media/${m[1]}`;
  return undefined; // blob:, bundled-asset paths and foreign URLs are never stored
}
app.get("/media/:hash", async (req, res) => {
  try {
    const hash = String(req.params.hash || "");
    if (!/^[a-f0-9]{20}$/.test(hash)) return void res.status(404).end();
    let m = mediaMem.get(hash);
    if (!m) {
      const { value } = await storeGetSafe(`media-${hash}.txt`);
      const parsed = value ? parseDataUrl(value) : null;
      if (parsed) { m = { mime: parsed.mime, buf: Buffer.from(parsed.b64, "base64") }; mediaMem.set(hash, m); mediaPersisted.add(hash); }
    }
    if (!m) return void res.status(404).end();
    const size = m.buf.length;
    res.set({
      "Content-Type": m.mime, "Cache-Control": "public, max-age=31536000, immutable", "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    if (range && (range[1] || range[2])) { // Safari/iOS will not play <video>/<audio> without Range support
      let start = range[1] ? parseInt(range[1], 10) : NaN;
      let end = range[2] ? parseInt(range[2], 10) : NaN;
      if (Number.isNaN(start)) { start = Math.max(0, size - end); end = size - 1; }
      else if (Number.isNaN(end) || end >= size) end = size - 1;
      if (start > end || start >= size) { res.status(416).set("Content-Range", `bytes */${size}`).end(); return; }
      res.status(206).set({ "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) });
      res.end(m.buf.subarray(start, end + 1));
      return;
    }
    res.set("Content-Length", String(size));
    res.end(m.buf);
  } catch (e) { console.error("[media] serve error", e); if (!res.headersSent) res.status(500).end(); }
});

// --------------------------------------------------------------------------------
// LOGIN SESSIONS — after Google verifies you once, the server hands your browser its
// own long-lived session token (kept in the browser's localStorage). On every page
// load the app quietly resumes with that token, so you stay signed in across
// refreshes, closing the browser and reopening, until you press Logout. Only a
// SHA-256 hash of each token is stored server-side. Sessions last 1 year and renew
// themselves whenever you use the app.
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
type Session = { email: string; name?: string; picture?: string; exp: number };
let sessions: Record<string, Session> = {};
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
function pruneSessions() {
  const now = Date.now();
  for (const [h, sess] of Object.entries(sessions)) if (!sess || sess.exp < now) delete sessions[h];
}
async function saveSessions() {
  if (!persistHealthy) return; // never overwrite the saved list while storage is unreadable
  pruneSessions();
  await storePut("sessions.json", JSON.stringify(sessions));
}
async function createSession(email: string, name?: string, picture?: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const mine = Object.entries(sessions).filter(([, x]) => x.email === email).sort((a, b) => a[1].exp - b[1].exp);
  while (mine.length >= 20) { const [h] = mine.shift()!; delete sessions[h]; } // keep at most 20 devices per account
  sessions[hashToken(token)] = { email, name, picture, exp: Date.now() + SESSION_TTL_MS };
  await saveSessions();
  return token;
}
function revokeSessionsFor(email: string) {
  for (const [h, sess] of Object.entries(sessions)) if (sess.email === email) delete sessions[h];
}

// Per-account saved settings (name, room settings, limits) — follows the Google account,
// not the device, so logging out and in (or using another phone) brings them back.
const profileKey = (email: string) => `profile-${createHash("sha1").update(email.toLowerCase()).digest("hex").slice(0, 20)}.json`;
function sanitizeProfile(raw: any) {
  const str = (v: any, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
  const num = (v: any, lo: number, hi: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.floor(Number(v)))) : undefined);
  const out: any = {};
  const name = str(raw?.name, 40); if (name !== undefined) out.name = name;
  const title = str(raw?.title, 60); if (title !== undefined) out.title = title;
  const budget = num(raw?.budget, 1000, 1_000_000_000); if (budget !== undefined) out.budget = budget;
  const increment = num(raw?.increment, 1, 1_000_000_000); if (increment !== undefined) out.increment = increment;
  const timer = num(raw?.timer, 5, 600); if (timer !== undefined) out.timer = timer;
  const teamCount = num(raw?.teamCount, 2, 12); if (teamCount !== undefined) out.teamCount = teamCount;
  if (Array.isArray(raw?.teamNames)) out.teamNames = raw.teamNames.slice(0, 12).map((n: any) => String(n ?? "").slice(0, 30));
  if (raw?.mode === "SOLO" || raw?.mode === "TEAM") out.mode = raw.mode;
  if (raw?.limits && typeof raw.limits === "object") out.limits = sanitizeLimits(raw.limits);
  return out;
}
async function loadProfile(email: string) {
  const { value } = await storeGetSafe(profileKey(email));
  try { return value ? sanitizeProfile(JSON.parse(value)) : null; } catch { return null; }
}

let persistHealthy = false;

let siteConfig: SiteConfig = {};
// Owner-set picture per character id (kept until the owner changes it again), and the
// host-set default room background for new rooms.
let charImages: Record<string, string> = {};
let roomBackgroundDefault: string | undefined;
async function saveSiteConfigField(field: SiteMediaField) {
  await flushMedia(); // make sure the file itself is stored before we save the pointer to it
  const v = siteConfig[field];
  if (v) await storePut(`site-${field}.txt`, v); else await storeDelete(`site-${field}.txt`);
}
async function saveCharImageIndex() {
  if (persistHealthy) await storePut("charimg-index.json", JSON.stringify(Object.keys(charImages)));
}
async function saveCharImage(id: string, image: string | undefined) {
  const url = normalizeImage(image);
  if (url) charImages[id] = url; else delete charImages[id];
  await flushMedia();
  if (url) await storePut(`charimg-${id}.txt`, url); else await storeDelete(`charimg-${id}.txt`);
  await saveCharImageIndex();
}
function withSavedImages(list: Character[]): Character[] {
  return list.map((c) => (!c.image && charImages[c.id] ? { ...c, image: charImages[c.id] } : c));
}

// --------------------------------------------------------------------------------
// CHARACTER LIBRARY — every built-in character plus every character the owner adds by
// hand. Manually added characters live here PERMANENTLY (Supabase) until the owner
// deletes them. The host then ticks which ones go into each auction (up to the limit),
// and the owner can save that ticked list as the default for all future rooms.
// Images of custom characters are stored through charImages (charimg-<id>.txt), so the
// library file itself stays small.
let customLibrary: Character[] = [];
let defaultSelection: string[] | null = null;
const LIB_LIMITS: CharacterLimits = { maxCharacters: 1000, minValue: 0, maxValue: 1_000_000_000, maxPower: 100 };
async function saveLibrary() {
  if (!persistHealthy) return;
  const slim = customLibrary.map((c) => ({ ...c, image: undefined }));
  await storePut("char-library.json", JSON.stringify(slim));
}
async function saveDefaultSelection() {
  if (!persistHealthy) return;
  if (defaultSelection) await storePut("char-selection.json", JSON.stringify(defaultSelection)); else await storeDelete("char-selection.json");
}
// Owner actions that rewrite a saved list wait until storage has been read successfully.
function storageReady(socket: any): boolean {
  if (persistHealthy) return true;
  socket.emit("errorMessage", "Storage is still waking up — try again in a few seconds.");
  return false;
}
function fullLibrary(): Character[] {
  return withSavedImages([...demoCharacters, ...customLibrary]);
}
function libraryPayload() {
  return { characters: fullLibrary(), selection: defaultSelection };
}
function sendLibraryToWatchers() {
  const payload = libraryPayload();
  for (const [, sk] of io.sockets.sockets) if (sk.data.wantsLibrary) sk.emit("library", payload);
}
// Characters for a brand-new room: the owner's saved default list if there is one,
// otherwise the first ones in the library.
function initialCharacters(limits: CharacterLimits): Character[] {
  const lib = fullLibrary();
  if (defaultSelection && defaultSelection.length) {
    const picked = defaultSelection.map((id) => lib.find((c) => c.id === id)).filter(Boolean) as Character[];
    if (picked.length) return sanitizeCharacterList(picked, limits);
  }
  return sanitizeCharacterList(lib, limits);
}
// How many characters the host must pick before the auction can start.
function requiredCount(limits: CharacterLimits): number {
  return Math.min(limits.maxCharacters, fullLibrary().length);
}

// --------------------------------------------------------------------------------
// Google Sign-In gate — only Gmail (or Google Workspace) accounts on the owner's
// approved list can do anything on this server. Set GOOGLE_CLIENT_ID to the OAuth
// Client ID from your own Google Cloud project (Credentials > OAuth client ID >
// Web application). Set AUCTION_OWNER_EMAIL to your own Google account's email so
// you're never locked out of your own site — it's auto-added to the approved list
// the very first time the server runs.
const GOOGLE_CLIENT_ID = process.env.AUCTION_GOOGLE_CLIENT_ID || "787395401483-p8ltdpr8kqsvgbq0u9bm10df3b4ofg4l.apps.googleusercontent.com";
const OWNER_EMAIL = (process.env.AUCTION_OWNER_EMAIL || "you@gmail.com").toLowerCase();
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
let allowedEmails: string[] = [OWNER_EMAIL];
// Optional: AUCTION_ALLOWED_EMAILS="a@gmail.com,b@gmail.com" on Render always keeps these approved.
const SEED_EMAILS = (process.env.AUCTION_ALLOWED_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
async function saveAllowedEmails() { if (!persistHealthy) return; await storePut("allowed-emails.json", JSON.stringify(allowedEmails)); }

// Load everything saved earlier. Runs at start-up; sign-in and owner actions wait for it.
// Site files / images are read first (each lives in its own file). The "list" files
// (sessions, approved accounts, library, rooms) are read with error detection: if
// storage is unreachable we retry every 5 s and MERGE, and refuse to overwrite the
// saved lists until they have really been read (persistHealthy).
async function loadSiteFiles() {
  await Promise.all(SITE_MEDIA_FIELDS.map(async (f) => {
    const v = await storeGet(`site-${f}.txt`);
    if (!v) return;
    const m = MEDIA_URL_RE.exec(v);
    const norm = v.startsWith("data:") ? registerMedia(v) : m ? `/media/${m[1]}` : undefined;
    if (!norm) return;
    siteConfig[f] = norm;
    if (v.startsWith("data:")) { await flushMedia(); await storePut(`site-${f}.txt`, norm); } // one-time upgrade of old saves
  }));
}
async function loadCritical(isRetry: boolean): Promise<boolean> {
  let ok = true;
  const get = async (name: string) => { const r = await storeGetSafe(name); if (r.error) ok = false; return r.value; };
  const lower = (arr: unknown[]) => arr.map((e) => String(e).toLowerCase());
  try { // approved accounts
    const raw = await get("allowed-emails.json");
    const stored: string[] = raw ? JSON.parse(raw) : [];
    allowedEmails = Array.from(new Set([...allowedEmails, OWNER_EMAIL, ...SEED_EMAILS, ...lower(stored)]));
  } catch { /* corrupt file — keep defaults */ }
  try { // login sessions
    const raw = await get("sessions.json");
    const stored = raw ? JSON.parse(raw) : {};
    sessions = { ...stored, ...sessions };
    pruneSessions();
  } catch { /* ignore */ }
  try { // owner-set character pictures
    const idx = await get("charimg-index.json");
    const ids: string[] = idx ? JSON.parse(idx) : [];
    const upgrades: [string, string][] = [];
    await Promise.all(ids.map(async (id) => {
      const v = await get(`charimg-${id}.txt`);
      if (!v || charImages[id]) return;
      const m = MEDIA_URL_RE.exec(v);
      const norm = v.startsWith("data:") ? registerMedia(v) : m ? `/media/${m[1]}` : undefined;
      if (!norm) return;
      charImages[id] = norm;
      if (v.startsWith("data:")) upgrades.push([id, norm]);
    }));
    if (upgrades.length) { await flushMedia(); for (const [id, url] of upgrades) await storePut(`charimg-${id}.txt`, url); }
  } catch { /* ignore */ }
  try { // permanent character library
    const raw = await get("char-library.json");
    const parsed: Partial<Character>[] = raw ? JSON.parse(raw) : [];
    for (const c of parsed) if (c?.id && !customLibrary.some((x) => x.id === c.id)) customLibrary.push(clampCharacter(c, LIB_LIMITS, String(c.id)));
  } catch { /* ignore */ }
  try { // saved default selection
    const raw = await get("char-selection.json");
    const ids = raw ? JSON.parse(raw) : null;
    if (defaultSelection === null && Array.isArray(ids)) defaultSelection = ids.map(String);
  } catch { /* ignore */ }
  try { // room background used for new rooms
    const raw = await get("room-background.txt");
    if (raw && !roomBackgroundDefault) {
      const m = MEDIA_URL_RE.exec(raw);
      roomBackgroundDefault = raw.startsWith("data:") ? registerMedia(raw) : m ? `/media/${m[1]}` : undefined;
      if (raw.startsWith("data:") && roomBackgroundDefault) { await flushMedia(); await storePut("room-background.txt", roomBackgroundDefault); }
    }
  } catch { /* ignore */ }
  try { // rooms that were open before a restart — paused until somebody signs back in
    const raw = await get("rooms.json");
    const arr: any[] = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    for (const r of arr) {
      if (!r?.code || !r.state || rooms.has(r.code)) continue;
      if (now - (r.active || 0) > ROOM_IDLE_MS) continue;
      const st = r.state as AuctionState;
      st.players.forEach((pl) => { pl.connected = false; });
      rooms.set(r.code, st);
      emailsByRoom.set(r.code, new Map(r.emails || []));
      unsoldCountsByRoom.set(r.code, new Map(r.unsold || []));
      if (Array.isArray(r.original)) originalCharacters.set(r.code, r.original);
      roomActivity.set(r.code, r.active || now);
    }
  } catch { /* ignore */ }
  if (ok) {
    const wasUnhealthy = !persistHealthy;
    persistHealthy = true;
    if (isRetry && wasUnhealthy) { // write back anything created while storage was unreachable
      await Promise.all([saveAllowedEmails(), saveSessions(), saveLibrary(), saveDefaultSelection(), saveCharImageIndex(), persistRooms()]);
    }
  }
  return ok;
}
let criticalRetry: NodeJS.Timeout | null = null;
function scheduleCriticalRetry() {
  if (criticalRetry) return;
  criticalRetry = setTimeout(async () => {
    criticalRetry = null;
    const ok = await loadCritical(true).catch(() => false);
    if (ok) console.log("[store] storage recovered"); else scheduleCriticalRetry();
  }, 5000);
}
async function loadPersisted() {
  await ensureBucket();
  await loadSiteFiles();
  const ok = await loadCritical(false);
  if (!ok) { console.error("[store] could not read some saved data yet — will keep retrying, and will not overwrite it"); scheduleCriticalRetry(); }
  console.log(`[store] ${REMOTE_STORE ? "Supabase" : "LOCAL DISK (not permanent on Render!)"} — loaded ${Object.keys(siteConfig).length} site files, ${allowedEmails.length} approved accounts, ${Object.keys(sessions).length} sessions, ${Object.keys(charImages).length} character images, ${customLibrary.length} library characters, ${rooms.size} open rooms`);
}
const persistReady: Promise<void> = loadPersisted().catch((e) => { console.error("[store] load failed", e); scheduleCriticalRetry(); });
persistReady.then(() => { io.emit("siteConfig", siteConfig); });

// --- Rooms survive restarts: saved (throttled) to rooms.json, restored on boot -------
let persistTimer: NodeJS.Timeout | null = null;
function schedulePersistRooms() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; void persistRooms(); }, 4000);
}
async function persistRooms() {
  if (!persistHealthy) return;
  const out = [...rooms.entries()].map(([code, st]) => ({
    code, state: st,
    emails: [...(emailsByRoom.get(code)?.entries() || [])],
    unsold: [...(unsoldCountsByRoom.get(code)?.entries() || [])],
    original: originalCharacters.get(code) || null,
    active: roomActivity.get(code) || Date.now(),
  }));
  await storePut("rooms.json", JSON.stringify(out));
}
// Drop rooms nobody has touched for 12 hours so memory and storage don't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [code] of rooms) {
    if (now - (roomActivity.get(code) || 0) > ROOM_IDLE_MS) {
      stopTimer(code); rooms.delete(code); emailsByRoom.delete(code); unsoldCountsByRoom.delete(code);
      originalCharacters.delete(code); roomActivity.delete(code);
      schedulePersistRooms();
    }
  }
}, 30 * 60 * 1000).unref();
function isApprovedEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return allowedEmails.includes(email.toLowerCase());
}
// A socket must have a verified, approved email before touching gameplay.
function requireAuth(socket: any): boolean {
  if (socket.data.authedEmail) return true;
  socket.emit("errorMessage", "Please sign in with an approved Google account first.");
  return false;
}

const colors = ["#ff3b3b","#ffb454","#6ee7ff","#d9ff45","#ff7ab8","#b794ff","#62e6a5","#8ab4ff","#ff8f6b","#7cf2c4","#c084fc","#5eead4"];

function roomCode(){ return randomBytes(3).toString("hex").toUpperCase(); }
function clone<T>(v:T):T { return JSON.parse(JSON.stringify(v)); }
function emit(room:string){ const s=rooms.get(room); if(s){ io.to(room).emit("state",clone(s)); roomActivity.set(room, Date.now()); schedulePersistRooms(); } }
function stopTimer(room:string){ const t=timers.get(room); if(t){ clearInterval(t); timers.delete(room); } }

function sanitizeLimits(raw:Partial<CharacterLimits> | undefined): CharacterLimits {
  const maxCharacters = Math.min(200, Math.max(2, Math.floor(Number(raw?.maxCharacters) || defaultLimits.maxCharacters)));
  const rawMin = Number(raw?.minValue);
  const minValue = Math.max(0, Math.floor(Number.isFinite(rawMin) ? rawMin : defaultLimits.minValue));
  const maxValue = Math.max(minValue + 1, Math.floor(Number(raw?.maxValue) || defaultLimits.maxValue));
  const maxPower = Math.min(100, Math.max(1, Math.floor(Number(raw?.maxPower) || defaultLimits.maxPower)));
  return { maxCharacters, minValue, maxValue, maxPower };
}

function clampCharacter(c: Partial<Character>, limits: CharacterLimits, fallbackId: string): Character {
  const power = Math.min(limits.maxPower, Math.max(1, Math.floor(Number(c.power) || Math.round(limits.maxPower * 0.7))));
  const basePrice = Math.min(limits.maxValue, Math.max(limits.minValue, Math.floor(Number(c.basePrice) || limits.minValue)));
  const popularity = Math.min(100, Math.max(1, Math.floor(Number(c.popularity) || power)));
  return {
    id: c.id || fallbackId,
    name: (c.name || "Unnamed Character").toString().slice(0, 60),
    universe: (c.universe || "Custom").toString().slice(0, 40),
    basePrice, power, popularity,
    rarity: (c.rarity || "Custom").toString().slice(0, 30),
    abilityNote: (c.abilityNote || "").toString().slice(0, 220),
    image: normalizeImage(c.image),
  };
}

function sanitizeCharacterList(list: Partial<Character>[], limits: CharacterLimits): Character[] {
  return list.slice(0, limits.maxCharacters).map((c, i) => clampCharacter(c, limits, `char-${Date.now()}-${i}`));
}

function startTimer(room:string){
  stopTimer(room);
  const timer=setInterval(()=>{
    const s=rooms.get(room);
    if(!s || s.phase!=="BIDDING"){ stopTimer(room); return; }
    s.timer--;
    if(s.timer<=0){ concludeCurrent(room, !!s.currentBidderTeamId); return; }
    emit(room);
  },1000);
  timers.set(room,timer);
}

// Resolve the character currently up for bidding: sold to the highest bidder;
// unsold for the first time goes to the queue to be re-auctioned next round;
// unsold a second time is permanently discarded (never re-auctioned again).
function concludeCurrent(room:string, sold:boolean){
  const s=rooms.get(room); if(!s || s.phase!=="BIDDING") return;
  stopTimer(room);
  const character=s.characters[s.currentIndex];
  if(!character) return;
  if(sold && s.currentBidderTeamId){
    const team=s.teams.find(t=>t.id===s.currentBidderTeamId);
    if(team){
      team.spent += s.currentBid;
      team.roster.push(character);
      s.history.push({ character, teamId: team.id, amount: s.currentBid, playerId: s.currentBidderPlayerId || undefined, playerName: s.currentBidderName || undefined });
    }
  } else {
    const counts = unsoldCountsByRoom.get(room) || new Map<string, number>();
    const timesUnsold = (counts.get(character.id) || 0) + 1;
    counts.set(character.id, timesUnsold);
    unsoldCountsByRoom.set(room, counts);
    if (timesUnsold === 1) s.unsoldQueue.push(character);
    else s.finalUnsold.push(character);
  }
  advanceAuction(room);
}

function advanceAuction(room:string){
  const s=rooms.get(room); if(!s) return;
  s.currentIndex++;
  if(s.currentIndex >= s.characters.length){
    const roundSize = s.characters.length;
    const unsoldCount = s.unsoldQueue.length;
    // Start a re-auction round only if something actually sold last round
    // (otherwise every character is unsold and we'd loop forever).
    if(unsoldCount > 0 && unsoldCount < roundSize && s.round < MAX_ROUNDS){
      s.round++;
      s.characters = s.unsoldQueue;
      s.unsoldQueue = [];
      s.currentIndex = 0;
      s.phase = "BIDDING";
      s.currentBid = s.characters[0].basePrice;
      s.currentBidderTeamId = null; s.currentBidderPlayerId = null; s.currentBidderName = null;
      s.timer = s.timerMax;
      emit(room);
      startTimer(room);
      return;
    }
    // Any characters still queued when rounds run out are discarded too —
    // append, don't overwrite, so mid-round trashed characters aren't lost.
    s.finalUnsold = [...s.finalUnsold, ...s.unsoldQueue];
    s.unsoldQueue = [];
    s.phase = "COMPLETE";
    emit(room);
    return;
  }
  s.phase = "BIDDING";
  s.currentBid = s.characters[s.currentIndex].basePrice;
  s.currentBidderTeamId = null; s.currentBidderPlayerId = null; s.currentBidderName = null;
  s.timer = s.timerMax;
  emit(room);
  startTimer(room);
}

// After a successful sign-in / resume: send the saved profile and put the person back in the
// room they were in (a refresh gives the browser a new socket id, so their seat is re-bound).
async function afterAuth(socket: any, email: string) {
  const prof = await loadProfile(email);
  socket.emit("profile", prof);
  rejoinRoom(socket, email);
}
function rejoinRoom(socket: any, email: string) {
  const key = email.toLowerCase();
  let best: { code: string; oldId: string } | null = null;
  for (const [code, seen] of emailsByRoom) {
    const oldId = seen.get(key); const st = rooms.get(code);
    if (!oldId || !st || !st.players.some((x) => x.id === oldId)) continue;
    if (!best || (roomActivity.get(code) || 0) > (roomActivity.get(best.code) || 0)) best = { code, oldId };
  }
  if (!best) return;
  const { code, oldId } = best; const st = rooms.get(code)!;
  if (oldId !== socket.id) {
    const oldSock = io.sockets.sockets.get(oldId);
    if (oldSock) { oldSock.leave(code); oldSock.data.room = undefined; } // same account opened in a second tab: latest one wins
    const pl = st.players.find((x) => x.id === oldId)!;
    pl.id = socket.id;
    for (const tm of st.teams) tm.members = tm.members.map((id) => (id === oldId ? socket.id : id));
    if (st.currentBidderPlayerId === oldId) st.currentBidderPlayerId = socket.id;
    for (const h of st.history) if (h.playerId === oldId) h.playerId = socket.id;
    emailsByRoom.get(code)!.set(key, socket.id);
  }
  const me = st.players.find((x) => x.id === socket.id)!;
  me.connected = true;
  socket.join(code); socket.data.room = code;
  if (st.phase === "BIDDING" && !timers.has(code)) startTimer(code); // a restored room stays paused until someone is back
  emit(code);
  socket.emit("resumedRoom", { roomCode: code, phase: st.phase });
}

io.on("connection", socket=>{
  // Push the current owner-set site background + sounds to every new connection —
  // this is independent of any room and applies to the landing page / auction page.
  socket.emit("siteConfig", siteConfig);

  socket.on("setSiteConfig", async (data:{key:string; field:SiteMediaField; value:string})=>{
    await persistReady;
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage","Incorrect owner key.");
    if (!SITE_MEDIA_FIELDS.includes(data.field)) return;
    if (typeof data.value !== "string") return;
    const limit = data.field === "backgroundVideo" ? SITE_VIDEO_MAX_BYTES : 8_000_000;
    if (data.value.length > limit) return socket.emit("errorMessage","That file is too large — try a smaller one.");
    const norm = data.value ? normalizeImage(data.value) : undefined;
    if (data.value && !norm) return socket.emit("errorMessage","Unsupported file — use an image, audio or video file.");
    siteConfig = { ...siteConfig, [data.field]: norm };
    io.emit("siteConfig", siteConfig); // broadcast to everyone, everywhere, live
    await saveSiteConfigField(data.field); // permanent — survives restarts/redeploys
  });

  // --- Google Sign-In -----------------------------------------------------------
  socket.on("googleSignIn", async (data: { idToken: string }) => {
    try {
      await persistReady;
      const ticket = await oauthClient.verifyIdToken({ idToken: data?.idToken, audience: GOOGLE_CLIENT_ID });
      const payload = ticket.getPayload();
      const email = payload?.email?.toLowerCase();
      if (!email || !payload?.email_verified) {
        return socket.emit("authResult", { ok: false, reason: "unverified" });
      }
      if (!isApprovedEmail(email)) {
        return socket.emit("authResult", { ok: false, reason: "not_allowed", email });
      }
      const token = await createSession(email, payload.name, payload.picture);
      socket.data.authedEmail = email;
      socket.data.sessionHash = hashToken(token);
      socket.emit("authResult", { ok: true, email, name: payload.name, picture: payload.picture, sessionToken: token });
      await afterAuth(socket, email);
    } catch {
      socket.emit("authResult", { ok: false, reason: "invalid_token" });
    }
  });

  // Quietly resume a saved login (page refresh / browser reopened / server woke up).
  socket.on("resumeSession", async (data: { token: string }) => {
    try {
      await persistReady;
      const tok = typeof data?.token === "string" ? data.token : "";
      let h = tok ? hashToken(tok) : "";
      if (h && !sessions[h] && !persistHealthy) { // storage was unreachable at boot — try once more before judging
        await loadCritical(true).catch(() => false);
      }
      const sess = h ? sessions[h] : undefined;
      if (!sess || sess.exp < Date.now()) {
        if (!persistHealthy) return socket.emit("authResult", { ok: false, reason: "server_error" }); // keep the token, client retries
        return socket.emit("authResult", { ok: false, reason: "session_expired" });
      }
      if (!isApprovedEmail(sess.email)) {
        delete sessions[h]; void saveSessions();
        return socket.emit("authResult", { ok: false, reason: "not_allowed", email: sess.email });
      }
      socket.data.authedEmail = sess.email;
      socket.data.sessionHash = h;
      if (sess.exp - Date.now() < SESSION_TTL_MS - 24 * 60 * 60 * 1000) { sess.exp = Date.now() + SESSION_TTL_MS; void saveSessions(); } // sliding renewal, at most daily
      socket.emit("authResult", { ok: true, email: sess.email, name: sess.name, picture: sess.picture });
      await afterAuth(socket, sess.email);
    } catch (e) {
      console.error("[auth] resume error", e);
      socket.emit("authResult", { ok: false, reason: "server_error" });
    }
  });

  // Logout: forget this device's session for good and step out of the room's live view
  // (your seat is kept, so signing back in puts you right back).
  socket.on("logout", async (data: { token?: string }) => {
    const h = socket.data.sessionHash || (typeof data?.token === "string" && data.token ? hashToken(data.token) : "");
    if (h && sessions[h]) { delete sessions[h]; await saveSessions(); }
    const room = socket.data.room; const st = room ? rooms.get(room) : undefined;
    if (st) {
      const pl = st.players.find((x) => x.id === socket.id);
      if (pl) pl.connected = false;
      socket.leave(room); socket.data.room = undefined; emit(room);
    }
    socket.data.authedEmail = undefined; socket.data.sessionHash = undefined; socket.data.wantsLibrary = false;
    socket.emit("loggedOut");
  });

  // Saved per-account settings (player name, room settings, limits).
  socket.on("saveProfile", async (data: { settings: any }) => {
    const email = socket.data.authedEmail as string | undefined;
    if (!email || !persistHealthy) return;
    await storePut(profileKey(email), JSON.stringify(sanitizeProfile(data?.settings)));
  });

  // --- Owner-managed approved-accounts list (needs the owner key, not Google auth) ---
  socket.on("listAllowedEmails", async (data: { key: string }) => {
    await persistReady;
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage", "Incorrect owner key.");
    socket.emit("allowedEmailsList", allowedEmails);
  });
  socket.on("addAllowedEmail", async (data: { key: string; email: string }) => {
    await persistReady;
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage", "Incorrect owner key.");
    if (!storageReady(socket)) return;
    const email = (data.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return socket.emit("errorMessage", "Enter a valid email address.");
    if (!allowedEmails.includes(email)) { allowedEmails.push(email); await saveAllowedEmails(); }
    socket.emit("allowedEmailsList", allowedEmails);
  });
  socket.on("removeAllowedEmail", async (data: { key: string; email: string }) => {
    await persistReady;
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage", "Incorrect owner key.");
    if (!storageReady(socket)) return;
    const gone = (data.email || "").trim().toLowerCase();
    if (gone === OWNER_EMAIL) return socket.emit("errorMessage", "The owner account can't be removed.");
    allowedEmails = allowedEmails.filter((e) => e !== gone);
    revokeSessionsFor(gone); // a removed account is signed out everywhere
    for (const [, sk] of io.sockets.sockets) {
      if (sk.data.authedEmail === gone) { sk.data.authedEmail = undefined; sk.emit("authResult", { ok: false, reason: "not_allowed", email: gone }); }
    }
    await saveAllowedEmails();
    await saveSessions();
    socket.emit("allowedEmailsList", allowedEmails);
  });

  socket.on("createRoom",(cfg:{
    name:string; title:string; mode?:GameMode; teamNames:string[]; budget:number;
    bidIncrement:number; timerMax:number; characters:Character[]; limits?:Partial<CharacterLimits>;
  })=>{
    if (!requireAuth(socket)) return;
    if (!cfg || typeof cfg !== "object") return;
    const code=roomCode();
    const limits=sanitizeLimits(cfg.limits);
    const mode:GameMode = cfg.mode === "SOLO" ? "SOLO" : "TEAM";
    const budget = Math.max(1000, cfg.budget || 100000);

    let teams:Team[];
    if(mode === "SOLO"){
      teams = [{ id:"t1", name:(cfg.name||"Host").trim(), members:[socket.id], budget, spent:0, roster:[], color:colors[0] }];
    } else {
      const names = cfg.teamNames?.length ? cfg.teamNames : ["Team Alpha","Team Beta"];
      teams = names.map((nm,i)=>({
        id:`t${i+1}`, name:(nm||`Team ${i+1}`).trim() || `Team ${i+1}`,
        members: i===0 ? [socket.id] : [], budget, spent:0, roster:[], color:colors[i%colors.length]
      }));
    }
    const hostTeam = teams[0];
    const player:Player={id:socket.id,name:cfg.name||"Host",teamId:hostTeam.id,connected:true,isHost:true};
    const characters = initialCharacters(limits);
    const state:AuctionState={
      roomCode:code, title:cfg.title||"Character Auction", mode, phase:"LOBBY",
      players:[player], teams, characters, limits, background:roomBackgroundDefault,
      round:1, unsoldQueue:[], finalUnsold:[],
      currentIndex:0, currentBid:0, currentBidderTeamId:null, currentBidderPlayerId:null, currentBidderName:null,
      bidIncrement:Math.max(1,cfg.bidIncrement||1000),
      timer:Math.max(5,cfg.timerMax||15), timerMax:Math.max(5,cfg.timerMax||15), history:[]
    };
    rooms.set(code,state); unsoldCountsByRoom.set(code, new Map());
    emailsByRoom.set(code, new Map([[String(socket.data.authedEmail).toLowerCase(), socket.id]])); socket.join(code); socket.data.room=code; emit(code);
  });

  socket.on("joinRoom",(data:{roomCode:string;name:string;teamId?:string})=>{
    if (!requireAuth(socket)) return;
    if (!data || typeof data !== "object") return;
    const s=rooms.get(String(data.roomCode||"").toUpperCase());
    if(!s) return socket.emit("errorMessage","Room not found.");
    if(s.phase!=="LOBBY") return socket.emit("errorMessage","This auction has already started.");

    // One entry per Google account: the same account can't be a player twice in a room.
    const emailKey=String(socket.data.authedEmail).toLowerCase();
    const seen=emailsByRoom.get(s.roomCode) || new Map<string,string>();
    emailsByRoom.set(s.roomCode, seen);
    if(s.players.some(x=>x.id===socket.id)) return socket.emit("errorMessage","You are already in this room.");
    const existingId=seen.get(emailKey);
    if(existingId){
      const old=s.players.find(x=>x.id===existingId);
      if(old && old.isHost) return socket.emit("errorMessage","This Google account is the host of this room.");
      if(old && old.connected) return socket.emit("errorMessage","This Google account has already joined this room as a player.");
      // Previous connection dropped (refresh / lost signal): let them take their seat back.
      if(old){
        s.players=s.players.filter(x=>x.id!==old.id);
        for(const tm of s.teams) tm.members=tm.members.filter(id=>id!==old.id);
        if(s.mode==="SOLO" && !old.isHost) s.teams=s.teams.filter(tm=>tm.members.length>0 || tm.id==="t1");
      }
    }

    let team:Team|undefined;
    if(s.mode === "SOLO"){
      if(s.teams.length >= MAX_SOLO_PLAYERS) return socket.emit("errorMessage","Room is full.");
      team = {
        id:`t${s.teams.length+1}`, name:data.name?.trim() || `Player ${s.teams.length+1}`,
        members:[], budget:s.teams[0]?.budget || 100000, spent:0, roster:[], color:colors[s.teams.length % colors.length]
      };
      s.teams.push(team);
    } else {
      // No team chosen yet -> put the newcomer on the emptiest team (so a friend lands as an opponent, not on the host's team).
      team = data.teamId
        ? s.teams.find(t=>t.id===data.teamId)
        : [...s.teams].sort((a,b)=>a.members.length-b.members.length)[0];
      if(!team) return socket.emit("errorMessage","Choose a valid team.");
      if(team.members.length>=5) return socket.emit("errorMessage","That team is full (max 5).");
    }
    const player:Player={id:socket.id,name:data.name?.trim()||`Player ${s.players.length+1}`,teamId:team.id,connected:true,isHost:false};
    s.players.push(player); team.members.push(socket.id); seen.set(emailKey, socket.id);
    socket.join(s.roomCode); socket.data.room=s.roomCode; emit(s.roomCode);
  });

  // Lets a player move to a different team while still in the lobby (Team mode only).
  socket.on("switchTeam",(data:{teamId:string})=>{
    if (!requireAuth(socket)) return;
    const s=rooms.get(socket.data.room);
    if(!s) return;
    if(s.mode!=="TEAM") return;
    if(s.phase!=="LOBBY") return socket.emit("errorMessage","Teams are locked once the auction starts.");
    const player=s.players.find(x=>x.id===socket.id);
    const target=s.teams.find(t=>t.id===data?.teamId);
    if(!player || !target) return;
    if(player.teamId===target.id) return;
    if(target.members.length>=5) return socket.emit("errorMessage","That team is full (max 5).");
    const from=s.teams.find(t=>t.id===player.teamId);
    if(from) from.members=from.members.filter(id=>id!==socket.id);
    target.members.push(socket.id);
    player.teamId=target.id;
    emit(s.roomCode);
  });

  socket.on("startAuction",()=>{
    if (!requireAuth(socket)) return;
    const room=socket.data.room; const s=rooms.get(room);
    const p=s?.players.find(x=>x.id===socket.id);
    if(!s || !p?.isHost) return socket.emit("errorMessage","Only the host can start.");
    if(s.phase!=="LOBBY") return;
    if(!s.characters.length) return socket.emit("errorMessage","Add at least one character before starting.");
    const need = requiredCount(s.limits);
    if(s.characters.length < need) return socket.emit("errorMessage",`Select ${need} characters first (you have ${s.characters.length}/${need}).`);
    unsoldCountsByRoom.set(room, new Map());
    originalCharacters.set(room, clone(s.characters)); // so "Play Again" gets the full list back, not just the last re-auction round
    s.phase="BIDDING"; s.round=1; s.unsoldQueue=[]; s.finalUnsold=[];
    s.currentIndex=0; s.currentBid=s.characters[0].basePrice; s.currentBidderTeamId=null; s.currentBidderPlayerId=null; s.currentBidderName=null; s.timer=s.timerMax;
    emit(room); startTimer(room);
  });

  socket.on("bid",(data:{amount:number})=>{
    if (!requireAuth(socket)) return;
    const room=socket.data.room; const s=rooms.get(room);
    if(!s || s.phase!=="BIDDING") return;
    const p=s.players.find(x=>x.id===socket.id);
    const team=s.teams.find(t=>t.id===p?.teamId);
    const amount=Math.floor(Number(data.amount));
    if(!p || !team || !Number.isFinite(amount)) return;
    if(amount<s.currentBid+s.bidIncrement) return socket.emit("errorMessage",`Minimum bid is ₹${s.currentBid+s.bidIncrement}.`);
    if(team.budget-team.spent<amount) return socket.emit("errorMessage","Your team doesn't have enough budget.");
    s.currentBid=amount; s.currentBidderTeamId=team.id; s.currentBidderPlayerId=p.id; s.currentBidderName=p.name;
    if(s.timer<=3) s.timer=Math.min(s.timerMax,10);
    emit(room);
  });

  // Host-controlled resolution — no need to wait for the timer to run out.
  socket.on("markSold",()=>{
    if (!requireAuth(socket)) return;
    const room=socket.data.room; const s=rooms.get(room);
    const p=s?.players.find(x=>x.id===socket.id);
    if(!s || !p?.isHost || s.phase!=="BIDDING") return;
    if(!s.currentBidderTeamId) return socket.emit("errorMessage","No bids yet — use Unsold / Skip instead.");
    concludeCurrent(room, true);
  });
  socket.on("markUnsold",()=>{
    if (!requireAuth(socket)) return;
    const room=socket.data.room; const s=rooms.get(room);
    const p=s?.players.find(x=>x.id===socket.id);
    if(!s || !p?.isHost || s.phase!=="BIDDING") return;
    concludeCurrent(room, false);
  });

  socket.on("shuffle",()=>{
    if (!requireAuth(socket)) return;
    const room=socket.data.room; const s=rooms.get(room);
    const p=s?.players.find(x=>x.id===socket.id);
    if(!s || !p?.isHost || s.phase!=="LOBBY") return;
    const remaining=s.characters.slice();
    for(let i=remaining.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[remaining[i],remaining[j]]=[remaining[j],remaining[i]];}
    s.characters=remaining; emit(room);
  });

  socket.on("updateLimits",(raw:Partial<CharacterLimits>)=>{
    if (!requireAuth(socket)) return;
    const room=socket.data.room; const s=rooms.get(room);
    const p=s?.players.find(x=>x.id===socket.id);
    if(!s || !p?.isHost || s.phase!=="LOBBY") return;
    s.limits = sanitizeLimits(raw);
    s.characters = sanitizeCharacterList(s.characters, s.limits);
    emit(room);
  });

  socket.on("updateCharacters",(characters:Partial<Character>[])=>{
    if (!requireAuth(socket)) return;
    const room=socket.data.room; const s=rooms.get(room);
    const p=s?.players.find(x=>x.id===socket.id);
    if(!s || !p?.isHost || s.phase!=="LOBBY") return;
    if(!Array.isArray(characters)) return socket.emit("errorMessage","Invalid character list.");
    if(characters.length > s.limits.maxCharacters){
      socket.emit("errorMessage",`Limit is ${s.limits.maxCharacters} characters — extra entries were dropped.`);
    }
    s.characters = withSavedImages(sanitizeCharacterList(characters, s.limits));
    emit(room);
  });

  socket.on("updateBackground",async (dataUrl:string)=>{
    if (!requireAuth(socket)) return;
    const room=socket.data.room; const s=rooms.get(room);
    const p=s?.players.find(x=>x.id===socket.id);
    if(!s || !p?.isHost) return;
    if(typeof dataUrl !== "string") return;
    if(dataUrl.length > 6_000_000) return socket.emit("errorMessage","Background image is too large — try a smaller file.");
    const norm = dataUrl ? normalizeImage(dataUrl) : undefined;
    if (dataUrl && !norm) return socket.emit("errorMessage","Unsupported file — use an image.");
    s.background = norm;
    roomBackgroundDefault = norm; // new rooms start with the last background you set
    emit(room);
    await flushMedia();
    if (norm) await storePut("room-background.txt", norm); else await storeDelete("room-background.txt");
  });

  // Owner-only: change one character's picture from the auction page itself, any
  // phase, any room. Uses the same global owner key as the site settings panel —
  // not the per-room host key — so only you can do this from your own device.
  // Whatever is set here stays on that character (in every room using it) until
  // you change it again; nothing else about the character is touched.
  socket.on("setCharacterImage",async (data:{key:string; characterId:string; image:string})=>{
    await persistReady;
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage","Incorrect owner key.");
    const room=socket.data.room; const s=rooms.get(room);
    if(!s) return socket.emit("errorMessage","You're not in a room.");
    if(typeof data.image !== "string") return;
    if(data.image.length > 6_000_000) return socket.emit("errorMessage","That image is too large — try a smaller one.");
    const char=s.characters.find(c=>c.id===data.characterId);
    if(!char) return socket.emit("errorMessage","Character not found.");
    const url = data.image ? normalizeImage(data.image) : undefined;
    if (data.image && !url) return socket.emit("errorMessage","Unsupported file — use an image.");
    char.image = url;
    emit(room);
    await saveCharImage(char.id, url); // permanent — used by every future room too
    sendLibraryToWatchers();
  });

  // --- Character library + host selection ---------------------------------------
  socket.on("getLibrary", async () => {
    if (!requireAuth(socket)) return;
    await persistReady;
    socket.data.wantsLibrary = true;
    socket.emit("library", libraryPayload());
  });

  // Host: choose exactly which characters go into THIS auction (ids, in order).
  // Characters already in the room keep any edits; others come from the library.
  socket.on("selectCharacters", (data: { ids: string[] }) => {
    if (!requireAuth(socket)) return;
    const room=socket.data.room; const s=rooms.get(room);
    const p=s?.players.find(x=>x.id===socket.id);
    if(!s || !p?.isHost || s.phase!=="LOBBY") return;
    if(!data || !Array.isArray(data.ids)) return;
    if(data.ids.length > s.limits.maxCharacters) socket.emit("errorMessage",`Limit is ${s.limits.maxCharacters} characters — extra picks were dropped.`);
    const lib = fullLibrary();
    const seen = new Set<string>();
    const picked: Character[] = [];
    for (const id of data.ids.map(String)) {
      if (seen.has(id)) continue; seen.add(id);
      const c = s.characters.find(x=>x.id===id) || lib.find(x=>x.id===id);
      if (c) picked.push(c);
    }
    s.characters = withSavedImages(sanitizeCharacterList(picked, s.limits));
    emit(room);
  });

  // Owner: save the current pick as the default for every future room, until changed.
  socket.on("saveDefaultSelection", async (data: { key: string; ids: string[] }) => {
    await persistReady;
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage","Incorrect owner key.");
    if (!storageReady(socket)) return;
    if (!Array.isArray(data.ids)) return;
    const valid = new Set(fullLibrary().map(c=>c.id));
    defaultSelection = Array.from(new Set(data.ids.map(String))).filter(id=>valid.has(id));
    await saveDefaultSelection();
    sendLibraryToWatchers();
  });

  // Owner: add / edit / delete characters in the permanent library.
  socket.on("libraryUpsert", async (data: { key: string; character: Partial<Character> }) => {
    await persistReady;
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage","Incorrect owner key.");
    if (!storageReady(socket)) return;
    const raw = data.character || {};
    if (!String(raw.name||"").trim()) return socket.emit("errorMessage","Give the character a name.");
    if (typeof raw.image === "string" && raw.image.length > 6_000_000) return socket.emit("errorMessage","That image is too large — try a smaller one.");
    const id = raw.id && customLibrary.some(c=>c.id===raw.id) ? String(raw.id) : `lib-${Date.now()}-${randomBytes(2).toString("hex")}`;
    const clean = clampCharacter({ ...raw, id }, LIB_LIMITS, id);
    const idx = customLibrary.findIndex(c=>c.id===id);
    if (idx >= 0) customLibrary[idx] = clean; else customLibrary.push(clean);
    if (raw.image !== undefined) await saveCharImage(id, clean.image);
    await saveLibrary();
    sendLibraryToWatchers();
    socket.emit("libraryAdded", { id });
  });
  socket.on("libraryDelete", async (data: { key: string; id: string }) => {
    await persistReady;
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage","Incorrect owner key.");
    if (!storageReady(socket)) return;
    const before = customLibrary.length;
    customLibrary = customLibrary.filter(c=>c.id!==data.id);
    if (customLibrary.length === before) return socket.emit("errorMessage","Only characters you added yourself can be deleted.");
    await saveCharImage(data.id, undefined);
    if (defaultSelection) { defaultSelection = defaultSelection.filter(id=>id!==data.id); await saveDefaultSelection(); }
    await saveLibrary();
    sendLibraryToWatchers();
  });

  // Host-only: reset a finished room back to the lobby, same players/teams/roster/
  // characters, so the same group can run another round without recreating a room.
  socket.on("resetRoom",()=>{
    if (!requireAuth(socket)) return;
    const room=socket.data.room; const s=rooms.get(room);
    const p=s?.players.find(x=>x.id===socket.id);
    if(!s || !p?.isHost) return socket.emit("errorMessage","Only the host can start a new round.");
    stopTimer(room);
    unsoldCountsByRoom.set(room, new Map());
    const orig = originalCharacters.get(room);
    if (orig && orig.length) s.characters = clone(orig); // bring back the whole list, not only the last re-auction round
    s.phase="LOBBY"; s.round=1; s.unsoldQueue=[]; s.finalUnsold=[]; s.history=[];
    s.currentIndex=0; s.currentBid=0; s.currentBidderTeamId=null; s.currentBidderPlayerId=null; s.currentBidderName=null;
    s.timer=s.timerMax;
    for(const t of s.teams){ t.spent=0; t.roster=[]; }
    emit(room);
  });

  socket.on("disconnect",()=>{
    const room=socket.data.room; const s=rooms.get(room); if(!s) return;
    const p=s.players.find(x=>x.id===socket.id); if(p) p.connected=false;
    emit(room);
  });
});

app.get("/health",(_,res)=>res.json({ok:true,rooms:rooms.size,store:REMOTE_STORE?"supabase":"local-disk",storageHealthy:persistHealthy}));
const PORT = Number(process.env.PORT) || 3001;
if (OWNER_EMAIL === "you@gmail.com") console.warn("[auth] AUCTION_OWNER_EMAIL is not set — set it on Render to your own Gmail or you will be locked out.");
// One bad event must never take the whole server (and every open room) down.
process.on("unhandledRejection", (e) => console.error("[server] unhandled rejection", e));
process.on("uncaughtException", (e) => console.error("[server] uncaught exception", e));
httpServer.listen(PORT,"0.0.0.0",()=>console.log(`Auction server: http://0.0.0.0:${PORT}`));
