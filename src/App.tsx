import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { io, Socket } from "socket.io-client";
import {
  Gavel, Plus, Users, Upload, Play, Shuffle, ImagePlus, Trophy,
  Pencil, Trash2, Sparkles, SlidersHorizontal, X, Check, ShieldAlert,
  User, Image, CheckCircle2, XCircle, Layers, Settings, Volume2, VolumeX,
  RotateCcw, LogOut, Video,
} from "lucide-react";
import { AuctionState, Character, CharacterLimits, GameMode, SiteConfig } from "./types";
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

// Small round character icon used to show what a player has bought.
function MiniIcon({ c, size = 26 }: { c: Character; size?: number }) {
  return (
    <span className="mini-icon" style={{ width: size, height: size }} title={c.name}>
      {c.image ? <img src={c.image} alt={c.name} /> : <span>{c.name[0]}</span>}
    </span>
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
  const [managerTab, setManagerTab] = useState<"add" | "limits" | "theme" | "list">("add");

  // Owner-only site background + auction sounds — separate from any single
  // room's background, persists on the server until the owner changes it again.
  const [siteConfig, setSiteConfigState] = useState<SiteConfig>({});
  const [showSiteSettings, setShowSiteSettings] = useState(false);
  const [ownerKey, setOwnerKey] = useState("");
  const [allowedEmailsList, setAllowedEmailsListState] = useState<string[]>([]);
  const [newEmailInput, setNewEmailInput] = useState("");

  // Google Sign-In gate — nothing else in the app renders until this is true.
  const [authed, setAuthed] = useState(false);
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

  useEffect(() => {
    const s = io(SERVER, { transports: ["websocket", "polling"] });
    s.on("connect", () => setMyId(s.id || ""));
    s.on("state", (x: AuctionState) => {
      setState(x);
      // Only move screens if the player is inside a room screen; if they chose to go
      // Home (Back button), don't yank them back on every timer tick.
      if (x.phase === "BIDDING") setScreen((prev) => (prev === "home" ? prev : "auction"));
      if (x.phase === "COMPLETE") setScreen((prev) => (prev === "home" ? prev : "results"));
      // "Play Again" resets the room to LOBBY — bounce everyone still on the
      // results screen back into the lobby to start the next round.
      if (x.phase === "LOBBY") setScreen((prev) => (prev === "results" ? "lobby" : prev));
    });
    s.on("siteConfig", (cfg: SiteConfig) => setSiteConfigState(cfg));
    s.on("authResult", (r: { ok: boolean; email?: string; name?: string; reason?: string }) => {
      if (r.ok) {
        setAuthed(true); setAuthEmail(r.email || ""); setAuthName(r.name || ""); setAuthError("");
      } else {
        setAuthed(false);
        setAuthError(
          r.reason === "not_allowed"
            ? `${r.email || "This Google account"} isn't approved yet. Ask the host to add it.`
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
    if (authed) return;
    let cancelled = false;
    let tries = 0;
    const tryInit = () => {
      if (cancelled) return;
      const g = (window as any).google;
      if (g?.accounts?.id && googleBtnRef.current) {
        g.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (resp: { credential: string }) => { socket?.emit("googleSignIn", { idToken: resp.credential }); },
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
  }, [authed, socket]);

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
    const names = Array.from({ length: teamCount }, (_, i) => teamNames[i] || `Team ${i + 1}`);
    socket?.emit("createRoom", {
      name: name || "Host", title, mode, budget, bidIncrement: increment, timerMax: timer,
      teamNames: names, characters: demoCharacters, limits: limitsDraft,
    });
    setScreen("lobby");
  }
  function join() {
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
    if (!ownerKey.trim()) return flash("Enter the owner key first.");
    const dataUrl = file ? await fileToDataUrl(file) : "";
    socket?.emit("setSiteConfig", { key: ownerKey.trim(), field, value: dataUrl });
  }

  // Owner-only, works right from the auction page: swaps one character's picture.
  // Needs the same owner key as Site Settings — not just "host" — and it sticks
  // on that character until the owner changes it again.
  async function changeCurrentCharacterImage(characterId: string, file: File | null) {
    if (!ownerKey.trim()) return flash("Enter the owner key (Site Settings) to change character images.");
    const dataUrl = file ? await fileToDataUrl(file) : "";
    socket?.emit("setCharacterImage", { key: ownerKey.trim(), characterId, image: dataUrl });
  }

  // Host-only: send everyone in the room back to the lobby with a clean slate —
  // same players, teams and character list — for another round.
  function playAgain() {
    if (!me?.isHost) return flash("Only the host can start a new round.");
    socket?.emit("resetRoom");
  }
  // Just steps back to the home screen, same as the browser Back button — the
  // room and your seat in it are untouched, so "Return to auction" still works.
  function exitGame() {
    setScreen("home");
  }

  function loadAllowedEmails() {
    if (!ownerKey.trim()) return flash("Enter the owner key first.");
    socket?.emit("listAllowedEmails", { key: ownerKey.trim() });
  }
  function addAllowedEmail() {
    if (!ownerKey.trim()) return flash("Enter the owner key first.");
    if (!newEmailInput.trim()) return flash("Enter an email to add.");
    socket?.emit("addAllowedEmail", { key: ownerKey.trim(), email: newEmailInput.trim() });
    setNewEmailInput("");
  }
  function removeAllowedEmail(email: string) {
    if (!ownerKey.trim()) return flash("Enter the owner key first.");
    socket?.emit("removeAllowedEmail", { key: ownerKey.trim(), email });
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
    socket?.emit("updateCharacters", [...state.characters, ...added]);
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
    socket?.emit("updateCharacters", [...state.characters, newChar]);
    setCharDraft(blankDraft(state.limits));
    flash(`${newChar.name} added to the auction pool.`);
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
    socket?.emit("updateCharacters", next);
    setEditingId(null);
    setEditDraft(null);
  }

  function removeCharacter(id: string) {
    if (!state) return;
    socket?.emit("updateCharacters", state.characters.filter((c) => c.id !== id));
    if (editingId === id) { setEditingId(null); setEditDraft(null); }
  }

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
        <button className="site-settings-trigger" title="Site owner settings" onClick={() => setShowSiteSettings((v) => !v)}>
          <Settings size={16} />
        </button>
      </div>
      {showSiteSettings && (
        <div className="site-settings-panel">
          <div className="site-settings-head">
            <small>OWNER ONLY — SITE CUSTOMIZATION</small>
            <button className="icon" onClick={() => setShowSiteSettings(false)}><X size={16} /></button>
          </div>
          <p className="muted small">Everything below is set once by you and stays exactly as you leave it — for everyone, in every room — until you change it again. Protected by your owner key.</p>
          <label>Owner key<input type="password" value={ownerKey} onChange={(e) => setOwnerKey(e.target.value)} placeholder="Enter your owner key" /></label>

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
        <small>REAL-TIME • MULTI-DEVICE • TEAM MODE</small>
        <h1>THE<br /><i>CHARACTER</i><br />AUCTION</h1>
        <p>Every friend joins from their own phone. Play as teams with a shared wallet, or go solo and bid head-to-head against your friends. Fully custom character roster — your images, your ability notes, your power scores, your value limits, your background.</p>
        <button className="primary" onClick={() => setScreen(state?.phase === "BIDDING" ? "auction" : state?.phase === "COMPLETE" ? "results" : "lobby")}>
          <Gavel /> {state?.phase === "BIDDING" ? "RETURN TO AUCTION" : state?.phase === "COMPLETE" ? "VIEW RESULTS" : "CREATE / JOIN GAME"}
        </button>
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
      <header className="top"><b>◆ CHARACTER AUCTION</b><span>{state?.roomCode || "NEW ROOM"}</span></header>
      <div className="grid">
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
                  Every friend who joins automatically gets their own individual wallet — great for head-to-head bidding wars, no pre-set teams needed.
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
              <div className="teams">
                {state.teams.map((t) => (
                  <div className="team" key={t.id}>
                    <b>{t.name}</b>
                    <span>{t.members.map((id) => state.players.find((p) => p.id === id)?.name).filter(Boolean).join(" • ") || "Waiting..."}</span>
                    <small>{money(t.budget - t.spent)} left</small>
                  </div>
                ))}
              </div>
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
              <button className={managerTab === "add" ? "tab active" : "tab"} onClick={() => setManagerTab("add")}><Plus size={14} /> Add</button>
              <button className={managerTab === "limits" ? "tab active" : "tab"} onClick={() => setManagerTab("limits")}><SlidersHorizontal size={14} /> Limits</button>
              <button className={managerTab === "theme" ? "tab active" : "tab"} onClick={() => setManagerTab("theme")}><Image size={14} /> Theme</button>
              <button className={managerTab === "list" ? "tab active" : "tab"} onClick={() => setManagerTab("list")}><Users size={14} /> Roster ({state.characters.length})</button>
            </div>
          </div>

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
                <label>Universe / category<input value={charDraft.universe} onChange={(e) => setCharDraft({ ...charDraft, universe: e.target.value })} placeholder="e.g. Marvel" /></label>
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
              <button className="primary full" onClick={() => addCharacter(null)}
                disabled={state.characters.length >= state.limits.maxCharacters}>
                <Plus /> ADD TO AUCTION POOL
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
                        <label>Universe<input value={editDraft.universe} onChange={(e) => setEditDraft({ ...editDraft, universe: e.target.value })} /></label>
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
              <small>{t.roster.length} won</small>
            </div>
          ))}
        </aside>
        <section>
          <div className="character">
            <div className="poster">
              {current.image ? <img src={current.image} alt={current.name} /> : <div className="initial">{current.name[0]}</div>}
              <div className="power-badge"><Sparkles size={14} /> {current.power}<small>/{state.limits.maxPower}</small></div>
              <label className="poster-edit" title="Owner only — change this character's image. Needs the owner key from Site Settings.">
                <Pencil size={13} />
                <input type="file" accept="image/*" onChange={(e) => changeCurrentCharacterImage(current.id, e.target.files?.[0] || null)} />
              </label>
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
                      <div className="won-card legendary-glow" key={i} style={{ animationDelay: `${i * 0.12}s` }}>
                        <MiniIcon c={h.character} size={44} />
                        <span>{h.character.name}</span>
                        <small>{money(h.amount)} • P{h.character.power}</small>
                      </div>
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
