import express from "express";
import http from "http";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { randomBytes } from "crypto";
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

async function storePut(name: string, value: string): Promise<void> {
  const key = safeName(name);
  try {
    if (REMOTE_STORE) {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${key}`, {
        method: "POST", headers: sbHeaders({ "x-upsert": "true", "Content-Type": "text/plain" }), body: value,
      });
      if (!r.ok) console.error(`[store] save ${key} failed: ${r.status} ${await r.text().catch(() => "")}`);
    } else {
      fs.mkdirSync(LOCAL_DIR, { recursive: true });
      fs.writeFileSync(path.join(LOCAL_DIR, key), value);
    }
  } catch (e) { console.error(`[store] save ${key} error`, e); }
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

let siteConfig: SiteConfig = {};
// Owner-set picture per character id (kept until the owner changes it again), and the
// host-set default room background for new rooms.
let charImages: Record<string, string> = {};
let roomBackgroundDefault: string | undefined;
function saveSiteConfigField(field: SiteMediaField) {
  const v = siteConfig[field];
  return v ? storePut(`site-${field}.txt`, v) : storeDelete(`site-${field}.txt`);
}
async function saveCharImage(id: string, image: string | undefined) {
  if (image) charImages[id] = image; else delete charImages[id];
  if (image) await storePut(`charimg-${id}.txt`, image); else await storeDelete(`charimg-${id}.txt`);
  await storePut("charimg-index.json", JSON.stringify(Object.keys(charImages)));
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
function saveLibrary() {
  const slim = customLibrary.map((c) => ({ ...c, image: undefined }));
  return storePut("char-library.json", JSON.stringify(slim));
}
function saveDefaultSelection() {
  return defaultSelection ? storePut("char-selection.json", JSON.stringify(defaultSelection)) : storeDelete("char-selection.json");
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
function saveAllowedEmails() { return storePut("allowed-emails.json", JSON.stringify(allowedEmails)); }

// Load everything saved earlier. Runs at start-up; sign-in and owner actions wait for it.
async function loadPersisted() {
  await ensureBucket();
  const fields: SiteMediaField[] = SITE_MEDIA_FIELDS;
  await Promise.all(fields.map(async (f) => { const v = await storeGet(`site-${f}.txt`); if (v) siteConfig[f] = v; }));
  try {
    const raw = await storeGet("allowed-emails.json");
    const stored: string[] = raw ? JSON.parse(raw) : [];
    allowedEmails = Array.from(new Set([OWNER_EMAIL, ...SEED_EMAILS, ...stored.map((e) => String(e).toLowerCase())]));
  } catch { allowedEmails = Array.from(new Set([OWNER_EMAIL, ...SEED_EMAILS])); }
  try {
    const idx = await storeGet("charimg-index.json");
    const ids: string[] = idx ? JSON.parse(idx) : [];
    await Promise.all(ids.map(async (id) => { const v = await storeGet(`charimg-${id}.txt`); if (v) charImages[id] = v; }));
  } catch { /* ignore */ }
  try {
    const rawLib = await storeGet("char-library.json");
    const parsed: Partial<Character>[] = rawLib ? JSON.parse(rawLib) : [];
    customLibrary = parsed.map((c, i) => clampCharacter(c, LIB_LIMITS, `lib-${i}`));
  } catch { customLibrary = []; }
  try {
    const rawSel = await storeGet("char-selection.json");
    const ids = rawSel ? JSON.parse(rawSel) : null;
    defaultSelection = Array.isArray(ids) ? ids.map(String) : null;
  } catch { defaultSelection = null; }
  roomBackgroundDefault = (await storeGet("room-background.txt")) || undefined;
  console.log(`[store] ${REMOTE_STORE ? "Supabase" : "LOCAL DISK (not permanent on Render!)"} — loaded ${Object.keys(siteConfig).length} site files, ${allowedEmails.length} approved accounts, ${Object.keys(charImages).length} character images, ${customLibrary.length} library characters`);
}
const persistReady: Promise<void> = loadPersisted().catch((e) => console.error("[store] load failed", e));
persistReady.then(() => { io.emit("siteConfig", siteConfig); });
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
function emit(room:string){ const s=rooms.get(room); if(s) io.to(room).emit("state",clone(s)); }
function stopTimer(room:string){ const t=timers.get(room); if(t){ clearInterval(t); timers.delete(room); } }

function sanitizeLimits(raw:Partial<CharacterLimits> | undefined): CharacterLimits {
  const maxCharacters = Math.min(200, Math.max(2, Math.floor(Number(raw?.maxCharacters) || defaultLimits.maxCharacters)));
  const minValue = Math.max(0, Math.floor(Number(raw?.minValue) ?? defaultLimits.minValue));
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
    image: c.image,
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
    siteConfig = { ...siteConfig, [data.field]: data.value || undefined };
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
      socket.data.authedEmail = email;
      socket.emit("authResult", { ok: true, email, name: payload.name, picture: payload.picture });
    } catch {
      socket.emit("authResult", { ok: false, reason: "invalid_token" });
    }
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
    const email = (data.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return socket.emit("errorMessage", "Enter a valid email address.");
    if (!allowedEmails.includes(email)) { allowedEmails.push(email); await saveAllowedEmails(); }
    socket.emit("allowedEmailsList", allowedEmails);
  });
  socket.on("removeAllowedEmail", async (data: { key: string; email: string }) => {
    await persistReady;
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage", "Incorrect owner key.");
    allowedEmails = allowedEmails.filter((e) => e !== (data.email || "").toLowerCase());
    await saveAllowedEmails();
    socket.emit("allowedEmailsList", allowedEmails);
  });

  socket.on("createRoom",(cfg:{
    name:string; title:string; mode?:GameMode; teamNames:string[]; budget:number;
    bidIncrement:number; timerMax:number; characters:Character[]; limits?:Partial<CharacterLimits>;
  })=>{
    if (!requireAuth(socket)) return;
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
    const s=rooms.get(String(data.roomCode||"").toUpperCase());
    if (!requireAuth(socket)) return;
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

  socket.on("updateBackground",(dataUrl:string)=>{
    if (!requireAuth(socket)) return;
    const room=socket.data.room; const s=rooms.get(room);
    const p=s?.players.find(x=>x.id===socket.id);
    if(!s || !p?.isHost) return;
    if(typeof dataUrl !== "string") return;
    if(dataUrl.length > 6_000_000) return socket.emit("errorMessage","Background image is too large — try a smaller file.");
    s.background = dataUrl || undefined;
    roomBackgroundDefault = s.background; // new rooms start with the last background you set
    if (s.background) void storePut("room-background.txt", s.background); else void storeDelete("room-background.txt");
    emit(room);
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
    char.image = data.image || undefined;
    emit(room);
    await saveCharImage(char.id, char.image); // permanent — used by every future room too
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
    const raw = data.character || {};
    if (!String(raw.name||"").trim()) return socket.emit("errorMessage","Give the character a name.");
    if (typeof raw.image === "string" && raw.image.length > 6_000_000) return socket.emit("errorMessage","That image is too large — try a smaller one.");
    const id = raw.id && customLibrary.some(c=>c.id===raw.id) ? String(raw.id) : `lib-${Date.now()}-${randomBytes(2).toString("hex")}`;
    const clean = clampCharacter({ ...raw, id }, LIB_LIMITS, id);
    const idx = customLibrary.findIndex(c=>c.id===id);
    if (idx >= 0) customLibrary[idx] = clean; else customLibrary.push(clean);
    if (raw.image !== undefined) await saveCharImage(id, raw.image || undefined);
    await saveLibrary();
    sendLibraryToWatchers();
    socket.emit("libraryAdded", { id });
  });
  socket.on("libraryDelete", async (data: { key: string; id: string }) => {
    await persistReady;
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage","Incorrect owner key.");
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

app.get("/health",(_,res)=>res.json({ok:true,rooms:rooms.size}));
httpServer.listen(3001,"0.0.0.0",()=>console.log("Auction server: http://0.0.0.0:3001"));
