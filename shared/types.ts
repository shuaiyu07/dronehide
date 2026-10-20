export type Vec3 = [number, number, number];

export type GameMode = "hide-and-seek" | "tactical-bomb";
export type MapSource = "procedural" | "glb" | "remote";
export type MapStatus = "draft" | "configured" | "published";
export type MapProvenanceType = "built-in" | "open-source" | "drone-sdk";
export type DroneMissionStatus = "planned" | "captured" | "model-ready";
export type PlayerRole = "attacker" | "defender" | "seeker" | "hider" | "spectator";
export type RoomStatus = "waiting" | "preparing" | "playing" | "ended";
export type DroneAbility = "recon" | "fpv";
export type TeamId = "alpha" | "bravo";

export interface DroneLoadout {
  recon: number;
  fpv: number;
}

export interface DroneScanTarget {
  id: string;
  name: string;
  position: Vec3;
  expiresAt: string;
}

export interface SpawnPoint {
  id: string;
  role: Exclude<PlayerRole, "spectator">;
  position: Vec3;
  rotation: Vec3;
}

export interface BombSiteConfig {
  id: string;
  name: string;
  center: Vec3;
  radius: number;
}

export interface ZoneConfig {
  id: string;
  name: string;
  center: Vec3;
  radius: number;
  kind: "hide" | "forbidden" | "safe";
}

export interface MapConfig {
  collisionBoxes?: Array<{ id: string; center: Vec3; size: Vec3 }>;
  mapId: string;
  gameMode: GameMode;
  spawnPoints: SpawnPoint[];
  zones: ZoneConfig[];
  bombSites?: BombSiteConfig[];
  bounds: {
    min: Vec3;
    max: Vec3;
  };
  rules: {
    prepareTime: number;
    gameTime: number;
    catchDistance: number;
    maxPlayers: number;
    roundsToWin?: number;
    bombTime?: number;
  };
}

export interface MapProvenance {
  type: MapProvenanceType;
  sourceUrl?: string;
  license?: string;
  attribution?: string;
  missionId?: string;
}

export interface DroneMission {
  id: string;
  name: string;
  provider: string;
  aircraftModel: string;
  cameraModel: string;
  captureDate: string;
  status: DroneMissionStatus;
  notes: string;
  createdAt: string;
}

export interface DroneSdkStatus {
  connected: boolean;
  mode: "simulated-bridge" | "device-bridge";
  provider: string;
  message: string;
}

export interface DroneMissionStatusUpdate {
  status: DroneMissionStatus;
}

export type ResourceAssetKind = "model" | "character" | "marker" | "effect" | "prop" | "sound" | "ui" | "texture";

export type PackageRuntimeFormat = "glb" | "gltf" | "json" | "image" | "audio" | "unknown";

export interface PackageFileRef {
  path: string;
  format: string;
}

export interface MapPackageManifest {
  kind: "map";
  schemaVersion: "1.0";
  id: string;
  name: string;
  version: string;
  author: string;
  license: string;
  description: string;
  sourceUrl?: string;
  attribution?: string;
  provenanceType?: Exclude<MapProvenanceType, "built-in">;
  missionId?: string;
  sourceFormats?: string[];
  runtimeFormat: PackageRuntimeFormat;
  scene: PackageFileRef;
  collision?: PackageFileRef;
  thumbnail?: PackageFileRef;
  config?: MapConfig;
}

export interface ResourcePackAsset {
  id: string;
  label: string;
  kind: ResourceAssetKind;
  path?: string;
  format?: string;
  sourceFormat?: string;
  tags?: string[];
  fallback: boolean;
}

export interface ResourcePackManifest {
  kind: "game-resources";
  schemaVersion: "1.0";
  id: string;
  name: string;
  version: string;
  author: string;
  license: string;
  description: string;
  sourceUrl?: string;
  sourceFormats?: string[];
  runtimeFormats?: PackageRuntimeFormat[];
  assets: ResourcePackAsset[];
}

export interface ResourcePackInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  license: string;
  description: string;
  sourceUrl?: string;
  builtIn: boolean;
  assets: ResourcePackAsset[];
  packageKind?: "game-resources";
  schemaVersion?: string;
  sourceFormats?: string[];
  runtimeFormats?: PackageRuntimeFormat[];
  baseUrl?: string;
}

export interface MapInfo {
  id: string;
  name: string;
  description: string;
  source: MapSource;
  modelUrl: string | null;
  thumbnailUrl: string | null;
  status: MapStatus;
  updatedAt: string;
  config: MapConfig;
  provenance: MapProvenance;
  package?: {
    id: string;
    version: string;
    schemaVersion: string;
    runtimeFormat: PackageRuntimeFormat;
    sourceFormats: string[];
    collisionUrl?: string;
  };
}

export interface PlayerState {
  teamId?: TeamId;
  id: string;
  name: string;
  role: PlayerRole;
  position: Vec3;
  rotation: Vec3;
  caught: boolean;
  droneLoadout?: DroneLoadout;
  health?: number;
  armor?: number;
  ammo?: number;
  reserveAmmo?: number;
  weaponId?: string;
  kills?: number;
  deaths?: number;
  hasBomb?: boolean;
  /** 服务器时间戳（毫秒）：换弹完成时间，用于换弹延迟表现 */
  reloadingUntil?: number;
}

export type FpvDroneState = "flying" | "destroyed";

/** 服务端权威的自爆穿越机实体：可飞行、可被击落、可引爆。 */
export interface FpvDroneEntity {
  id: string;
  ownerId: string;
  ownerName: string;
  position: Vec3;
  /** 每帧目标航向（yaw），由持有方客户端持续上报 */
  yaw: number;
  state: FpvDroneState;
  launchedAt: string;
  /** 服务器时间戳（毫秒）：自毁/燃料耗尽时间 */
  expiresAt: number;
  /** 服务器时间戳（毫秒）：可用 E 引爆的时间（起飞保护 1.5 秒） */
  armedAt: number;
  maxSpeed: number;
  blastRadius: number;
  damage: number;
}

/** 掉落在地上的炸弹，等待其他进攻方走近拾取。 */
export interface DroppedBomb {
  position: Vec3;
  droppedAt: string;
  /** 掉落归属回合，防止跨回合残留 */
  roundNumber: number;
}

export interface BombState {
  siteId: string;
  carrierId?: string;
  plantedAt?: string;
  explodesAt?: string;
  /** 已安装炸弹的位置（安装者安装时的坐标） */
  position?: Vec3;
  /** 服务端时间戳（毫秒）：拆弹完成时间 */
  defusingUntil?: number;
  defuserId?: string;
}

/** Killfeed 条目：由服务端产生，客户端只做展示。 */
export interface KillFeedEntry {
  id: string;
  roundNumber: number;
  attackerName: string;
  victimName: string;
  weapon: string;
  headshot: boolean;
  timestamp: string;
}

/** 回合胜负与比分。 */
export interface RoundScore {
  attackerWins: number;
  defenderWins: number;
}

export type RoundEndReason =
  | "bomb-exploded"
  | "bomb-defused"
  | "attackers-eliminated"
  | "defenders-eliminated"
  | "time-expired";

export interface RoomState {
  id: string;
  name: string;
  mapId: string;
  resourcePackBaseUrl?: string;
  status: RoomStatus;
  hostId?: string;
  players: PlayerState[];
  createdAt: string;
  roundNumber?: number;
  bomb?: BombState;
  /** 掉落在地上的炸弹（携带者死亡后） */
  droppedBomb?: DroppedBomb;
  /** 比分（先到 roundsToWin 胜） */
  score?: RoundScore;
  teamScore?: Record<TeamId, number>;
  roundWinnerTeamId?: TeamId;
  matchWinnerTeamId?: TeamId;
  /** 本场目标胜局数 */
  roundsToWin?: number;
  /** 回合间倒计时结束时间（服务器时间戳，毫秒） */
  nextRoundAt?: number;
  /** 单回合结束原因 */
  roundEndReason?: RoundEndReason;
  /** 存活的进攻方穿越机实体 */
  fpvDrones?: FpvDroneEntity[];
  killFeed?: KillFeedEntry[];
  preparingEndsAt?: string;
  startedAt?: string;
  endsAt?: string;
  winner?: "attacker" | "defender" | "seeker" | "hider" | "draw";
  resultMessage?: string;
}

export interface RoomSummary {
  id: string;
  name: string;
  mapId: string;
  resourcePackBaseUrl?: string;
  status: RoomStatus;
  hostId?: string;
  playerCount: number;
  createdAt: string;
}

export interface ApiHealth {
  ok: boolean;
  service: string;
  timestamp: string;
  version: string;
}
