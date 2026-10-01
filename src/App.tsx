import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { io, Socket } from "socket.io-client";
import {
  Gavel, Plus, Users, Upload, Play, Shuffle, ImagePlus, Trophy,
  Pencil, Trash2, Sparkles, SlidersHorizontal, X, Check, ShieldAlert,
  User, Image, CheckCircle2, XCircle, Layers, Settings, Volume2, VolumeX,
  RotateCcw, LogOut, Video, Library,
} from "lucide-react";
import { AuctionState, Character, CharacterLimits, GameMode, Player, SiteConfig } from "./types";
import { demoCharacters, defaultLimits } from "./data";

// Locally (or over LAN) this guesses the backend at the same host on port 3001,
// exactly as before. Once frontend and backend live on different domains (e.g.
// frontend on Netlify, backend on Render), set VITE_SERVER_URL at build time to
// the backend's full URL and this uses that instead.
const SERVER = import.meta.env.VITE_SERVER_URL || `${window.location.protocol}//${window.location.hostname}:3001`;
// Paste the OAuth Client ID from your own Google Cloud project here (Credentials >
// OAuth client ID > Web application) — must be the same value the server's
// AUCTION_GOOGLE_CLIENT_ID uses. This ID is public/safe to have in frontend code.
const GOOGLE_CLIENT_ID = "787395401483-p8ltdpr8kqsvgbq0u9bm10df3b4ofg4l.apps.googleusercontent.com";
const money = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

const RARITIES = ["Common", "Rare", "Epic", "Legendary", "Custom"];

// ------------------------------------------------------------------------------
// Browser-side persistence helpers (all wrapped: private mode / blocked storage must
// never crash the app).
const SESSION_KEY = "auction.session.v1";     // long-lived login token, cleared only on Logout
const PROFILE_PREFIX = "auction.profile.v1."; // per-account settings cache (server copy is authoritative)
const lsGet = (k: string): string | null => { try { return window.localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { window.localStorage.setItem(k, v); } catch { /* ignore */ } };
const lsDel = (k: string) => { try { window.localStorage.removeItem(k); } catch { /* ignore */ } };

// ------------------------------------------------------------------------------
// Media. The server stores every upload once and only ever sends short "/media/<hash>"
// links; here they become full URLs. Character pictures you drop into
// src/assets/characters/ (named c1.png, c2.jpg … or iron-man.png — the character id or the
// name in lowercase-with-dashes) are bundled into the site at build time, so they ship
// with the website itself and can never disappear. An owner-uploaded picture always
// wins over a bundled one.
const bundledFiles = import.meta.glob("./assets/characters/*.{png,jpg,jpeg,webp,gif,svg,avif}", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const bundledByKey: Record<string, string> = {};
for (const [file, url] of Object.entries(bundledFiles)) {
  bundledByKey[(file.split("/").pop() || "").replace(/\.[^.]+$/, "").toLowerCase()] = url;
}
const bundledUrls = new Set(Object.values(bundledByKey));
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const mediaUrl = (u?: string): string | undefined => (u && u.startsWith("/media/") ? SERVER + u : u);
function resolveChar(c: Character): Character {
  const image = mediaUrl(c.image) || bundledByKey[String(c.id).toLowerCase()] || bundledByKey[slug(c.name)];
  return image === c.image ? c : { ...c, image };
}
function resolveState(s: AuctionState): AuctionState {
  return {
    ...s,
    background: mediaUrl(s.background),
    characters: s.characters.map(resolveChar),
    unsoldQueue: s.unsoldQueue.map(resolveChar),
    finalUnsold: s.finalUnsold.map(resolveChar),
    teams: s.teams.map((t) => ({ ...t, roster: t.roster.map(resolveChar) })),
    history: s.history.map((h) => ({ ...h, character: resolveChar(h.character) })),
  };
}
function resolveSite(cfg: SiteConfig): SiteConfig {
  const out: SiteConfig = {};
  for (const [k, v] of Object.entries(cfg || {})) (out as Record<string, string | undefined>)[k] = mediaUrl(v as string | undefined);
  return out;
}
// Bundled pictures are added on this side only — never send them back to the server.
const cleanImg = (img?: string) => (img && !bundledUrls.has(img) ? img : undefined);
const outChars = (list: Character[]) => list.map((c) => ({ ...c, image: cleanImg(c.image) }));

type CharacterDraft = {
  name: string;
  universe: string;
  abilityNote: string;
  power: number;
  basePrice: number;
  rarity: string;
  image?: string;
};

function blankDraft(limits: CharacterLimits): CharacterDraft {
  return {
    name: "",
    universe: "",
    abilityNote: "",
    power: Math.round(limits.maxPower * 0.7),
    basePrice: limits.minValue,
    rarity: "Epic",
    image: undefined,
  };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ------------------------------------------------------------------------------
// Small synthesized sound effects (Web Audio API — no external audio files, so
// there's nothing to download and nothing to worry about licensing-wise). Every
// sound here is just oscillators + gain envelopes.
type AmbientNodes = { osc1: OscillatorNode; osc2: OscillatorNode; lfo: OscillatorNode; gain: GainNode };

function startAmbientNodes(ctx: AudioContext, targetGain: number): AmbientNodes {
  const gain = ctx.createGain();
  gain.gain.value = 0.0001;
  gain.connect(ctx.destination);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 300;
  filter.connect(gain);
  const osc1 = ctx.createOscillator(); osc1.type = "sine"; osc1.frequency.value = 55;
  const osc2 = ctx.createOscillator(); osc2.type = "sine"; osc2.frequency.value = 82.5;
  osc1.connect(filter); osc2.connect(filter);
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.15;
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.015;
  lfo.connect(lfoGain); lfoGain.connect(gain.gain);
  osc1.start(); osc2.start(); lfo.start();
  gain.gain.linearRampToValueAtTime(targetGain, ctx.currentTime + 1.5);
  return { osc1, osc2, lfo, gain };
}

function stopAmbientNodes(ctx: AudioContext, nodes: AmbientNodes) {
  nodes.gain.gain.cancelScheduledValues(ctx.currentTime);
  nodes.gain.gain.setValueAtTime(nodes.gain.gain.value, ctx.currentTime);
  nodes.gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.7);
  setTimeout(() => {
    try { nodes.osc1.stop(); nodes.osc2.stop(); nodes.lfo.stop(); } catch { /* already stopped */ }
  }, 800);
}

function playHeartbeatThump(ctx: AudioContext) {
  const now = ctx.currentTime;
  const beat = (delay: number, freq: number, dur: number, vol: number) => {
    const osc = ctx.createOscillator(); osc.type = "sine"; osc.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = 0;
    osc.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0, now + delay);
    g.gain.linearRampToValueAtTime(vol, now + delay + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + delay + dur);
    osc.start(now + delay);
    osc.stop(now + delay + dur + 0.05);
  };
  beat(0, 62, 0.16, 0.32);     // "lub"
  beat(0.18, 50, 0.18, 0.26);  // "dub"
}

function playHammerBang(ctx: AudioContext) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator(); osc.type = "triangle";
  osc.frequency.setValueAtTime(180, now);
  osc.frequency.exponentialRampToValueAtTime(60, now + 0.15);
  const g = ctx.createGain(); g.gain.value = 0;
  osc.connect(g); g.connect(ctx.destination);
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.35, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
  osc.start(now); osc.stop(now + 0.4);
}

function playQueueWhoosh(ctx: AudioContext) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator(); osc.type = "sine";
  osc.frequency.setValueAtTime(300, now);
  osc.frequency.exponentialRampToValueAtTime(700, now + 0.25);
  const g = ctx.createGain(); g.gain.value = 0;
  osc.connect(g); g.connect(ctx.destination);
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.18, now + 0.05);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
  osc.start(now); osc.stop(now + 0.35);
}

function playTrashClank(ctx: AudioContext) {
  const now = ctx.currentTime;
  const beat = (delay: number, freq: number) => {
    const osc = ctx.createOscillator(); osc.type = "square"; osc.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = 0;
    osc.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0, now + delay);
    g.gain.linearRampToValueAtTime(0.15, now + delay + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.12);
    osc.start(now + delay); osc.stop(now + delay + 0.15);
  };
  beat(0, 220);
  beat(0.1, 140);
}

// Plays an owner-uploaded audio file once. A fresh Audio() per call avoids any
// restart glitches if the same effect fires again before the last one finished.
function playCustomOneShot(url: string, volume: number) {
  try {
    const a = new Audio(url);
    a.volume = volume;
    a.play().catch(() => { /* ignored — e.g. blocked before first user gesture */ });
  } catch { /* ignore malformed audio */ }
}

// Final-reveal card: the picture fills the whole card (full-bleed), and the details sit on a
// gradient at the bottom. `index` staggers the entrance so the cards reveal one after another.
// The animation starts when the card scrolls into view (not when the page loads). On a phone only
// ~2 cards fit on screen, so cards further down used to finish animating before anyone saw them.
function RevealCard({ c, price, index, team, color }: { c: Character; price: number; index: number; team?: string; color?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;
    if (typeof IntersectionObserver === "undefined") { setShown(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setShown(true); io.disconnect(); }
    }, { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);
  return (
    <div ref={ref} className={shown ? "reveal-card is-in" : "reveal-card"} style={{ "--d": `${(index % 4) * 0.12}s`, "--tc": color || "var(--red-2)" } as CSSProperties}>
      <div className="reveal-media">
        {c.image ? <img src={c.image} alt={c.name} /> : <div className="reveal-initial">{c.name[0]}</div>}
      </div>
      <div className="reveal-shine" />
      <div className="reveal-info">
        <span className="reveal-universe">{c.universe} • {c.rarity}</span>
        <span className="reveal-name">{c.name}</span>
        {team && <span className="reveal-team"><i />Won by {team}</span>}
        {c.abilityNote && <span className="reveal-note">{c.abilityNote}</span>}
        <div className="reveal-stats">
          <span><span className="rs-label">Power</span><span className="rs-val">{c.power}</span></span>
          <span><span className="rs-label">Base</span><span className="rs-val">{money(c.basePrice)}</span></span>
          <span className="rs-sold"><span className="rs-label">Sold</span><span className="rs-val">{money(price)}</span></span>
        </div>
      </div>
    </div>
  );
}

// Small round character icon used to show what a player has bought.
function MiniIcon({ c, size = 26 }: { c: Character; size?: number }) {
  return (
    <span className="mini-icon" style={{ width: size, height: size }} title={c.name}>
      {c.image ? <img src={c.image} alt={c.name} /> : <span>{c.name[0]}</span>}
    </span>
  );
}

// Host-only lobby editor: change teams, players, mode and round settings. Every button sends a
// small event to the server, which updates the room and broadcasts it to all clients at once, so
// the lobby always shows the server's real data (nothing is kept only on the host's screen).
function RoomEditor({ state, socket }: { state: AuctionState; socket: Socket | null }) {
  const serverBudget = state.teams[0]?.budget ?? 100000;
  const [title, setTitle] = useState(state.title);
  const [budget, setBudget] = useState(serverBudget);
  const [inc, setInc] = useState(state.bidIncrement);
  const [timer, setTimer] = useState(state.timerMax);
  useEffect(() => { setTitle(state.title); setBudget(serverBudget); setInc(state.bidIncrement); setTimer(state.timerMax); },
    [state.roomCode, state.title, serverBudget, state.bidIncrement, state.timerMax]);
  const send = (ev: string, data?: unknown) => socket?.emit(ev, data);
  const isTeam = state.mode === "TEAM";
  const dirty = title !== state.title || budget !== serverBudget || inc !== state.bidIncrement || timer !== state.timerMax;
  const playerOf = (id: string) => state.players.find((p) => p.id === id);

  function switchMode(m: GameMode) {
    if (m === state.mode) return;
    if (state.players.length > 1 && !window.confirm(`Switch to ${m} mode? Players will be re-arranged ${m === "SOLO" ? "into their own wallets" : "into teams"}.`)) return;
    send("updateSettings", { mode: m });
  }
  const nameInput = (initial: string, onSave: (v: string) => void) => (
    <input className="ed-input" key={initial} defaultValue={initial} maxLength={30}
      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== initial) onSave(v); else e.target.value = initial; }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
  const playerRow = (pl: Player, teamOptions?: boolean, currentTeam?: string) => (
    <div className="ed-player" key={pl.id}>
      {nameInput(pl.name, (v) => send("renamePlayer", { playerId: pl.id, name: v }))}
      {pl.isHost && <span className="ed-tag">HOST</span>}
      {!pl.connected && <span className="ed-tag off">offline</span>}
      {teamOptions && (
        <select value={currentTeam} onChange={(e) => send("movePlayer", { playerId: pl.id, teamId: e.target.value })}>
          {state.teams.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.members.length}/5)</option>)}
        </select>
      )}
      {!pl.isHost && <button className="icon danger" title="Remove player" onClick={() => send("removePlayer", { playerId: pl.id })}><Trash2 size={15} /></button>}
    </div>
  );

  return (
    <div className="room-editor">
      <small>ROOM SETUP — EDITABLE</small>
      <p className="muted small">Change anything here before starting. New players can still join with the room code.</p>

      <label>Auction title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <div className="mode-toggle row">
        <button type="button" className={isTeam ? "mode-btn active" : "mode-btn"} onClick={() => switchMode("TEAM")}><Users size={15} /> Team</button>
        <button type="button" className={!isTeam ? "mode-btn active" : "mode-btn"} onClick={() => switchMode("SOLO")}><User size={15} /> Solo</button>
      </div>
      <div className="two">
        <label>Budget<input type="number" value={budget} onChange={(e) => setBudget(+e.target.value)} /></label>
        <label>Bid increment<input type="number" value={inc} onChange={(e) => setInc(+e.target.value)} /></label>
      </div>
      <label>Timer per character (seconds)
        <select value={timer} onChange={(e) => setTimer(+e.target.value)}>
          {[10, 15, 20, 30, 45, 60].map((n) => <option key={n}>{n}</option>)}
        </select>
      </label>
      <button className="secondary full" disabled={!dirty} onClick={() => send("updateSettings", { title, budget, bidIncrement: inc, timerMax: timer })}>
        <Check size={16} /> SAVE SETTINGS
      </button>

      <div className="ed-head">
        <b>{isTeam ? `Teams (${state.teams.length}/12)` : `Players (${state.players.length}/12)`}</b>
        {isTeam && <button className="primary" disabled={state.teams.length >= 12} onClick={() => send("addTeam", {})}><Plus size={15} /> ADD TEAM</button>}
      </div>

      {isTeam ? (
        <div className="teams">
          {state.teams.map((t) => (
            <div className="team ed-team" key={t.id} style={{ borderLeft: `3px solid ${t.color}` }}>
              <div className="ed-team-head">
                {nameInput(t.name, (v) => send("renameTeam", { teamId: t.id, name: v }))}
                <small>{t.members.length}/5</small>
                <button className="icon danger" title="Remove team" disabled={state.teams.length <= 2} onClick={() => send("removeTeam", { teamId: t.id })}><Trash2 size={15} /></button>
              </div>
              {t.members.length === 0 && <span className="muted small">No players yet — they can join with the code, or move someone here.</span>}
              {t.members.map((id) => { const pl = playerOf(id); return pl ? playerRow(pl, true, t.id) : null; })}
              <small>{money(t.budget - t.spent)} left</small>
            </div>
          ))}
        </div>
      ) : (
        <div className="teams">
          {state.players.map((pl) => <div className="team ed-team" key={pl.id}>{playerRow(pl)}</div>)}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [screen, setScreen] = useState<"home" | "lobby" | "auction" | "results">("home");
  const [state, setState] = useState<AuctionState | null>(null);
  const [myId, setMyId] = useState("");
  const [room, setRoom] = useState("");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("Ultimate Character Auction");
  const [budget, setBudget] = useState(100000);
  const [increment, setIncrement] = useState(1000);
  const [timer, setTimer] = useState(20);
  const [teamCount, setTeamCount] = useState(2);
  const [teamNames, setTeamNames] = useState(["Avengers", "Justice League"]);
  const [selectedTeam, setSelectedTeam] = useState("t1");
  const [mode, setMode] = useState<GameMode>("TEAM");
  const [toast, setToast] = useState("");

  const [limitsDraft, setLimitsDraft] = useState<CharacterLimits>(defaultLimits);
  const [charDraft, setCharDraft] = useState<CharacterDraft>(blankDraft(defaultLimits));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<CharacterDraft | null>(null);
  const [managerTab, setManagerTab] = useState<"pick" | "add" | "limits" | "theme" | "list">("pick");
  // Character library (built-in + owner-added, permanent) and the host's ticked picks.
  const [library, setLibrary] = useState<Character[]>([]);
  const [defaultSel, setDefaultSel] = useState<string[] | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [libEditId, setLibEditId] = useState<string | null>(null);

  // Owner-only site background + auction sounds — separate from any single
  // room's background, persists on the server until the owner changes it again.
  const [siteConfig, setSiteConfigState] = useState<SiteConfig>({});
  const [showSiteSettings, setShowSiteSettings] = useState(false);
  const [isOwner, setIsOwner] = useState(false); // set by the server after Google sign-in: true only for the owner account
  const [allowedEmailsList, setAllowedEmailsListState] = useState<string[]>([]);
  const [newEmailInput, setNewEmailInput] = useState("");

  // Google Sign-In gate — nothing else in the app renders until this is true.
  // "restoring" = a saved login exists and we are checking it — show a loading screen, never the login page.
  const [authStatus, setAuthStatus] = useState<"restoring" | "out" | "in">(() => (lsGet(SESSION_KEY) ? "restoring" : "out"));
  const authed = authStatus === "in";
  const [slowRestore, setSlowRestore] = useState(false);
  const profileLoaded = useRef(false);
  const exitedRef = useRef(false); // true after Exit Game, so a late "state" event can't drag you back into the room
  const [authEmail, setAuthEmail] = useState("");
  const [authName, setAuthName] = useState("");
  const [authError, setAuthError] = useState("");
  const googleBtnRef = useRef<HTMLDivElement | null>(null);

  // Interactive auction feedback: hammer-slam on sale, queued/trashed on unsold.
  const [fx, setFx] = useState<{ type: "sold" | "queued" | "trashed"; character: Character } | null>(null);
  const prevHistoryLen = useRef(0);
  const prevQueueLen = useRef(0);
  const prevTrashLen = useRef(0);

  // Sound: ambient auction hum while bidding, heartbeat thump in the last 5 seconds.
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ambientRef = useRef<AmbientNodes | null>(null);
  const bgmElRef = useRef<HTMLAudioElement | null>(null);
  const lastHeartbeatSecond = useRef<number | null>(null);

  function ensureAudioCtx(): AudioContext {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  }

  const me = useMemo(() => state?.players.find((p) => p.id === myId), [state, myId]);
  const myTeam = useMemo(() => state?.teams.find((t) => t.id === me?.teamId), [state, me]);
  const current = state?.characters[state.currentIndex];
  const limits = state?.limits || limitsDraft;
  const bgStyle: CSSProperties | undefined = state?.background
    ? {
        backgroundImage: `linear-gradient(rgba(7,7,10,.82), rgba(7,7,10,.92)), url(${state.background})`,
        backgroundSize: "cover", backgroundPosition: "center", backgroundAttachment: "fixed",
      }
    : undefined;
  const homeBgStyle: CSSProperties | undefined = siteConfig.background
    ? {
        backgroundImage: `linear-gradient(rgba(7,7,10,.85), rgba(7,7,10,.94)), url(${siteConfig.background})`,
        backgroundSize: "cover", backgroundPosition: "center", backgroundAttachment: "fixed",
      }
    : undefined;
  // Owner-uploaded "live wallpaper" — a looping muted video behind the landing
  // page and the auction page, in place of (or under) the static background.
  const liveWallpaper = siteConfig.backgroundVideo ? (
    <div className="live-wallpaper" aria-hidden="true">
      <video src={siteConfig.backgroundVideo} autoPlay loop muted playsInline />
      <div className="live-wallpaper-overlay" />
    </div>
  ) : null;

  // Browser Back button: step back to the previous screen instead of leaving the site.
  const screenRef = useRef(screen);
  useEffect(() => {
    screenRef.current = screen;
    if (screen !== "home" && window.history.state?.screen !== screen) {
      window.history.pushState({ screen }, "");
    }
  }, [screen]);
  useEffect(() => {
    window.history.replaceState({ screen: "home" }, "");
    const onPop = () => {
      const cur = screenRef.current;
      if (cur === "auction" && !window.confirm("Leave the auction screen? You stay in the room and can return from the home page.")) {
        window.history.pushState({ screen: "auction" }, "");
        return;
      }
      setScreen("home");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // A picture/video that fails to load (free server still waking up, network blip) is retried a
  // few times instead of staying broken until the page is reloaded.
  useEffect(() => {
    const onErr = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLImageElement || el instanceof HTMLVideoElement)) return;
      const src = el.getAttribute("src") || "";
      if (!src.includes("/media/")) return;
      const n = Number(el.dataset.retry || 0);
      if (n >= 5) return;
      el.dataset.retry = String(n + 1);
      const base = src.replace(/[?&]r=\d+$/, "");
      setTimeout(() => el.setAttribute("src", base + (base.includes("?") ? "&" : "?") + "r=" + (n + 1)), 1500 * (n + 1));
    };
    window.addEventListener("error", onErr, true);
    return () => window.removeEventListener("error", onErr, true);
  }, []);

  useEffect(() => {
    const s = io(SERVER, { transports: ["websocket", "polling"] });
    s.on("connect", () => {
      setMyId(s.id || "");
      // Every (re)connect — page load, wifi blip, free server waking up — quietly resumes the
      // saved login. That also re-seats us in the room we were in.
      const tok = lsGet(SESSION_KEY);
      if (tok) s.emit("resumeSession", { token: tok });
    });
    const applyProfile = (p: any) => {
      if (!p || typeof p !== "object") return;
      if (typeof p.name === "string") setName(p.name);
      if (typeof p.title === "string" && p.title) setTitle(p.title);
      if (typeof p.budget === "number") setBudget(p.budget);
      if (typeof p.increment === "number") setIncrement(p.increment);
      if (typeof p.timer === "number") setTimer(p.timer);
      if (typeof p.teamCount === "number") setTeamCount(p.teamCount);
      if (Array.isArray(p.teamNames) && p.teamNames.length) setTeamNames(p.teamNames.map(String));
      if (p.mode === "SOLO" || p.mode === "TEAM") setMode(p.mode);
      if (p.limits && typeof p.limits === "object") setLimitsDraft((prev) => ({ ...prev, ...p.limits }));
    };
    s.on("profile", (p: any) => { applyProfile(p); profileLoaded.current = true; });
    s.on("removedFromRoom", () => {
      exitedRef.current = true;
      setState(null); setRoom(""); setScreen("home");
      setToast("The host removed you from the room."); setTimeout(() => setToast(""), 2800);
    });
    s.on("resumedRoom", (d: { roomCode: string; phase: AuctionState["phase"] }) => {
      exitedRef.current = false;
      setRoom(d.roomCode);
      setScreen(d.phase === "BIDDING" ? "auction" : d.phase === "COMPLETE" ? "results" : "lobby");
    });
    s.on("loggedOut", () => { /* local cleanup already done by logout() */ });
    s.on("state", (raw: AuctionState) => {
      if (exitedRef.current) return;
      const x = resolveState(raw);
      setState(x);
      // Only move screens if the player is inside a room screen; if they chose to go
      // Home (Back button), don't yank them back on every timer tick.
      if (x.phase === "BIDDING") setScreen((prev) => (prev === "home" ? prev : "auction"));
      if (x.phase === "COMPLETE") setScreen((prev) => (prev === "home" ? prev : "results"));
      // "Play Again" resets the room to LOBBY — bounce everyone still on the
      // results screen back into the lobby to start the next round.
      if (x.phase === "LOBBY") setScreen((prev) => (prev === "results" ? "lobby" : prev));
    });
    s.on("siteConfig", (cfg: SiteConfig) => setSiteConfigState(resolveSite(cfg)));
    s.on("library", (d: { characters: Character[]; selection: string[] | null }) => { setLibrary((d.characters || []).map(resolveChar)); setDefaultSel(d.selection || null); });
    s.on("authResult", (r: { ok: boolean; email?: string; name?: string; reason?: string; sessionToken?: string; isOwner?: boolean }) => {
      if (r.ok) {
        if (r.sessionToken) lsSet(SESSION_KEY, r.sessionToken); // first Google sign-in on this device: remember it
        setAuthEmail(r.email || ""); setAuthName(r.name || ""); setAuthError(""); setIsOwner(!!r.isOwner);
        const cached = r.email ? lsGet(PROFILE_PREFIX + r.email) : null; // instant, before the server copy arrives
        if (cached) { try { applyProfile(JSON.parse(cached)); } catch { /* ignore */ } }
        setAuthStatus("in");
        s.emit("getLibrary"); // pull the saved character library (with images) from the server on every login / app start
      } else if (r.reason === "server_error") {
        // Server/storage not ready yet — keep the saved login and try again shortly.
        setTimeout(() => { const t = lsGet(SESSION_KEY); if (t) s.emit("resumeSession", { token: t }); }, 4000);
      } else {
        setIsOwner(false);
        if (r.reason === "session_expired" || r.reason === "not_allowed") lsDel(SESSION_KEY);
        setAuthStatus("out");
        setAuthError(
          r.reason === "not_allowed"
            ? `${r.email || "This Google account"} isn't approved yet. Ask the host to add it.`
            : r.reason === "session_expired" ? ""
            : "Sign-in failed — please try again."
        );
      }
    });
    s.on("allowedEmailsList", (list: string[]) => setAllowedEmailsListState(list));
    s.on("errorMessage", (m: string) => {
      setToast(m);
      setTimeout(() => setToast(""), 2800);
    });
    setSocket(s);
    return () => { s.disconnect(); };
  }, []);

  // Render Google's own Sign-In button once its script has loaded and the
  // sign-in gate is showing. Polls briefly since the script tag is async.
  useEffect(() => {
    if (authStatus !== "out") return;
    let cancelled = false;
    let tries = 0;
    const tryInit = () => {
      if (cancelled) return;
      const g = (window as any).google;
      if (g?.accounts?.id && googleBtnRef.current) {
        g.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (resp: { credential: string }) => { (window as any).__auctionGoogleCred = resp.credential; socket?.emit("googleSignIn", { idToken: resp.credential }); },
        });
        googleBtnRef.current.innerHTML = "";
        g.accounts.id.renderButton(googleBtnRef.current, { theme: "filled_black", size: "large", shape: "pill", text: "signin_with" });
      } else if (tries < 30) {
        tries++;
        setTimeout(tryInit, 250);
      }
    };
    tryInit();
    return () => { cancelled = true; };
  }, [authStatus, socket]);

  // Browsers won't play audio until a user gesture — this "unlocks" it on the
  // very first tap/click/keypress anywhere in the app (typing a name, hitting
  // Join, etc. in the lobby already covers this before the auction starts).
  useEffect(() => {
    const unlock = () => { ensureAudioCtx().resume(); };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => { mutedRef.current = muted; }, [muted]);

  // While a saved login is being restored, say so if the (free) server is slow to wake up.
  useEffect(() => {
    if (authStatus !== "restoring") { setSlowRestore(false); return; }
    const t = setTimeout(() => setSlowRestore(true), 8000);
    return () => clearTimeout(t);
  }, [authStatus]);

  // Save this account's settings (name, room settings, limits) — on the server (follows the
  // Google account) and in this browser as an instant cache.
  useEffect(() => {
    if (!authed || !socket || !profileLoaded.current) return;
    const settings = { name, title, budget, increment, timer, teamCount, teamNames, mode, limits: limitsDraft };
    lsSet(PROFILE_PREFIX + authEmail, JSON.stringify(settings));
    const t = setTimeout(() => socket.emit("saveProfile", { settings }), 800);
    return () => clearTimeout(t);
  }, [authed, socket, authEmail, name, title, budget, increment, timer, teamCount, teamNames, mode, limitsDraft]);

  // Host in the lobby: load the character library so they can tick which characters play.
  useEffect(() => {
    if (socket && authed && screen === "lobby" && me?.isHost) socket.emit("getLibrary");
  }, [socket, authed, screen, me?.isHost]);

  // Keep the ticked list in step with what is actually in the room.
  const roomCharIds = state?.characters.map((c) => c.id).join("|") || "";
  useEffect(() => {
    if (state) setPick(state.characters.map((c) => c.id));
  }, [roomCharIds]);

  // Fade the ambient hum (or owner-uploaded music) in/out with mute, without restarting it.
  useEffect(() => {
    const ctx = audioCtxRef.current; const nodes = ambientRef.current;
    if (ctx && nodes) {
      nodes.gain.gain.cancelScheduledValues(ctx.currentTime);
      nodes.gain.gain.linearRampToValueAtTime(muted ? 0.0001 : 0.045, ctx.currentTime + 0.3);
    }
    if (bgmElRef.current) bgmElRef.current.volume = muted ? 0 : 0.5;
  }, [muted]);

  // Ambient background music plays for as long as bidding is live on this device —
  // the owner's uploaded track if one is set, otherwise the synthesized hum.
  useEffect(() => {
    const ctx = ensureAudioCtx();
    const shouldPlay = screen === "auction" && state?.phase === "BIDDING";
    if (shouldPlay && siteConfig.bgm) {
      if (ambientRef.current) { stopAmbientNodes(ctx, ambientRef.current); ambientRef.current = null; }
      if (!bgmElRef.current || bgmElRef.current.src !== siteConfig.bgm) {
        bgmElRef.current?.pause();
        const el = new Audio(siteConfig.bgm);
        el.loop = true;
        el.volume = mutedRef.current ? 0 : 0.5;
        bgmElRef.current = el;
      }
      bgmElRef.current.play().catch(() => { /* blocked until first gesture */ });
    } else if (shouldPlay) {
      bgmElRef.current?.pause();
      if (!ambientRef.current) ambientRef.current = startAmbientNodes(ctx, mutedRef.current ? 0.0001 : 0.045);
    } else {
      bgmElRef.current?.pause();
      if (ambientRef.current) { stopAmbientNodes(ctx, ambientRef.current); ambientRef.current = null; }
    }
  }, [screen, state?.phase, siteConfig.bgm]);

  // Heartbeat thump on each of the last 5 seconds of the countdown — owner's
  // uploaded sound if set, otherwise the synthesized default.
  useEffect(() => {
    if (!state || state.phase !== "BIDDING") { lastHeartbeatSecond.current = null; return; }
    if (state.timer <= 5 && state.timer >= 1) {
      if (lastHeartbeatSecond.current !== state.timer) {
        lastHeartbeatSecond.current = state.timer;
        if (!mutedRef.current) {
          if (siteConfig.heartbeatSound) playCustomOneShot(siteConfig.heartbeatSound, 0.6);
          else playHeartbeatThump(ensureAudioCtx());
        }
      }
    } else {
      lastHeartbeatSecond.current = null;
    }
  }, [state?.timer, state?.phase]);

  // Detect a sale / queue / discard the instant it happens, from state deltas.
  useEffect(() => {
    if (!state) return;
    if (state.history.length > prevHistoryLen.current) {
      const last = state.history[state.history.length - 1];
      setFx({ type: "sold", character: last.character });
      if (!mutedRef.current) {
        if (siteConfig.soldSound) playCustomOneShot(siteConfig.soldSound, 0.7);
        else playHammerBang(ensureAudioCtx());
      }
      setTimeout(() => setFx(null), 1700);
    } else if (state.finalUnsold.length > prevTrashLen.current) {
      const last = state.finalUnsold[state.finalUnsold.length - 1];
      setFx({ type: "trashed", character: last });
      if (!mutedRef.current) {
        if (siteConfig.trashSound) playCustomOneShot(siteConfig.trashSound, 0.6);
        else playTrashClank(ensureAudioCtx());
      }
      setTimeout(() => setFx(null), 1700);
    } else if (state.unsoldQueue.length > prevQueueLen.current) {
      const last = state.unsoldQueue[state.unsoldQueue.length - 1];
      setFx({ type: "queued", character: last });
      if (!mutedRef.current) {
        if (siteConfig.queueSound) playCustomOneShot(siteConfig.queueSound, 0.6);
        else playQueueWhoosh(ensureAudioCtx());
      }
      setTimeout(() => setFx(null), 1700);
    }
    prevHistoryLen.current = state.history.length;
    prevQueueLen.current = state.unsoldQueue.length;
    prevTrashLen.current = state.finalUnsold.length;
  }, [state?.history.length, state?.unsoldQueue.length, state?.finalUnsold.length]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 2800);
  }

  function create() {
    exitedRef.current = false;
    const names = Array.from({ length: teamCount }, (_, i) => teamNames[i] || `Team ${i + 1}`);
    socket?.emit("createRoom", {
      name: name || "Host", title, mode, budget, bidIncrement: increment, timerMax: timer,
      teamNames: names, limits: limitsDraft,
    });
    setScreen("lobby");
  }
  // Landing page: pick the mode first, then go to the lobby (whose setup form uses it).
  function startNew(m: GameMode) { setMode(m); setScreen("lobby"); }
  function join() {
    exitedRef.current = false;
    socket?.emit("joinRoom", { roomCode: room.trim().toUpperCase(), name: name || "Player" });
    setScreen("lobby");
  }
  function start() { socket?.emit("startAuction"); }
  function bid(amount: number) { socket?.emit("bid", { amount }); }
  function shuffle() { socket?.emit("shuffle"); }
  function markSold() { socket?.emit("markSold"); }
  function markUnsold() { socket?.emit("markUnsold"); }
  async function setBackground(file: File | null) {
    const dataUrl = file ? await fileToDataUrl(file) : "";
    socket?.emit("updateBackground", dataUrl);
  }
  async function saveSiteConfigField(field: keyof SiteConfig, file: File | null) {
    if (!isOwner) return;
    const dataUrl = file ? await fileToDataUrl(file) : "";
    socket?.emit("setSiteConfig", { field, value: dataUrl });
  }

  // Owner-only, works right from the auction page: swaps one character's picture.
  // Owner account only — not just "host" — and it sticks
  // on that character until the owner changes it again.
  async function changeCurrentCharacterImage(characterId: string, file: File | null) {
    const dataUrl = file ? await fileToDataUrl(file) : "";
    socket?.emit("setCharacterImage", { characterId, image: dataUrl });
  }

  // Host-only: send everyone in the room back to the lobby with a clean slate —
  // same players, teams and character list — for another round.
  function playAgain() {
    if (!me?.isHost) return flash("Only the host can start a new round.");
    socket?.emit("resetRoom");
  }
  // Logout is the ONLY thing that clears the saved login.
  function logout() {
    if (!window.confirm("Log out on this device?")) return;
    socket?.emit("logout", { token: lsGet(SESSION_KEY) });
    lsDel(SESSION_KEY);
    try { (window as any).google?.accounts?.id?.disableAutoSelect(); } catch { /* ignore */ }
    (window as any).__auctionGoogleCred = undefined;
    profileLoaded.current = false;
    setIsOwner(false); setLibrary([]); setState(null); setRoom(""); setShowSiteSettings(false);
    setScreen("home"); setAuthEmail(""); setAuthName(""); setAuthError("");
    setAuthStatus("out");
  }
  // Exit Game: really leave the room (server removes your seat and closes the room if nobody is
  // left) and wipe everything that belonged to this game, then start again from the first screen.
  // Saved characters, images, wallpapers and sounds live on the server and are NOT touched.
  function exitGame() {
    if (!window.confirm("Exit this game? You will leave the room and go back to the home page.")) return;
    exitedRef.current = true;
    socket?.emit("leaveRoom");
    setState(null); setRoom(""); setSelectedTeam("t1");
    setPick([]);
    setEditingId(null); setEditDraft(null); setLibEditId(null); setCharDraft(blankDraft(limitsDraft));
    setFx(null); prevHistoryLen.current = 0; prevQueueLen.current = 0; prevTrashLen.current = 0;
    setManagerTab("pick");
    setScreen("home");
  }

  function loadAllowedEmails() {
    if (!isOwner) return;
    socket?.emit("listAllowedEmails", {});
  }
  function addAllowedEmail() {
    if (!isOwner) return;
    if (!newEmailInput.trim()) return flash("Enter an email to add.");
    socket?.emit("addAllowedEmail", { email: newEmailInput.trim() });
    setNewEmailInput("");
  }
  function removeAllowedEmail(email: string) {
    if (!isOwner) return;
    socket?.emit("removeAllowedEmail", { email });
  }

  const soundSlots: { field: keyof SiteConfig; label: string; hint: string }[] = [
    { field: "bgm", label: "Auction background music", hint: "Loops for as long as bidding is live on the auction screen." },
    { field: "heartbeatSound", label: "Heartbeat sound", hint: "Plays once per second in the last 5 seconds of each character's timer." },
    { field: "soldSound", label: "Hammer / SOLD sound", hint: "Plays the instant a character is sold, alongside the SOLD! animation." },
    { field: "queueSound", label: "Queue sound", hint: "Plays when a character is unsold for the first time and added to the re-auction queue." },
    { field: "trashSound", label: "Trash / discard sound", hint: "Plays when a character is unsold a second time and permanently discarded." },
  ];

  function saveLimits() {
    if (limitsDraft.minValue >= limitsDraft.maxValue) return flash("Min value must be lower than max value.");
    socket?.emit("updateLimits", limitsDraft);
    flash("Limits updated.");
  }

  async function bulkUpload(files: FileList | null) {
    if (!files || !state) return;
    const room_ = state.characters.length;
    const slotsLeft = state.limits.maxCharacters - room_;
    if (slotsLeft <= 0) return flash(`Character limit reached (${state.limits.maxCharacters}). Remove some first.`);
    const chosen = Array.from(files).slice(0, slotsLeft);
    if (chosen.length < files.length) flash(`Only ${slotsLeft} slot(s) left — extra images skipped.`);
    const added: Character[] = [];
    for (let i = 0; i < chosen.length; i++) {
      const file = chosen[i];
      const image = await fileToDataUrl(file);
      added.push({
        id: `upload-${Date.now()}-${i}`,
        name: file.name.replace(/\.[^.]+$/, ""),
        universe: "Custom",
        basePrice: state.limits.minValue,
        power: Math.round(state.limits.maxPower * 0.7),
        popularity: 80,
        rarity: "Custom",
        abilityNote: "",
        image,
      });
    }
    socket?.emit("updateCharacters", outChars([...state.characters, ...added]));
  }

  async function addCharacter(imageFile: File | null) {
    if (!state) return;
    if (!charDraft.name.trim()) return flash("Give the character a name.");
    if (state.characters.length >= state.limits.maxCharacters)
      return flash(`Character limit reached (${state.limits.maxCharacters}).`);
    const image = imageFile ? await fileToDataUrl(imageFile) : charDraft.image;
    const power = Math.min(state.limits.maxPower, Math.max(1, charDraft.power));
    const basePrice = Math.min(state.limits.maxValue, Math.max(state.limits.minValue, charDraft.basePrice));
    const newChar: Character = {
      id: `custom-${Date.now()}`,
      name: charDraft.name.trim(),
      universe: charDraft.universe.trim() || "Custom",
      basePrice, power, popularity: power,
      rarity: charDraft.rarity, abilityNote: charDraft.abilityNote.trim(), image,
    };
    socket?.emit("updateCharacters", outChars([...state.characters, newChar]));
    setCharDraft(blankDraft(state.limits));
    flash(`${newChar.name} added to the auction pool.`);
  }

  // ---- Character library helpers ----
  // Everything the host can tick: the library plus any room-only characters added by hand.
  const pickable: Character[] = useMemo(() => {
    const ids = new Set(library.map((c) => c.id));
    const roomOnly = (state?.characters || []).filter((c) => !ids.has(c.id));
    return [...library, ...roomOnly];
  }, [library, state?.characters]);
  const needCount = state ? Math.min(state.limits.maxCharacters, pickable.length) : 0;
  const pickDirty = state ? pick.join("|") !== state.characters.map((c) => c.id).join("|") : false;
  const customIds = new Set(library.filter((c) => !demoCharacters.some((d) => d.id === c.id)).map((c) => c.id));

  function togglePick(id: string) {
    if (!state) return;
    if (pick.includes(id)) return setPick(pick.filter((x) => x !== id));
    if (pick.length >= state.limits.maxCharacters) return flash(`Limit is ${state.limits.maxCharacters} — untick one first.`);
    setPick([...pick, id]);
  }
  function applyPick() {
    if (!state) return;
    socket?.emit("selectCharacters", { ids: pick });
    flash(`${pick.length} character${pick.length === 1 ? "" : "s"} set for this auction.`);
  }
  function saveDefaultPick() {
    if (!state) return;
    socket?.emit("selectCharacters", { ids: pick });
    socket?.emit("saveDefaultSelection", { ids: pick });
    flash("Saved — new rooms will start with this list.");
  }
  async function saveToLibrary(imageFile: File | null) {
    if (!state) return;
    if (!charDraft.name.trim()) return flash("Give the character a name.");
    const image = imageFile ? await fileToDataUrl(imageFile) : charDraft.image;
    const power = Math.min(state.limits.maxPower, Math.max(1, charDraft.power));
    const basePrice = Math.min(state.limits.maxValue, Math.max(state.limits.minValue, charDraft.basePrice));
    socket?.emit("libraryUpsert", {
      character: {
        id: libEditId || undefined, name: charDraft.name.trim(), universe: charDraft.universe.trim() || "Custom",
        basePrice, power, popularity: power, rarity: charDraft.rarity, abilityNote: charDraft.abilityNote.trim(), image: cleanImg(image),
      },
    });
    flash(libEditId ? "Library character updated." : `${charDraft.name.trim()} saved to the permanent library.`);
    setCharDraft(blankDraft(state.limits));
    setLibEditId(null);
    setManagerTab("pick");
  }
  function editLibraryCharacter(c: Character) {
    setLibEditId(c.id);
    setCharDraft({ name: c.name, universe: c.universe, abilityNote: c.abilityNote || "", power: c.power, basePrice: c.basePrice, rarity: c.rarity, image: c.image });
    setManagerTab("add");
  }
  function deleteLibraryCharacter(c: Character) {
    if (!window.confirm(`Delete ${c.name} from the permanent library?`)) return;
    socket?.emit("libraryDelete", { id: c.id });
    setPick((p) => p.filter((x) => x !== c.id));
  }

  function startEdit(c: Character) {
    setEditingId(c.id);
    setEditDraft({
      name: c.name, universe: c.universe, abilityNote: c.abilityNote || "",
      power: c.power, basePrice: c.basePrice, rarity: c.rarity, image: c.image,
    });
    setManagerTab("list");
  }

  async function saveEdit(imageFile: File | null) {
    if (!state || !editingId || !editDraft) return;
    const image = imageFile ? await fileToDataUrl(imageFile) : editDraft.image;
    const power = Math.min(state.limits.maxPower, Math.max(1, editDraft.power));
    const basePrice = Math.min(state.limits.maxValue, Math.max(state.limits.minValue, editDraft.basePrice));
    const next = state.characters.map((c) =>
      c.id === editingId
        ? { ...c, name: editDraft.name.trim() || c.name, universe: editDraft.universe.trim() || c.universe,
            basePrice, power, popularity: power, rarity: editDraft.rarity,
            abilityNote: editDraft.abilityNote.trim(), image }
        : c
    );
    socket?.emit("updateCharacters", outChars(next));
    setEditingId(null);
    setEditDraft(null);
  }

  function removeCharacter(id: string) {
    if (!state) return;
    socket?.emit("updateCharacters", outChars(state.characters.filter((c) => c.id !== id)));
    if (editingId === id) { setEditingId(null); setEditDraft(null); }
  }

  // ---------------------------------------------------------------- RESTORING SAVED LOGIN
  if (authStatus === "restoring") return (
    <main className="signin-gate">
      <div className="signin-card">
        <b>◆ CHARACTER AUCTION</b>
        <h1>SIGNING YOU IN…</h1>
        <div className="spinner" aria-hidden="true" />
        <p className="muted">{slowRestore ? "The server is waking up — on the free plan this can take up to a minute. Your login is safe, just wait a moment." : "Restoring your saved login…"}</p>
        {slowRestore && <button className="ghost" onClick={() => { lsDel(SESSION_KEY); setAuthStatus("out"); }}>Sign in with Google again instead</button>}
      </div>
    </main>
  );

  // ---------------------------------------------------------------- SIGN-IN GATE
  if (!authed) return (
    <main className="signin-gate">
      <div className="signin-card">
        <b>◆ CHARACTER AUCTION</b>
        <h1>SIGN IN TO CONTINUE</h1>
        <p className="muted">This game is invite-only. Sign in with the Google account the host approved for you.</p>
        <div ref={googleBtnRef} className="google-btn-slot" />
        {authError && <p className="signin-error">{authError}</p>}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </main>
  );

  // ---------------------------------------------------------------- HOME
  if (screen === "home") return (
    <main className="home" style={liveWallpaper ? undefined : homeBgStyle}>
      {liveWallpaper}
      <div className="nav">
        <b>◆ CHARACTER AUCTION</b>
        <span>TEAM MULTIPLAYER</span>
        <span className="signed-in-as" title={authEmail}>{authName || authEmail}</span>
        {isOwner && (
          <button className="site-settings-trigger" title="Site owner settings" onClick={() => setShowSiteSettings((v) => !v)}>
            <Settings size={16} />
          </button>
        )}
        <button className="logout-btn" title="Log out" onClick={logout}><LogOut size={14} /> Logout</button>
      </div>
      {isOwner && showSiteSettings && (
        <div className="site-settings-panel">
          <div className="site-settings-head">
            <small>OWNER ONLY — SITE CUSTOMIZATION</small>
            <button className="icon" onClick={() => setShowSiteSettings(false)}><X size={16} /></button>
          </div>
          <p className="muted small">Everything below is set once by you and stays exactly as you leave it — for everyone, in every room — until you change it again. Visible and usable only by the owner Google account.</p>

          <div className="site-settings-section">
            <small>LANDING PAGE BACKGROUND</small>
            {siteConfig.background && <img className="preview" src={siteConfig.background} alt="site background" />}
            <label className="upload wide small">
              <Image size={14} /> {siteConfig.background ? "Change background" : "Upload background image"}
              <input type="file" accept="image/*" onChange={(e) => saveSiteConfigField("background", e.target.files?.[0] || null)} />
            </label>
            {siteConfig.background && (
              <button className="ghost" onClick={() => saveSiteConfigField("background", null)}><X size={14} /> Remove background</button>
            )}
          </div>

          <div className="site-settings-section">
            <small>LIVE WALLPAPER (VIDEO)</small>
            <p className="muted small">A looping video background for the landing page and the auction page — overrides the static background above while it's set. Keep clips short (10–20s) so the file stays small.</p>
            {siteConfig.backgroundVideo && <video className="preview" src={siteConfig.backgroundVideo} autoPlay loop muted playsInline />}
            <label className="upload wide small">
              <Video size={14} /> {siteConfig.backgroundVideo ? "Change live wallpaper" : "Upload live wallpaper video"}
              <input type="file" accept="video/*" onChange={(e) => saveSiteConfigField("backgroundVideo", e.target.files?.[0] || null)} />
            </label>
            {siteConfig.backgroundVideo && (
              <button className="ghost" onClick={() => saveSiteConfigField("backgroundVideo", null)}><X size={14} /> Remove live wallpaper</button>
            )}
          </div>

          <div className="site-settings-section">
            <small>AUCTION PAGE SOUNDS</small>
            {soundSlots.map((slot) => (
              <div className="sound-slot" key={slot.field}>
                <div className="sound-slot-head">
                  <b>{slot.label}</b>
                  {siteConfig[slot.field] ? <span className="sound-status set">Custom set</span> : <span className="sound-status">Using default</span>}
                </div>
                <p className="muted small">{slot.hint}</p>
                {siteConfig[slot.field] && <audio controls src={siteConfig[slot.field]} className="sound-preview" />}
                <div className="sound-slot-btns">
                  <label className="upload small">
                    <Upload size={13} /> {siteConfig[slot.field] ? "Replace" : "Upload"}
                    <input type="file" accept="audio/*" onChange={(e) => saveSiteConfigField(slot.field, e.target.files?.[0] || null)} />
                  </label>
                  {siteConfig[slot.field] && (
                    <button className="ghost small" onClick={() => saveSiteConfigField(slot.field, null)}><X size={13} /> Remove</button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="site-settings-section">
            <small>APPROVED GOOGLE ACCOUNTS</small>
            <p className="muted small">Only these Google accounts can sign in and use the site at all. You're auto-approved as the owner.</p>
            <button className="secondary" onClick={loadAllowedEmails}>Load current list</button>
            {allowedEmailsList.length > 0 && (
              <div className="email-list">
                {allowedEmailsList.map((email) => (
                  <div className="email-row" key={email}>
                    <span>{email}</span>
                    <button className="icon danger" onClick={() => removeAllowedEmail(email)}><X size={14} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="two">
              <input value={newEmailInput} onChange={(e) => setNewEmailInput(e.target.value)} placeholder="friend@gmail.com" />
              <button className="secondary" onClick={addAllowedEmail}>Add</button>
            </div>
          </div>
        </div>
      )}
      <section className="hero">
        <small>REAL-TIME • MULTI-DEVICE • TEAM OR SOLO</small>
        <h1>THE<br /><i>CHARACTER</i><br />AUCTION</h1>
        <p>Every friend joins from their own phone. Play as teams with a shared wallet, or go solo and bid head-to-head against your friends. Fully custom character roster — your images, your ability notes, your power scores, your value limits, your background.</p>
        {state ? (
          <button className="primary" onClick={() => setScreen(state.phase === "BIDDING" ? "auction" : state.phase === "COMPLETE" ? "results" : "lobby")}>
            <Gavel /> {state.phase === "BIDDING" ? "RETURN TO AUCTION" : state.phase === "COMPLETE" ? "VIEW RESULTS" : "BACK TO LOBBY"}
          </button>
        ) : (
          <div className="hero-modes">
            <button className="primary" onClick={() => startNew("TEAM")}><Users /> TEAM GAME</button>
            <button className="primary" onClick={() => startNew("SOLO")}><User /> SOLO GAME</button>
            <button className="secondary" onClick={() => setScreen("lobby")}>JOIN WITH CODE</button>
          </div>
        )}
        <div className="hero-tags">
          <span><Sparkles size={14} /> Custom characters</span>
          <span><Users size={14} /> Team or solo mode</span>
          <span><Image size={14} /> Customizable background</span>
        </div>
      </section>
      {toast && <div className="toast">{toast}</div>}
    </main>
  );

  // ---------------------------------------------------------------- LOBBY
  if (screen === "lobby") return (
    <main className="page" style={liveWallpaper ? undefined : bgStyle}>
      {liveWallpaper}
      <header className="top">
        <b>◆ CHARACTER AUCTION</b>
        <div>
          <span>{state?.roomCode || "NEW ROOM"}</span>
          {state && (
            <button className="exit-btn" title="Leave this room and go to the home page" onClick={exitGame}>
              <LogOut size={14} /> EXIT GAME
            </button>
          )}
        </div>
      </header>
      <div className={state ? "grid has-room" : "grid"}>
        <section className="panel">
          <small>HOST / PLAYER</small><h2>Game setup</h2>
          <label>Your name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Loki" /></label>
          {!state && (
            <>
              <label>Auction title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
              <label>Game mode
                <div className="mode-toggle">
                  <button type="button" className={mode === "TEAM" ? "mode-btn active" : "mode-btn"} onClick={() => setMode("TEAM")}>
                    <Users size={15} /> Team mode
                  </button>
                  <button type="button" className={mode === "SOLO" ? "mode-btn active" : "mode-btn"} onClick={() => setMode("SOLO")}>
                    <User size={15} /> Solo — every player for themselves
                  </button>
                </div>
              </label>
              <div className="two">
                <label>Budget<input type="number" value={budget} onChange={(e) => setBudget(+e.target.value)} /></label>
                <label>Bid increment<input type="number" value={increment} onChange={(e) => setIncrement(+e.target.value)} /></label>
              </div>
              <label>Timer per character (seconds)
                <select value={timer} onChange={(e) => setTimer(+e.target.value)}>
                  <option>10</option><option>15</option><option>20</option><option>30</option>
                </select>
              </label>
              {mode === "TEAM" ? (
                <>
                  <label>Number of teams
                    <select value={teamCount} onChange={(e) => { const n = +e.target.value; setTeamCount(n); setTeamNames(Array.from({ length: n }, (_, i) => teamNames[i] || `Team ${i + 1}`)); }}>
                      {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => <option key={n}>{n}</option>)}
                    </select>
                  </label>
                  {Array.from({ length: teamCount }).map((_, i) => (
                    <label key={i}>Team {i + 1}
                      <input value={teamNames[i] || ""} onChange={(e) => { const a = [...teamNames]; a[i] = e.target.value; setTeamNames(a); }} />
                    </label>
                  ))}
                </>
              ) : (
                <p className="muted small solo-note">
                  Play on your own, or let friends join — everyone gets their own individual wallet, no pre-set teams needed.
                </p>
              )}
            </>
          )}

          {!state && (
            <div className="limits-inline">
              <small>CHARACTER LIMITS (set before creating room, editable later)</small>
              <div className="two">
                <label>Max characters<input type="number" value={limitsDraft.maxCharacters} onChange={(e) => setLimitsDraft({ ...limitsDraft, maxCharacters: +e.target.value })} /></label>
                <label>Max power score<input type="number" value={limitsDraft.maxPower} onChange={(e) => setLimitsDraft({ ...limitsDraft, maxPower: +e.target.value })} /></label>
              </div>
              <div className="two">
                <label>Min base value (₹)<input type="number" value={limitsDraft.minValue} onChange={(e) => setLimitsDraft({ ...limitsDraft, minValue: +e.target.value })} /></label>
                <label>Max base value (₹)<input type="number" value={limitsDraft.maxValue} onChange={(e) => setLimitsDraft({ ...limitsDraft, maxValue: +e.target.value })} /></label>
              </div>
            </div>
          )}

          <button className="primary full" onClick={create}><Plus /> CREATE ROOM</button>
          <div className="join"><input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="ROOM CODE" /><button className="secondary" onClick={join}>JOIN</button></div>
        </section>

        <section className="panel">
          <small>JOINED PLAYERS</small><h2>{state?.title || "Waiting room"}</h2>
          {state ? (
            <>
              <div className="code">{state.roomCode}</div>
              <p className="muted">
                Give this code to your friends. They open the same address on their own phones and join
                {state.mode === "SOLO" ? " with their own individual wallet." : " your team."}
              </p>
              {state.mode === "TEAM" && (
                <label>Choose your team
                  <select value={me?.teamId || selectedTeam} onChange={(e) => { setSelectedTeam(e.target.value); if (me) socket?.emit("switchTeam", { teamId: e.target.value }); }}>
                    {state.teams.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.members.length}/5)</option>)}
                  </select>
                </label>
              )}
              {me?.isHost ? (
                <RoomEditor state={state} socket={socket} />
              ) : (
                <div className="teams">
                  {state.teams.map((t) => (
                    <div className="team" key={t.id}>
                      <b>{t.name}</b>
                      <span>{t.members.map((id) => state.players.find((p) => p.id === id)?.name).filter(Boolean).join(" • ") || "Waiting..."}</span>
                      <small>{money(t.budget - t.spent)} left</small>
                    </div>
                  ))}
                </div>
              )}
              {me?.isHost && (
                <>
                  <button className="secondary full" onClick={shuffle}><Shuffle /> SHUFFLE CHARACTERS</button>
                  <button className="primary full" onClick={start}><Play /> START {state.mode === "SOLO" ? "SOLO" : "TEAM"} AUCTION</button>
                </>
              )}
            </>
          ) : <p className="muted">Create a room first. Your room code will appear here.</p>}
        </section>
      </div>

      {state && me?.isHost && (
        <section className="panel manager">
          <div className="manager-head">
            <div>
              <small>HOST TOOLS</small>
              <h2>Character manager</h2>
              <p className="muted">
                {state.characters.length} / {state.limits.maxCharacters} characters &nbsp;•&nbsp;
                value range {money(state.limits.minValue)}–{money(state.limits.maxValue)} &nbsp;•&nbsp;
                power out of {state.limits.maxPower}
              </p>
            </div>
            <div className="tabbar">
              <button className={managerTab === "pick" ? "tab active" : "tab"} onClick={() => setManagerTab("pick")}><Library size={14} /> Pick ({state.characters.length}/{state.limits.maxCharacters})</button>
              <button className={managerTab === "add" ? "tab active" : "tab"} onClick={() => setManagerTab("add")}><Plus size={14} /> Add</button>
              <button className={managerTab === "limits" ? "tab active" : "tab"} onClick={() => setManagerTab("limits")}><SlidersHorizontal size={14} /> Limits</button>
              <button className={managerTab === "theme" ? "tab active" : "tab"} onClick={() => setManagerTab("theme")}><Image size={14} /> Theme</button>
              <button className={managerTab === "list" ? "tab active" : "tab"} onClick={() => setManagerTab("list")}><Users size={14} /> Roster ({state.characters.length})</button>
            </div>
          </div>

          {managerTab === "pick" && (
            <div className="pick-panel">
              <p className="muted small">
                Tick the characters that play in this auction — pick {needCount} (the limit is {state.limits.maxCharacters}). Characters you add by hand are kept in the library for good; use “Save for all rooms” so every new room starts with this exact list.
              </p>
              <div className="pick-bar">
                <b className={pick.length === needCount ? "pick-count ok" : "pick-count"}>{pick.length} / {needCount} selected</b>
                <button className="ghost" onClick={() => setPick(pickable.slice(0, state.limits.maxCharacters).map((c) => c.id))}>Select first {Math.min(state.limits.maxCharacters, pickable.length)}</button>
                <button className="ghost" onClick={() => setPick([])}>Clear</button>
                <button className="secondary" onClick={applyPick} disabled={!pickDirty}><Check size={16} /> APPLY TO THIS AUCTION</button>
                {isOwner && <button className="primary" onClick={saveDefaultPick}><Check size={16} /> SAVE FOR ALL ROOMS</button>}
              </div>
              {pickDirty && <p className="warn"><ShieldAlert size={14} /> You changed the ticks — press Apply (or Save for all rooms) or they won't count.</p>}
              {defaultSel && <p className="muted small">Saved default list: {defaultSel.length} characters.</p>}
              <div className="pick-grid">
                {pickable.map((c) => {
                  const on = pick.includes(c.id);
                  return (
                    <div key={c.id} className={on ? "pick-card on" : "pick-card"} onClick={() => togglePick(c.id)}>
                      <div className="pick-check">{on ? <Check size={14} /> : null}</div>
                      <div className="char-thumb">{c.image ? <img src={c.image} alt={c.name} /> : <div className="initial">{c.name[0]}</div>}</div>
                      <div className="char-meta">
                        <b>{c.name}</b>
                        <span className="muted">{c.universe} • {c.rarity}</span>
                        <div className="stat-row"><span>Power {c.power}</span><span>{money(c.basePrice)}</span></div>
                        {!library.some((l) => l.id === c.id) && <span className="tag-room">this room only</span>}
                      </div>
                      {isOwner && customIds.has(c.id) && (
                        <div className="char-actions" onClick={(e) => e.stopPropagation()}>
                          <button className="icon" onClick={() => editLibraryCharacter(c)}><Pencil size={16} /></button>
                          <button className="icon danger" onClick={() => deleteLibraryCharacter(c)}><Trash2 size={16} /></button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="muted small">Characters and pictures you add or edit as the owner are saved permanently by themselves.</p>
            </div>
          )}

          {managerTab === "add" && (
            <div className="char-form">
              <label className="upload wide">
                <ImagePlus />
                {charDraft.image ? "Change image" : "Upload character image"}
                <input type="file" accept="image/*" onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setCharDraft({ ...charDraft, image: await fileToDataUrl(f) });
                }} />
              </label>
              {charDraft.image && <img className="preview" src={charDraft.image} alt="preview" />}
              <div className="two">
                <label>Character name<input value={charDraft.name} onChange={(e) => setCharDraft({ ...charDraft, name: e.target.value })} placeholder="e.g. Loki" /></label>
                <label>Movie / universe<input value={charDraft.universe} onChange={(e) => setCharDraft({ ...charDraft, universe: e.target.value })} placeholder="e.g. Marvel" /></label>
              </div>
              <label>Ability / power key note
                <textarea rows={2} value={charDraft.abilityNote} onChange={(e) => setCharDraft({ ...charDraft, abilityNote: e.target.value })} placeholder="Short note on their power / ability, shown during bidding" />
              </label>
              <div className="two">
                <label>Power score (max {state.limits.maxPower})
                  <input type="number" min={1} max={state.limits.maxPower} value={charDraft.power}
                    onChange={(e) => setCharDraft({ ...charDraft, power: Math.min(state.limits.maxPower, Math.max(1, +e.target.value)) })} />
                </label>
                <label>Base value (₹{state.limits.minValue}–₹{state.limits.maxValue})
                  <input type="number" min={state.limits.minValue} max={state.limits.maxValue} value={charDraft.basePrice}
                    onChange={(e) => setCharDraft({ ...charDraft, basePrice: Math.min(state.limits.maxValue, Math.max(state.limits.minValue, +e.target.value)) })} />
                </label>
              </div>
              <label>Rarity
                <select value={charDraft.rarity} onChange={(e) => setCharDraft({ ...charDraft, rarity: e.target.value })}>
                  {RARITIES.map((r) => <option key={r}>{r}</option>)}
                </select>
              </label>
              {isOwner && (
                <button className="primary full" onClick={() => saveToLibrary(null)}>
                  <Library /> {libEditId ? "SAVE CHANGES TO LIBRARY" : "SAVE PERMANENTLY TO LIBRARY"}
                </button>
              )}
              {libEditId && <button className="ghost full" onClick={() => { setLibEditId(null); setCharDraft(blankDraft(state.limits)); }}><X size={16} /> Cancel editing</button>}
              <button className="secondary full" onClick={() => addCharacter(null)}
                disabled={state.characters.length >= state.limits.maxCharacters}>
                <Plus /> ADD TO THIS AUCTION ONLY
              </button>
              {state.characters.length >= state.limits.maxCharacters && (
                <p className="warn"><ShieldAlert size={14} /> Character limit reached — remove one or raise the limit in the Limits tab.</p>
              )}

              <div className="divider" />
              <label className="upload wide">
                <Upload />
                Bulk-upload multiple images (quick add)
                <input type="file" accept="image/*" multiple onChange={(e) => bulkUpload(e.target.files)} />
              </label>
              <p className="muted small">Bulk-added characters use default power/value — edit them anytime in the Roster tab.</p>
            </div>
          )}

          {managerTab === "limits" && (
            <div className="char-form">
              <div className="two">
                <label>Max characters allowed<input type="number" value={limitsDraft.maxCharacters} onChange={(e) => setLimitsDraft({ ...limitsDraft, maxCharacters: +e.target.value })} /></label>
                <label>Max power score<input type="number" value={limitsDraft.maxPower} onChange={(e) => setLimitsDraft({ ...limitsDraft, maxPower: +e.target.value })} /></label>
              </div>
              <div className="two">
                <label>Min base value (₹)<input type="number" value={limitsDraft.minValue} onChange={(e) => setLimitsDraft({ ...limitsDraft, minValue: +e.target.value })} /></label>
                <label>Max base value (₹)<input type="number" value={limitsDraft.maxValue} onChange={(e) => setLimitsDraft({ ...limitsDraft, maxValue: +e.target.value })} /></label>
              </div>
              <p className="muted small">Lowering the max character count trims extra characters from the end of the roster. Existing characters outside the new value/power range are automatically clamped.</p>
              <button className="primary full" onClick={saveLimits}><Check /> SAVE LIMITS</button>
            </div>
          )}

          {managerTab === "theme" && (
            <div className="char-form">
              <p className="muted small">Upload a background image for the lobby and auction screens — a movie poster wall, your own artwork, anything. It's dimmed automatically so text stays readable.</p>
              {state.background && <img className="preview" src={state.background} alt="current background" />}
              <label className="upload wide">
                <Image />
                {state.background ? "Change background" : "Upload background image"}
                <input type="file" accept="image/*" onChange={(e) => setBackground(e.target.files?.[0] || null)} />
              </label>
              {state.background && (
                <button className="ghost" onClick={() => setBackground(null)}><X size={16} /> Remove background (use default theme)</button>
              )}
            </div>
          )}

          {managerTab === "list" && (
            <div className="char-list">
              {state.characters.length === 0 && <p className="muted">No characters yet — add some in the Add tab.</p>}
              {state.characters.map((c) => (
                <div className="char-card" key={c.id}>
                  {editingId === c.id && editDraft ? (
                    <div className="char-edit">
                      <label className="upload wide small">
                        <ImagePlus /> {editDraft.image ? "Change image" : "Add image"}
                        <input type="file" accept="image/*" onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (f) setEditDraft({ ...editDraft, image: await fileToDataUrl(f) });
                        }} />
                      </label>
                      <div className="two">
                        <label>Name<input value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} /></label>
                        <label>Movie / universe<input value={editDraft.universe} onChange={(e) => setEditDraft({ ...editDraft, universe: e.target.value })} /></label>
                      </div>
                      <label>Ability / power key note<textarea rows={2} value={editDraft.abilityNote} onChange={(e) => setEditDraft({ ...editDraft, abilityNote: e.target.value })} /></label>
                      <div className="two">
                        <label>Power (max {limits.maxPower})<input type="number" value={editDraft.power} onChange={(e) => setEditDraft({ ...editDraft, power: +e.target.value })} /></label>
                        <label>Base value<input type="number" value={editDraft.basePrice} onChange={(e) => setEditDraft({ ...editDraft, basePrice: +e.target.value })} /></label>
                      </div>
                      <label>Rarity
                        <select value={editDraft.rarity} onChange={(e) => setEditDraft({ ...editDraft, rarity: e.target.value })}>
                          {RARITIES.map((r) => <option key={r}>{r}</option>)}
                        </select>
                      </label>
                      <div className="row-btns">
                        <button className="primary" onClick={() => saveEdit(null)}><Check size={16} /> Save</button>
                        <button className="ghost" onClick={() => { setEditingId(null); setEditDraft(null); }}><X size={16} /> Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="char-thumb">{c.image ? <img src={c.image} alt={c.name} /> : <div className="initial">{c.name[0]}</div>}</div>
                      <div className="char-meta">
                        <b>{c.name}</b>
                        <span className="muted">{c.universe} • {c.rarity}</span>
                        {c.abilityNote && <p className="note">{c.abilityNote}</p>}
                        <div className="stat-row"><span>Power {c.power}</span><span>{money(c.basePrice)}</span></div>
                      </div>
                      <div className="char-actions">
                        <button className="icon" onClick={() => startEdit(c)}><Pencil size={16} /></button>
                        <button className="icon danger" onClick={() => removeCharacter(c.id)}><Trash2 size={16} /></button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );

  // ---------------------------------------------------------------- AUCTION
  if (screen === "auction" && state && current) {
  const upcoming = state.characters.slice(state.currentIndex + 1);
  return (
    <main className="page" style={liveWallpaper ? undefined : bgStyle}>
      {liveWallpaper}
      <header className="top">
        <b>◆ {state.title}</b>
        <div>
          <Layers size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          ROUND {state.round}
          {state.unsoldQueue.length > 0 && ` • ${state.unsoldQueue.length} QUEUED FOR RE-AUCTION`}
          {" • "}ROOM {state.roomCode} • <strong>{state.timer}s</strong>
          <button className="mute-btn" title={muted ? "Unmute sound" : "Mute sound"} onClick={() => setMuted((m) => !m)}>
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
        </div>
      </header>
      {state.phase === "BIDDING" && state.timer <= 5 && state.timer >= 1 && (
        <div className="countdown-alert" key={state.timer}>
          <span>{state.timer}</span>
        </div>
      )}
      <div className="auction">
        <aside className="panel">
          <small>TEAMS</small>
          {state.teams.map((t) => (
            <div
              className={`team live ${t.id === state.currentBidderTeamId ? "active" : ""}`}
              key={t.id}
              style={{ borderLeftColor: t.id === state.currentBidderTeamId ? undefined : t.color }}
            >
              <b style={{ color: t.color }}>{t.name}</b>
              {t.members.map((id) => state.players.find((p) => p.id === id)).filter(Boolean).map((pl) => {
                const bought = state.history.filter((h) => h.playerId === pl!.id);
                return (
                  <div className="player-bought" key={pl!.id}>
                    <span className="pb-name">{pl!.name}{!pl!.connected ? " (offline)" : ""}</span>
                    <div className="pb-icons">
                      {bought.length === 0 ? <em className="muted small">no buys yet</em> : bought.map((h, i) => <MiniIcon key={i} c={h.character} />)}
                    </div>
                  </div>
                );
              })}
              <strong>{money(t.budget - t.spent)}</strong>
              <small className="team-count" key={t.roster.length}>{t.roster.length} won</small>
              {t.roster.length > 0 && (
                <div className="pb-icons team-roster">
                  {t.roster.map((c, i) => <MiniIcon key={`${c.id}-${i}`} c={c} size={22} />)}
                </div>
              )}
            </div>
          ))}
        </aside>
        <section>
          <div className="character">
            <div className="poster">
              {current.image ? <img src={current.image} alt={current.name} /> : <div className="initial">{current.name[0]}</div>}
              <div className="power-badge"><Sparkles size={14} /> {current.power}<small>/{state.limits.maxPower}</small></div>
              {isOwner && (
                <label className="poster-edit" title="Owner only — change this character's image. It is saved permanently.">
                  <Pencil size={13} />
                  <input type="file" accept="image/*" onChange={(e) => changeCurrentCharacterImage(current.id, e.target.files?.[0] || null)} />
                </label>
              )}
            </div>
            <div className="info">
              <small>{current.universe} • {current.rarity}</small>
              <h1>{current.name}</h1>
              {current.abilityNote && <p className="ability">{current.abilityNote}</p>}
              <p className="stats-line">Power {current.power} • Popularity {current.popularity}</p>
              <div className="current">
                CURRENT BID <b>{money(state.currentBid)}</b>
                <span>{state.currentBidderTeamId ? `${state.currentBidderName ? state.currentBidderName + " • " : ""}${state.teams.find((t) => t.id === state.currentBidderTeamId)?.name}` : "NO BID"}</span>
              </div>
            </div>
          </div>
          <div className="bidbox">
            <button className="primary" onClick={() => bid(state.currentBid + state.bidIncrement)}><Gavel /> BID {money(state.currentBid + state.bidIncrement)}</button>
            <button className="secondary" onClick={() => bid(state.currentBid + state.bidIncrement * 2)}>+2×</button>
          </div>
          {me?.isHost && (
            <div className="hostbox">
              <small>HOST CONTROLS — resolve now, no need to wait for the timer</small>
              <div className="hostbox-btns">
                <button className="sold-btn" disabled={!state.currentBidderTeamId} onClick={markSold}>
                  <CheckCircle2 size={16} /> MARK SOLD
                </button>
                <button className="unsold-btn" onClick={markUnsold}>
                  <XCircle size={16} /> UNSOLD / SKIP
                </button>
              </div>
            </div>
          )}
        </section>
        <aside className="panel">
          <small>{state.mode === "SOLO" ? "YOUR WALLET" : "YOUR TEAM"}</small><h2>{myTeam?.name}</h2>
          <div className="wallet">{money((myTeam?.budget || 0) - (myTeam?.spent || 0))}<small>{state.mode === "SOLO" ? "YOUR BUDGET" : "SHARED WALLET"}</small></div>
          <p className="muted">
            {state.mode === "SOLO"
              ? "You're bidding solo — this wallet is yours alone."
              : "Any member of your team can bid. Every member sees the same live auction."}
          </p>
          <small>RECENT SALES</small>
          {state.history.slice(-6).reverse().map((h, i) => <div className="history" key={i}><MiniIcon c={h.character} size={22} /><span className="h-text">{h.character.name}<small> ← {h.playerName || state.teams.find((tm) => tm.id === h.teamId)?.name}</small></span><b>{money(h.amount)}</b></div>)}
        </aside>
      </div>
      <section className="roster-overview">
        <div className="roster-col">
          <small>SOLD ({state.history.length})</small>
          <div className="roster-list">
            {state.history.length === 0 && <p className="muted small">Nobody sold yet.</p>}
            {state.history.slice().reverse().map((h, i) => (
              <div className="roster-row sold" key={i}>
                <div className="roster-thumb">
                  {h.character.image ? <img src={h.character.image} alt={h.character.name} /> : <span>{h.character.name[0]}</span>}
                </div>
                <div className="roster-meta"><b>{h.character.name}</b><span>Bought by {h.playerName || "?"} • {state.teams.find((t) => t.id === h.teamId)?.name}</span></div>
                <strong>{money(h.amount)}</strong>
              </div>
            ))}
          </div>
        </div>
        <div className="roster-col">
          <small>UP NEXT THIS ROUND ({upcoming.length})</small>
          <div className="roster-list">
            {upcoming.length === 0 && <p className="muted small">This is the last one this round.</p>}
            {upcoming.map((c) => (
              <div className="roster-row upcoming-row" key={c.id}>
                <div className="roster-thumb">{c.image ? <img src={c.image} alt={c.name} /> : <span>{c.name[0]}</span>}</div>
                <div className="roster-meta">
                  <b>{c.name}</b>
                  <span>{c.universe} • {c.rarity} • Power {c.power}</span>
                  {c.abilityNote && <span className="roster-note">{c.abilityNote}</span>}
                </div>
                <strong>{money(c.basePrice)}</strong>
              </div>
            ))}
          </div>
        </div>
        <div className="roster-col">
          <small>RE-AUCTION QUEUE ({state.unsoldQueue.length})</small>
          <div className="roster-list">
            {state.unsoldQueue.length === 0 && <p className="muted small">Nothing queued yet.</p>}
            {state.unsoldQueue.map((c) => (
              <div className="roster-row queued" key={c.id}>
                <div className="roster-thumb">{c.image ? <img src={c.image} alt={c.name} /> : <span>{c.name[0]}</span>}</div>
                <div className="roster-meta"><b>{c.name}</b><span>Unsold once</span></div>
                <strong>{money(c.basePrice)}</strong>
              </div>
            ))}
          </div>
        </div>
      </section>
      {fx && (
        <div className={`auction-fx fx-${fx.type}`}>
          <div className="fx-icon">
            {fx.type === "sold" && <Gavel size={64} />}
            {fx.type === "queued" && <Layers size={56} />}
            {fx.type === "trashed" && <Trash2 size={56} />}
          </div>
          <b>
            {fx.type === "sold" && "SOLD!"}
            {fx.type === "queued" && "ADDED TO RE-AUCTION QUEUE"}
            {fx.type === "trashed" && "DISCARDED — UNSOLD TWICE"}
          </b>
          <span>{fx.character.name}</span>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
  }

  // ---------------------------------------------------------------- RESULTS
  return (
    <main className="page results" style={liveWallpaper ? undefined : bgStyle}>
      {liveWallpaper}
      <Trophy size={42} />
      <small>AUCTION COMPLETE{state && state.round > 1 ? ` • ${state.round} ROUNDS` : ""}</small>
      <h1>FINAL RESULTS</h1>
      {state?.teams.slice().sort((a, b) => b.roster.reduce((s, c) => s + c.power, 0) - a.roster.reduce((s, c) => s + c.power, 0)).map((t) => {
        const members = t.members.map((id) => state.players.find((p) => p.id === id)).filter(Boolean);
        const teamWins = state.history.filter((h) => h.teamId === t.id);
        return (
          <div className="result result-full" key={t.id}>
            <div className="result-head">
              <div><h2>{t.name}</h2><p>{members.map((p) => p!.name).join(" • ")}</p></div>
              <strong>{t.roster.reduce((s, c) => s + c.power, 0)}<small> POWER</small></strong>
            </div>
            {members.map((pl) => {
              const won = teamWins.filter((h) => h.playerId === pl!.id);
              return (
                <div className="won-block" key={pl!.id}>
                  <b>{pl!.name} won {won.length} character{won.length === 1 ? "" : "s"}</b>
                  <div className="won-grid">
                    {won.length === 0 && <span className="muted small">Nothing won.</span>}
                    {won.map((h, i) => (
                      <RevealCard key={i} c={h.character} price={h.amount} index={i} team={state.mode === "SOLO" ? pl!.name : t.name} color={t.color} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
      {state && state.finalUnsold.length > 0 && (
        <div className="unsold-final">
          <small>NEVER SOLD</small>
          <p className="muted">{state.finalUnsold.map((c) => c.name).join(" • ")}</p>
        </div>
      )}
      <div className="results-actions">
        {me?.isHost ? (
          <button className="primary" onClick={playAgain}><RotateCcw size={16} /> PLAY AGAIN</button>
        ) : (
          <p className="muted small">Waiting for the host to start a new round…</p>
        )}
        <button className="ghost" onClick={exitGame}><LogOut size={16} /> EXIT GAME</button>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
