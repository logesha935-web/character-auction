export type Character = {
  id: string;
  name: string;
  universe: string;
  basePrice: number;
  power: number;
  popularity: number;
  rarity: string;
  abilityNote: string;
  image?: string;
};

export type CharacterLimits = {
  maxCharacters: number;
  minValue: number;
  maxValue: number;
  maxPower: number;
};

export type Team = {
  id: string;
  name: string;
  members: string[];
  budget: number;
  spent: number;
  roster: Character[];
  color: string;
};

export type Player = {
  id: string;
  name: string;
  teamId: string;
  connected: boolean;
  isHost: boolean;
};

export type GameMode = "TEAM" | "SOLO";

export type SiteConfig = {
  background?: string;
  bgm?: string;
  soldSound?: string;
  queueSound?: string;
  trashSound?: string;
  heartbeatSound?: string;
};

export type SiteMediaField = "background" | "bgm" | "soldSound" | "queueSound" | "trashSound" | "heartbeatSound";

export type AuctionState = {
  roomCode: string;
  title: string;
  mode: GameMode;
  phase: "LOBBY" | "BIDDING" | "COMPLETE";
  players: Player[];
  teams: Team[];
  characters: Character[];
  limits: CharacterLimits;
  background?: string;
  round: number;
  unsoldQueue: Character[];
  finalUnsold: Character[];
  currentIndex: number;
  currentBid: number;
  currentBidderTeamId: string | null;
  bidIncrement: number;
  timer: number;
  timerMax: number;
  currentBidderPlayerId?: string | null;
  currentBidderName?: string | null;
  history: { character: Character; teamId: string; amount: number; playerId?: string; playerName?: string }[];
};
