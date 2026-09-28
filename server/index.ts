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
const MAX_ROUNDS = 5;
const MAX_SOLO_PLAYERS = 12;

// --------------------------------------------------------------------------------
// Site-wide (owner-only) landing page background + auction page sounds. Persists
// on disk across restarts until the owner changes it again — separate from any
// single room's background. Change OWNER_KEY here (or set the AUCTION_OWNER_KEY
// env var) to whatever only you know, so nobody else can overwrite these from
// their phone.
const OWNER_KEY = process.env.AUCTION_OWNER_KEY || "loki-owner-2026";
const SITE_MEDIA_FIELDS: SiteMediaField[] = ["background", "bgm", "soldSound", "queueSound", "trashSound", "heartbeatSound"];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SITE_CONFIG_PATH = path.join(__dirname, "site-config.json");
let siteConfig: SiteConfig = {};
try {
  if (fs.existsSync(SITE_CONFIG_PATH)) {
    const raw = JSON.parse(fs.readFileSync(SITE_CONFIG_PATH, "utf-8"));
    for (const field of SITE_MEDIA_FIELDS) siteConfig[field] = raw?.[field] || undefined;
  }
} catch { /* ignore corrupt/missing config */ }
function saveSiteConfig() {
  try { fs.writeFileSync(SITE_CONFIG_PATH, JSON.stringify(siteConfig)); }
  catch { /* non-fatal — settings just won't survive a restart */ }
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
const ALLOWED_EMAILS_PATH = path.join(__dirname, "allowed-emails.json");
let allowedEmails: string[] = [];
try {
  if (fs.existsSync(ALLOWED_EMAILS_PATH)) {
    allowedEmails = JSON.parse(fs.readFileSync(ALLOWED_EMAILS_PATH, "utf-8"));
  } else {
    allowedEmails = [OWNER_EMAIL];
  }
} catch { allowedEmails = [OWNER_EMAIL]; }
function saveAllowedEmails() {
  try { fs.writeFileSync(ALLOWED_EMAILS_PATH, JSON.stringify(allowedEmails)); }
  catch { /* non-fatal */ }
}
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
      s.history.push({ character, teamId: team.id, amount: s.currentBid });
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
      s.currentBidderTeamId = null;
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
  s.currentBidderTeamId = null;
  s.timer = s.timerMax;
  emit(room);
  startTimer(room);
}

io.on("connection", socket=>{
  // Push the current owner-set site background + sounds to every new connection —
  // this is independent of any room and applies to the landing page / auction page.
  socket.emit("siteConfig", siteConfig);

  socket.on("setSiteConfig", (data:{key:string; field:SiteMediaField; value:string})=>{
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage","Incorrect owner key.");
    if (!SITE_MEDIA_FIELDS.includes(data.field)) return;
    if (typeof data.value !== "string") return;
    if (data.value.length > 8_000_000) return socket.emit("errorMessage","That file is too large — try a smaller one.");
    siteConfig = { ...siteConfig, [data.field]: data.value || undefined };
    saveSiteConfig();
    io.emit("siteConfig", siteConfig); // broadcast to everyone, everywhere, live
  });

  // --- Google Sign-In -----------------------------------------------------------
  socket.on("googleSignIn", async (data: { idToken: string }) => {
    try {
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
  socket.on("listAllowedEmails", (data: { key: string }) => {
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage", "Incorrect owner key.");
    socket.emit("allowedEmailsList", allowedEmails);
  });
  socket.on("addAllowedEmail", (data: { key: string; email: string }) => {
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage", "Incorrect owner key.");
    const email = (data.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return socket.emit("errorMessage", "Enter a valid email address.");
    if (!allowedEmails.includes(email)) { allowedEmails.push(email); saveAllowedEmails(); }
    socket.emit("allowedEmailsList", allowedEmails);
  });
  socket.on("removeAllowedEmail", (data: { key: string; email: string }) => {
    if (!data || data.key !== OWNER_KEY) return socket.emit("errorMessage", "Incorrect owner key.");
    allowedEmails = allowedEmails.filter((e) => e !== (data.email || "").toLowerCase());
    saveAllowedEmails();
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
    const characters = sanitizeCharacterList(cfg.characters?.length?cfg.characters:demoCharacters, limits);
    const state:AuctionState={
      roomCode:code, title:cfg.title||"Character Auction", mode, phase:"LOBBY",
      players:[player], teams, characters, limits, background:undefined,
      round:1, unsoldQueue:[], finalUnsold:[],
      currentIndex:0, currentBid:0, currentBidderTeamId:null,
      bidIncrement:Math.max(1,cfg.bidIncrement||1000),
      timer:Math.max(5,cfg.timerMax||15), timerMax:Math.max(5,cfg.timerMax||15), history:[]
    };
    rooms.set(code,state); unsoldCountsByRoom.set(code, new Map()); socket.join(code); socket.data.room=code; emit(code);
  });

  socket.on("joinRoom",(data:{roomCode:string;name:string;teamId?:string})=>{
    const s=rooms.get(String(data.roomCode||"").toUpperCase());
    if (!requireAuth(socket)) return;
    if(!s) return socket.emit("errorMessage","Room not found.");
    if(s.phase!=="LOBBY") return socket.emit("errorMessage","This auction has already started.");

    let team:Team|undefined;
    if(s.mode === "SOLO"){
      if(s.teams.length >= MAX_SOLO_PLAYERS) return socket.emit("errorMessage","Room is full.");
      team = {
        id:`t${s.teams.length+1}`, name:data.name?.trim() || `Player ${s.teams.length+1}`,
        members:[], budget:s.teams[0]?.budget || 100000, spent:0, roster:[], color:colors[s.teams.length % colors.length]
      };
      s.teams.push(team);
    } else {
      team = s.teams.find(t=>t.id===data.teamId);
      if(!team) return socket.emit("errorMessage","Choose a valid team.");
      if(team.members.length>=5) return socket.emit("errorMessage","That team is full (max 5).");
    }
    const player:Player={id:socket.id,name:data.name?.trim()||`Player ${s.players.length+1}`,teamId:team.id,connected:true,isHost:false};
    s.players.push(player); team.members.push(socket.id);
    socket.join(s.roomCode); socket.data.room=s.roomCode; emit(s.roomCode);
  });

  socket.on("startAuction",()=>{
    if (!requireAuth(socket)) return;
    const room=socket.data.room; const s=rooms.get(room);
    const p=s?.players.find(x=>x.id===socket.id);
    if(!s || !p?.isHost) return socket.emit("errorMessage","Only the host can start.");
    if(s.phase!=="LOBBY") return;
    if(!s.characters.length) return socket.emit("errorMessage","Add at least one character before starting.");
    unsoldCountsByRoom.set(room, new Map());
    s.phase="BIDDING"; s.round=1; s.unsoldQueue=[]; s.finalUnsold=[];
    s.currentIndex=0; s.currentBid=s.characters[0].basePrice; s.currentBidderTeamId=null; s.timer=s.timerMax;
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
    s.currentBid=amount; s.currentBidderTeamId=team.id;
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
    s.characters = sanitizeCharacterList(characters, s.limits);
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
