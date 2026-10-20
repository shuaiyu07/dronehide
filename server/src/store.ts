import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoMap, demoMapConfig } from "../../shared/demoMap.ts";
import { warehouseFortressMap, warehouseObstacles } from "../../shared/warehouseMap.ts";
import { getCollisionBoxes, playerBlocked } from "../../shared/collision.ts";
import type { BombState, DroneAbility, DroneMission, FpvDroneEntity, KillFeedEntry, MapConfig, MapInfo, MapPackageManifest, MapProvenance, PackageRuntimeFormat, PlayerState, ResourceAssetKind, ResourcePackInfo, ResourcePackManifest, RoomState, RoomSummary, RoundEndReason, Vec3 } from "../../shared/types.ts";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.join(serverRoot, "data");
const mapsFile = path.join(dataRoot, "maps.json");
const missionsFile = path.join(dataRoot, "drone-missions.json");
const pluginRoot = path.join(serverRoot, "uploads", "plugins");

mkdirSync(dataRoot, { recursive: true });
mkdirSync(pluginRoot, { recursive: true });

function readCollection<T>(filePath: string, fallback: T[]) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

function writeCollection<T>(filePath: string, values: Iterable<T>) {
  writeFileSync(filePath, JSON.stringify([...values], null, 2), "utf8");
}

const persistedMaps = readCollection<MapInfo>(mapsFile, []);
if (!persistedMaps.some((map) => map.id === demoMap.id)) persistedMaps.unshift(demoMap);
if (!persistedMaps.some((map) => map.id === warehouseFortressMap.id)) persistedMaps.unshift(warehouseFortressMap);
const maps = new Map<string, MapInfo>(persistedMaps.map((map) => [map.id, map]));
const rooms = new Map<string, RoomState>();
const droneMissions = new Map<string, DroneMission>(readCollection<DroneMission>(missionsFile, []).map((mission) => [mission.id, mission]));

// ---------------------------------------------------------------------------
// 程序化地图碰撞缓存：warehouse-fortress 的 AABB 列表（服务端 hitscan / 移动碰撞）
// ---------------------------------------------------------------------------

export interface CollisionAabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

const collisionCache = new Map<string, CollisionAabb[]>();

function obstaclesForMap(mapId: string): CollisionAabb[] {
  const config = maps.get(mapId)?.config;
  if (config) return getCollisionBoxes(config);
  const cached = collisionCache.get(mapId);
  if (cached) return cached;
  let boxes: CollisionAabb[] = [];
  if (mapId === warehouseFortressMap.id) {
    boxes = warehouseObstacles().map((box) => {
      const [cx, cy, cz] = box.center;
      const [sx, sy, sz] = box.size;
      return {
        minX: cx - sx / 2, maxX: cx + sx / 2,
        minY: cy - sy / 2, maxY: cy + sy / 2,
        minZ: cz - sz / 2, maxZ: cz + sz / 2,
      };
    });
  }
  collisionCache.set(mapId, boxes);
  return boxes;
}

/** 射线与 AABB 求交（slab 法）。命中返回距离，否则返回 null。 */
export function rayAabbDistance(
  origin: Vec3,
  dir: Vec3,
  box: CollisionAabb,
  maxDistance: number,
): number | null {
  let tMin = 0;
  let tMax = maxDistance;
  const o = [origin[0], origin[1], origin[2]];
  const d = [dir[0], dir[1], dir[2]];
  const bMin = [box.minX, box.minY, box.minZ];
  const bMax = [box.maxX, box.maxY, box.maxZ];
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(d[axis]) < 1e-9) {
      if (o[axis] < bMin[axis] || o[axis] > bMax[axis]) return null;
      continue;
    }
    const inverse = 1 / d[axis];
    let t1 = (bMin[axis] - o[axis]) * inverse;
    let t2 = (bMax[axis] - o[axis]) * inverse;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin;
}

/** 地图障碍物沿射线方向的最近遮挡距离；无遮挡返回 maxDistance。 */
export function mapRayBlockDistance(mapId: string, origin: Vec3, dir: Vec3, maxDistance: number): number {
  let blocked = maxDistance;
  for (const box of obstaclesForMap(mapId)) {
    const hit = rayAabbDistance(origin, dir, box, blocked);
    if (hit !== null && hit < blocked) blocked = hit;
  }
  return blocked;
}

/** 点是否在任何障碍盒内（含半径膨胀，用于移动碰撞）。 */
export function pointBlocked(mapId: string, x: number, z: number, y: number, radius: number): boolean {
  for (const box of obstaclesForMap(mapId)) {
    if (
      x + radius > box.minX && x - radius < box.maxX &&
      z + radius > box.minZ && z - radius < box.maxZ &&
      y > box.minY && y - 1.7 < box.maxY
    ) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 战斗参数
// ---------------------------------------------------------------------------

const FIRE_COOLDOWN_MS = 130;      // 射击冷却（≈461 RPM，步枪手感）
const RELOAD_DURATION_MS = 2200;   // 换弹 2.2 秒
const BOMB_DEFUSE_MS = 5000;       // 拆弹 5 秒
const FPV_ARM_DELAY_MS = 1500;     // 穿越机起飞保护
const FPV_LIFETIME_MS = 16000;     // 穿越机燃料 16 秒
const FPV_MAX_SPEED = 14;          // 穿越机限速 m/s（悬停风格）
const FPV_BLAST_RADIUS = 7;
const FPV_DAMAGE = 120;
const DRONE_HITBOX_HALF = 0.8;     // 穿越机命中判定半径（客户端视觉约 0.5m）
const BOMB_PICKUP_RADIUS = 2.2;    // 掉落炸弹拾取半径

interface CombatTimestamps {
  lastFireAt: number;
  reloadUntil: number;
}

const combatTimers = new Map<string, CombatTimestamps>();

function combatFor(playerId: string): CombatTimestamps {
  let entry = combatTimers.get(playerId);
  if (!entry) {
    entry = { lastFireAt: 0, reloadUntil: 0 };
    combatTimers.set(playerId, entry);
  }
  return entry;
}

function forgetCombat(playerId: string) {
  combatTimers.delete(playerId);
}

// ---------------------------------------------------------------------------
// 地图 CRUD（保持原有接口）
// ---------------------------------------------------------------------------

function createDefaultMapConfig(mapId: string): MapConfig {
  return {
    ...demoMapConfig,
    mapId,
    spawnPoints: demoMapConfig.spawnPoints.map((point) => ({ ...point, position: [...point.position] as MapConfig["spawnPoints"][number]["position"], rotation: [...point.rotation] as MapConfig["spawnPoints"][number]["rotation"] })),
    zones: demoMapConfig.zones.map((zone) => ({ ...zone, center: [...zone.center] as MapConfig["zones"][number]["center"] })),
    bounds: {
      min: [...demoMapConfig.bounds.min] as MapConfig["bounds"]["min"],
      max: [...demoMapConfig.bounds.max] as MapConfig["bounds"]["max"],
    },
    rules: { ...demoMapConfig.rules },
  };
}

export function listMaps() {
  return [...maps.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getMap(mapId: string) {
  return maps.get(mapId);
}

export function createImportedMap(input: {
  name: string;
  description: string;
  modelUrl: string;
  provenance: MapProvenance;
  package?: MapInfo["package"];
}) {
  const id = `map-${randomUUID().slice(0, 8)}`;
  const map: MapInfo = {
    id,
    name: input.name,
    description: input.description,
    source: "glb",
    modelUrl: input.modelUrl,
    thumbnailUrl: null,
    status: "draft",
    updatedAt: new Date().toISOString(),
    provenance: input.provenance,
    ...(input.package ? { package: input.package } : {}),
    config: createDefaultMapConfig(id),
  };
  maps.set(id, map);
  writeCollection(mapsFile, maps.values());
  return map;
}

export function createLocalMap(input: {
  name: string;
  description: string;
  modelUrl: string;
  provenance: MapProvenance;
}) {
  return createImportedMap(input);
}

function isRuntimeFormat(value: unknown): value is PackageRuntimeFormat {
  return value === "glb" || value === "gltf" || value === "json" || value === "image" || value === "audio" || value === "unknown";
}

function isSafePackageId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{1,63}$/i.test(value);
}

function isPackageFileRef(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.path === "string" && Boolean(candidate.path.trim()) && typeof candidate.format === "string" && Boolean(candidate.format.trim());
}

export function validateMapPackageManifest(value: unknown): string | null {
  if (!value || typeof value !== "object") return "地图包 manifest 必须是 JSON 对象";
  const manifest = value as Partial<MapPackageManifest>;
  if (manifest.kind !== "map" || manifest.schemaVersion !== "1.0") return "地图包必须使用 kind=map、schemaVersion=1.0";
  if (!isSafePackageId(manifest.id)) return "地图包 id 只能包含字母、数字、点、下划线和短横线";
  if (typeof manifest.name !== "string" || !manifest.name.trim() || typeof manifest.version !== "string" || !manifest.version.trim() || typeof manifest.description !== "string") return "地图包必须填写名称、版本和说明";
  if (typeof manifest.author !== "string" || !manifest.author.trim() || typeof manifest.license !== "string" || !manifest.license.trim()) return "地图包必须填写作者和许可证";
  if (!isRuntimeFormat(manifest.runtimeFormat) || !isPackageFileRef(manifest.scene)) return "地图包必须声明有效的运行格式和 scene 文件";
  if (manifest.sourceFormats !== undefined && (!Array.isArray(manifest.sourceFormats) || !manifest.sourceFormats.every((item) => typeof item === "string" && item.trim()))) return "地图包 sourceFormats 格式无效";
  if (manifest.provenanceType !== undefined && !["open-source", "drone-sdk"].includes(manifest.provenanceType)) return "地图包来源类型无效";
  if (manifest.collision !== undefined && !isPackageFileRef(manifest.collision)) return "地图包 collision 文件引用无效";
  if (manifest.thumbnail !== undefined && !isPackageFileRef(manifest.thumbnail)) return "地图包 thumbnail 文件引用无效";
  return null;
}

export function createMapPackage(input: {
  manifest: MapPackageManifest;
  sceneUrl: string;
  collisionUrl?: string;
  thumbnailUrl?: string;
}) {
  const mapId = `map-${randomUUID().slice(0, 8)}`;
  let config = createDefaultMapConfig(mapId);
  if (input.manifest.config) {
    const candidate = { ...input.manifest.config, mapId };
    const validationError = validateMapConfig(candidate, mapId);
    if (validationError) throw new Error(`地图包中的游戏配置无效：${validationError}`);
    config = candidate;
  }
  const runtimeSupported = input.manifest.runtimeFormat === "glb" || input.manifest.runtimeFormat === "gltf";
  const map: MapInfo = {
    id: mapId,
    name: input.manifest.name.slice(0, 80),
    description: input.manifest.description.slice(0, 300) || "通过 .dhmap 规范导入的三维地图",
    source: "glb",
    modelUrl: runtimeSupported ? input.sceneUrl : null,
    thumbnailUrl: input.thumbnailUrl ?? null,
    status: "draft",
    updatedAt: new Date().toISOString(),
    provenance: {
      type: input.manifest.provenanceType ?? "open-source",
      ...(input.manifest.sourceUrl ? { sourceUrl: input.manifest.sourceUrl } : {}),
      license: input.manifest.license,
      ...(input.manifest.attribution ? { attribution: input.manifest.attribution } : {}),
      ...(input.manifest.missionId ? { missionId: input.manifest.missionId } : {}),
    },
    package: {
      id: input.manifest.id,
      version: input.manifest.version,
      schemaVersion: input.manifest.schemaVersion,
      runtimeFormat: input.manifest.runtimeFormat,
      sourceFormats: input.manifest.sourceFormats ?? [input.manifest.scene.format],
      ...(input.collisionUrl ? { collisionUrl: input.collisionUrl } : {}),
    },
    config,
  };
  maps.set(map.id, map);
  writeCollection(mapsFile, maps.values());
  return map;
}

export function createRemoteMap(input: {
  name: string;
  description: string;
  modelUrl: string;
  provenance: MapProvenance;
}) {
  const id = `map-${randomUUID().slice(0, 8)}`;
  const map: MapInfo = {
    id,
    name: input.name,
    description: input.description,
    source: "remote",
    modelUrl: input.modelUrl,
    thumbnailUrl: null,
    status: "draft",
    updatedAt: new Date().toISOString(),
    provenance: input.provenance,
    config: createDefaultMapConfig(id),
  };
  maps.set(id, map);
  writeCollection(mapsFile, maps.values());
  return map;
}

export function updateMapModelSource(mapId: string, source: MapInfo["source"], modelUrl: string) {
  const map = maps.get(mapId);
  if (!map) return undefined;
  map.source = source;
  map.modelUrl = modelUrl;
  map.updatedAt = new Date().toISOString();
  maps.set(mapId, map);
  writeCollection(mapsFile, maps.values());
  return map;
}

export function validateMapConfig(config: unknown, mapId: string) {
  if (!config || typeof config !== "object") return "缺少地图配置";
  const candidate = config as Partial<MapConfig>;
  if (candidate.mapId !== mapId) return "地图配置与地图 ID 不一致";
  if (candidate.gameMode !== "hide-and-seek" && candidate.gameMode !== "tactical-bomb") return "游戏模式无效";

  const isVec3 = (value: unknown): value is [number, number, number] =>
    Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item));
  const bounds = candidate.bounds;
  if (!bounds || !isVec3(bounds.min) || !isVec3(bounds.max) || bounds.min.some((value, index) => value >= bounds.max![index])) {
    return "地图边界必须是有效的 min / max 三维坐标";
  }

  const spawnPoints = candidate.spawnPoints;
  if (!Array.isArray(spawnPoints) || spawnPoints.length < 2) return "至少需要一个寻找者出生点和一个躲藏者出生点";
  const spawnIds = new Set<string>();
  for (const point of spawnPoints) {
    if (!point || typeof point.id !== "string" || !point.id.trim() || spawnIds.has(point.id)) return "出生点 ID 不能为空且不能重复";
    const validRole = candidate.gameMode === "tactical-bomb"
      ? point.role === "attacker" || point.role === "defender"
      : point.role === "seeker" || point.role === "hider";
    if (!validRole) return candidate.gameMode === "tactical-bomb" ? "战术爆破出生点角色只能是进攻方或防守方" : "出生点角色只能是寻找者或躲藏者";
    if (!isVec3(point.position) || !isVec3(point.rotation)) return "出生点坐标或旋转值无效";
    if (point.position.some((value, index) => value < bounds.min![index] || value > bounds.max![index])) return "出生点必须位于地图边界内";
    spawnIds.add(point.id);
  }
  const requiredRoles = candidate.gameMode === "tactical-bomb" ? ["attacker", "defender"] : ["seeker", "hider"];
  if (!requiredRoles.every((role) => spawnPoints.some((point) => point.role === role))) {
    return candidate.gameMode === "tactical-bomb" ? "至少需要一个进攻方出生点和一个防守方出生点" : "至少需要一个寻找者出生点和一个躲藏者出生点";
  }

  if (!Array.isArray(candidate.zones)) return "区域配置格式无效";
  const zoneIds = new Set<string>();
  for (const zone of candidate.zones) {
    if (!zone || typeof zone.id !== "string" || !zone.id.trim() || zoneIds.has(zone.id)) return "区域 ID 不能为空且不能重复";
    if (typeof zone.name !== "string" || !zone.name.trim() || !isVec3(zone.center) || typeof zone.radius !== "number" || !Number.isFinite(zone.radius) || zone.radius <= 0) return "区域名称、中心点或半径无效";
    if (!["hide", "forbidden", "safe"].includes(zone.kind)) return "区域类型无效";
    zoneIds.add(zone.id);
  }

  if (candidate.gameMode === "tactical-bomb") {
    if (!Array.isArray(candidate.bombSites) || candidate.bombSites.length < 1) return "战术爆破地图至少需要一个爆破点";
    const siteIds = new Set<string>();
    for (const site of candidate.bombSites) {
      if (!site || typeof site.id !== "string" || !site.id.trim() || siteIds.has(site.id) || typeof site.name !== "string" || !site.name.trim() || !isVec3(site.center) || typeof site.radius !== "number" || !Number.isFinite(site.radius) || site.radius <= 0) return "爆破点配置无效";
      siteIds.add(site.id);
    }
  }

  const rules = candidate.rules;
  if (candidate.collisionBoxes !== undefined) {
    if (!Array.isArray(candidate.collisionBoxes) || candidate.collisionBoxes.length > 256) return "碰撞盒数量不能超过 256";
    const ids = new Set<string>();
    for (const box of candidate.collisionBoxes) {
      if (!box || typeof box.id !== "string" || !box.id.trim() || ids.has(box.id) || !isVec3(box.center) || !isVec3(box.size) || box.size.some((size) => size < 0.1 || size > 1000)) return "碰撞盒 ID、中心或尺寸无效";
      ids.add(box.id);
    }
    const boxes = getCollisionBoxes(candidate as MapConfig);
    if (spawnPoints.some((point) => playerBlocked(boxes, point.position))) return "出生点不能位于碰撞盒内部";
  }
  if (!rules || !Number.isFinite(rules.prepareTime) || rules.prepareTime < 5 || rules.prepareTime > 600 || !Number.isFinite(rules.gameTime) || rules.gameTime < 30 || rules.gameTime > 3600 || !Number.isFinite(rules.catchDistance) || rules.catchDistance < 0.5 || rules.catchDistance > 20 || !Number.isInteger(rules.maxPlayers) || rules.maxPlayers < 2 || rules.maxPlayers > 32) {
    return "游戏规则范围无效：准备 5-600 秒、游戏 30-3600 秒、抓捕距离 0.5-20、人数 2-32";
  }
  if (rules.roundsToWin !== undefined && (!Number.isInteger(rules.roundsToWin) || rules.roundsToWin < 1 || rules.roundsToWin > 15)) return "胜利所需回合数范围无效";
  if (rules.bombTime !== undefined && (!Number.isFinite(rules.bombTime) || rules.bombTime < 10 || rules.bombTime > 180)) return "炸弹倒计时范围无效：10-180 秒";
  return null;
}

export function updateMapConfig(mapId: string, config: MapConfig) {
  const map = maps.get(mapId);
  if (!map) return undefined;
  map.config = {
    ...config,
    mapId,
    ...(config.collisionBoxes ? { collisionBoxes: structuredClone(config.collisionBoxes) } : {}),
    ...(config.bombSites ? { bombSites: structuredClone(config.bombSites) } : {}),
    spawnPoints: config.spawnPoints.map((point) => ({ ...point, position: [...point.position] as MapConfig["spawnPoints"][number]["position"], rotation: [...point.rotation] as MapConfig["spawnPoints"][number]["rotation"] })),
    zones: config.zones.map((zone) => ({ ...zone, center: [...zone.center] as MapConfig["zones"][number]["center"] })),
    bounds: { min: [...config.bounds.min] as MapConfig["bounds"]["min"], max: [...config.bounds.max] as MapConfig["bounds"]["max"] },
    rules: { ...config.rules },
  };
  map.status = "configured";
  map.updatedAt = new Date().toISOString();
  maps.set(mapId, map);
  writeCollection(mapsFile, maps.values());
  return map;
}

export function listDroneMissions() {
  return [...droneMissions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getDroneMission(missionId: string) {
  return droneMissions.get(missionId);
}

export function createDroneMission(input: Omit<DroneMission, "id" | "createdAt">) {
  const mission: DroneMission = {
    ...input,
    id: `mission-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
  };
  droneMissions.set(mission.id, mission);
  writeCollection(missionsFile, droneMissions.values());
  return mission;
}

export function updateDroneMissionStatus(missionId: string, status: DroneMission["status"]) {
  const mission = droneMissions.get(missionId);
  if (!mission) return undefined;
  mission.status = status;
  droneMissions.set(missionId, mission);
  writeCollection(missionsFile, droneMissions.values());
  return mission;
}

function isResourceAssetKind(value: unknown): value is ResourceAssetKind {
  return value === "model" || value === "character" || value === "marker" || value === "effect" || value === "prop" || value === "sound" || value === "ui" || value === "texture";
}

function readResourcePack(manifestPath: string): ResourcePackInfo | undefined {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.version !== "string") return undefined;
    const assets = Array.isArray(raw.assets) ? raw.assets.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const asset = candidate as Record<string, unknown>;
      if (typeof asset.id !== "string" || typeof asset.label !== "string" || !isResourceAssetKind(asset.kind)) return [];
      return [{
        id: asset.id,
        label: asset.label,
        kind: asset.kind,
        ...(typeof asset.path === "string" && asset.path ? { path: asset.path } : {}),
        ...(typeof asset.format === "string" && asset.format ? { format: asset.format } : {}),
        ...(typeof asset.sourceFormat === "string" && asset.sourceFormat ? { sourceFormat: asset.sourceFormat } : {}),
        ...(Array.isArray(asset.tags) && asset.tags.every((tag) => typeof tag === "string") ? { tags: asset.tags as string[] } : {}),
        fallback: asset.fallback === true,
      }];
    }) : [];
    return {
      id: raw.id,
      name: raw.name,
      version: raw.version,
      author: typeof raw.author === "string" ? raw.author : "未填写作者",
      license: typeof raw.license === "string" ? raw.license : "未填写许可证",
      description: typeof raw.description === "string" ? raw.description : "未提供资源包说明",
      ...(typeof raw.sourceUrl === "string" && raw.sourceUrl ? { sourceUrl: raw.sourceUrl } : {}),
      builtIn: raw.builtIn === true,
      assets,
      ...(raw.kind === "game-resources" ? { packageKind: "game-resources" as const } : {}),
      ...(typeof raw.schemaVersion === "string" ? { schemaVersion: raw.schemaVersion } : {}),
      ...(Array.isArray(raw.sourceFormats) && raw.sourceFormats.every((item) => typeof item === "string") ? { sourceFormats: raw.sourceFormats as string[] } : {}),
      ...(Array.isArray(raw.runtimeFormats) && raw.runtimeFormats.every(isRuntimeFormat) ? { runtimeFormats: raw.runtimeFormats as PackageRuntimeFormat[] } : {}),
    };
  } catch {
    return undefined;
  }
}

export function listResourcePacks() {
  return readdirSync(pluginRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const manifestPath = path.join(pluginRoot, entry.name, "manifest.json");
      try {
        const pack = statSync(manifestPath).isFile() ? readResourcePack(manifestPath) : undefined;
        return pack ? [{ ...pack, baseUrl: `/uploads/plugins/${encodeURIComponent(entry.name)}` }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.name.localeCompare(b.name));
}

export function validateResourcePackManifest(value: unknown): string | null {
  if (!value || typeof value !== "object") return "资源包 manifest 必须是 JSON 对象";
  const manifest = value as Partial<ResourcePackManifest>;
  if (manifest.kind !== "game-resources" || manifest.schemaVersion !== "1.0") return "资源包必须使用 kind=game-resources、schemaVersion=1.0";
  if (!isSafePackageId(manifest.id)) return "资源包 id 只能包含字母、数字、点、下划线和短横线";
  if (typeof manifest.name !== "string" || !manifest.name.trim() || typeof manifest.version !== "string" || !manifest.version.trim() || typeof manifest.description !== "string") return "资源包必须填写名称、版本和说明";
  if (typeof manifest.author !== "string" || !manifest.author.trim() || typeof manifest.license !== "string" || !manifest.license.trim()) return "资源包必须填写作者和许可证";
  if (!Array.isArray(manifest.assets)) return "资源包 assets 必须是数组";
  const ids = new Set<string>();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset !== "object") return "资源包包含无效资源项";
    if (typeof asset.id !== "string" || !asset.id.trim() || ids.has(asset.id)) return "资源项 id 不能为空且不能重复";
    if (typeof asset.label !== "string" || !asset.label.trim() || !isResourceAssetKind(asset.kind)) return "资源项必须填写名称和有效类型";
    if (asset.path !== undefined && typeof asset.path !== "string") return "资源项 path 格式无效";
    ids.add(asset.id);
  }
  if (manifest.sourceFormats !== undefined && (!Array.isArray(manifest.sourceFormats) || !manifest.sourceFormats.every((item) => typeof item === "string" && item.trim()))) return "资源包 sourceFormats 格式无效";
  if (manifest.runtimeFormats !== undefined && (!Array.isArray(manifest.runtimeFormats) || !manifest.runtimeFormats.every(isRuntimeFormat))) return "资源包 runtimeFormats 格式无效";
  return null;
}

// ---------------------------------------------------------------------------
// 房间与回合状态机
// ---------------------------------------------------------------------------

export function listRooms(): RoomSummary[] {
  return [...rooms.values()].map((room) => ({
    id: room.id,
    name: room.name,
    mapId: room.mapId,
    resourcePackBaseUrl: room.resourcePackBaseUrl,
    status: room.status,
    hostId: room.hostId,
    playerCount: room.players.length,
    createdAt: room.createdAt,
  }));
}

export function getRoom(roomId: string) {
  return rooms.get(roomId);
}

export function createRoom(name: string, mapId: string, resourcePackBaseUrl?: string): RoomState {
  const room: RoomState = {
    id: randomUUID().slice(0, 8).toUpperCase(),
    name,
    mapId,
    ...(resourcePackBaseUrl ? { resourcePackBaseUrl } : {}),
    status: "waiting",
    players: [],
    createdAt: new Date().toISOString(),
  };
  rooms.set(room.id, room);
  return room;
}

export function addPlayer(roomId: string, player: PlayerState) {
  const room = rooms.get(roomId);
  if (!room) return undefined;
  if (!room.hostId) room.hostId = player.id;
  room.players = [...room.players.filter((item) => item.id !== player.id), player];
  return room;
}

export function consumeDroneCharge(roomId: string, playerId: string, ability: DroneAbility) {
  const room = rooms.get(roomId);
  const player = room?.players.find((item) => item.id === playerId);
  if (!room || !player || !player.droneLoadout || player.droneLoadout[ability] <= 0) return false;
  room.players = room.players.map((item) => item.id === playerId
    ? { ...item, droneLoadout: { ...item.droneLoadout!, [ability]: item.droneLoadout![ability] - 1 } }
    : item);
  return true;
}

export function updatePlayer(roomId: string, playerId: string, patch: Partial<PlayerState>) {
  const room = rooms.get(roomId);
  if (!room) return undefined;
  room.players = room.players.map((player) =>
    player.id === playerId ? { ...player, ...patch } : player,
  );
  return room;
}

export function removePlayer(roomId: string, playerId: string) {
  const room = rooms.get(roomId);
  if (!room) return undefined;
  const player = room.players.find((item) => item.id === playerId);
  if (player?.hasBomb && !room.bomb?.plantedAt && room.status === "playing") {
    room.droppedBomb = {
      position: [...player.position] as Vec3,
      droppedAt: new Date().toISOString(),
      roundNumber: room.roundNumber ?? 1,
    };
    if (room.bomb) delete room.bomb.carrierId;
  }
  if (room.bomb?.defuserId === playerId) cancelDefuse(roomId);
  forgetCombat(playerId);
  room.fpvDrones = (room.fpvDrones ?? []).filter((drone) => drone.ownerId !== playerId);
  room.players = room.players.filter((player) => player.id !== playerId);
  if (room.hostId === playerId) room.hostId = room.players[0]?.id;
  return room;
}

export function setRoomStatus(roomId: string, status: RoomState["status"]) {
  const room = rooms.get(roomId);
  if (!room) return undefined;
  room.status = status;
  return room;
}

function pickSpawn(spawnPoints: MapConfig["spawnPoints"], role: PlayerState["role"], index: number) {
  const matching = spawnPoints.filter((point) => point.role === role);
  if (matching.length > 0) return matching[index % matching.length];
  return spawnPoints[index % spawnPoints.length];
}

function assignRolesAndSpawn(room: RoomState, map: MapInfo, swapSides: boolean) {
  for (const player of room.players) forgetCombat(player.id);
  if (map.config.gameMode === "tactical-bomb") {
    const attackerCount = Math.max(1, Math.ceil(room.players.length / 2));
    let bombCarrierId: string | undefined;
    room.players = room.players.map((player, index) => {
      const teamId = player.teamId ?? (index < attackerCount ? "alpha" : "bravo");
      const rawRole = teamId === "alpha" ? "attacker" : "defender";
      const role = swapSides ? (rawRole === "attacker" ? "defender" : "attacker") : rawRole;
      const spawn = pickSpawn(map.config.spawnPoints, role, swapSides ? room.players.length - 1 - index : index);
      const hasBomb = role === "attacker" && !bombCarrierId;
      if (hasBomb) bombCarrierId = player.id;
      return {
        ...player,
        teamId,
        role,
        position: spawn?.position ?? player.position,
        rotation: spawn?.rotation ?? player.rotation,
        caught: false,
        health: 100,
        armor: 50,
        ammo: 30,
        reserveAmmo: 90,
        weaponId: "rifle",
        reloadingUntil: undefined,
        kills: player.kills ?? 0,
        deaths: player.deaths ?? 0,
        hasBomb,
        droneLoadout: { recon: 2, fpv: 1 },
      };
    });
    room.bomb = { siteId: map.config.bombSites?.[0]?.id ?? "site-a", carrierId: bombCarrierId };
    return;
  }

  let seekerAssigned = false;
  const spawnPoints = map.config.spawnPoints;
  room.players = room.players.map((player, index) => {
    const shouldSeek = !seekerAssigned && (player.role !== "spectator" || index === 0);
    if (shouldSeek) seekerAssigned = true;
    const role = shouldSeek ? "seeker" : "hider";
    const spawn = spawnPoints.find((point) => point.role === role) ?? spawnPoints[index % spawnPoints.length];
    return {
      ...player,
      role,
      position: spawn?.position ?? player.position,
      rotation: spawn?.rotation ?? player.rotation,
      caught: false,
      droneLoadout: shouldSeek ? { recon: 1, fpv: 1 } : { recon: 0, fpv: 0 },
    };
  });
}

export function prepareGame(roomId: string) {
  const room = rooms.get(roomId);
  const map = room ? maps.get(room.mapId) : undefined;
  if (!room || !map || room.status !== "waiting" || room.players.length < 2) return undefined;

  room.score = { attackerWins: 0, defenderWins: 0 };
  room.teamScore = { alpha: 0, bravo: 0 };
  room.players = room.players.map((player) => ({ ...player, teamId: undefined, kills: 0, deaths: 0 }));
  delete room.roundWinnerTeamId;
  delete room.matchWinnerTeamId;
  room.roundsToWin = Math.max(1, map.config.rules.roundsToWin ?? 1);
  room.killFeed = [];
  room.fpvDrones = [];
  delete room.roundEndReason;
  delete room.nextRoundAt;
  assignRolesAndSpawn(room, map, false);
  room.roundNumber = 1;
  room.status = "preparing";
  room.preparingEndsAt = new Date(Date.now() + map.config.rules.prepareTime * 1000).toISOString();
  delete room.startedAt;
  delete room.endsAt;
  delete room.winner;
  delete room.resultMessage;
  return room;
}

/** 回合结算：记录比分并进入 "ended"（等待下一回合或全场结束）。 */
export function finishRound(roomId: string, winner: "attacker" | "defender", reason: RoundEndReason, message: string) {
  const room = rooms.get(roomId);
  if (!room || room.status !== "playing") return undefined;
  const score = room.score ?? { attackerWins: 0, defenderWins: 0 };
  if (winner === "attacker") score.attackerWins += 1;
  else score.defenderWins += 1;
  room.score = score;
  const swapped = Math.floor(((room.roundNumber ?? 1) - 1) / 2) % 2 === 1;
  const winnerTeam = winner === "attacker" ? (swapped ? "bravo" : "alpha") : (swapped ? "alpha" : "bravo");
  const teamScore = room.teamScore ?? { alpha: 0, bravo: 0 };
  teamScore[winnerTeam] += 1;
  room.teamScore = teamScore;
  room.roundWinnerTeamId = winnerTeam;
  room.status = "ended";
  room.winner = winner;
  room.resultMessage = message;
  room.roundEndReason = reason;
  for (const player of room.players) forgetCombat(player.id);
  room.players = room.players.map((player) => ({ ...player, reloadingUntil: undefined }));
  room.fpvDrones = [];
  delete room.bomb?.plantedAt;
  delete room.bomb?.explodesAt;
  delete room.bomb?.defusingUntil;
  delete room.droppedBomb;
  const roundsToWin = room.roundsToWin ?? 1;
  const matchOver = teamScore.alpha >= roundsToWin || teamScore.bravo >= roundsToWin;
  if (matchOver) room.matchWinnerTeamId = winnerTeam;
  else delete room.matchWinnerTeamId;
  if (!matchOver) room.nextRoundAt = Date.now() + 6000;
  else delete room.nextRoundAt;
  return room;
}

/** ended -> 下一回合 preparing（攻防互换由调用方决定）。 */
export function startNextRound(roomId: string) {
  const room = rooms.get(roomId);
  const map = room ? maps.get(room.mapId) : undefined;
  if (!room || !map || room.status !== "ended" || room.nextRoundAt === undefined) return undefined;
  const score = room.teamScore ?? { alpha: 0, bravo: 0 };
  const roundsToWin = room.roundsToWin ?? 1;
  if (score.alpha >= roundsToWin || score.bravo >= roundsToWin || room.players.length < 2) return undefined;

  room.roundNumber = (room.roundNumber ?? 1) + 1;
  const swapSides = Math.floor((room.roundNumber - 1) / 2) % 2 === 1;
  delete room.roundWinnerTeamId;
  assignRolesAndSpawn(room, map, swapSides);
  room.status = "preparing";
  room.preparingEndsAt = new Date(Date.now() + map.config.rules.prepareTime * 1000).toISOString();
  room.fpvDrones = [];
  room.bomb = { siteId: map.config.bombSites?.[0]?.id ?? "site-a", carrierId: room.players.find((player) => player.role === "attacker")?.id };
  delete room.startedAt;
  delete room.endsAt;
  delete room.winner;
  delete room.resultMessage;
  delete room.roundEndReason;
  delete room.nextRoundAt;
  delete room.droppedBomb;
  return room;
}

export function beginGame(roomId: string) {
  const room = rooms.get(roomId);
  const map = room ? maps.get(room.mapId) : undefined;
  if (!room || !map || room.status !== "preparing" || room.players.length < 2) return undefined;

  const startedAt = new Date();
  room.status = "playing";
  room.startedAt = startedAt.toISOString();
  room.endsAt = new Date(startedAt.getTime() + map.config.rules.gameTime * 1000).toISOString();
  delete room.preparingEndsAt;
  delete room.winner;
  delete room.resultMessage;
  return room;
}

export function cancelPreparation(roomId: string) {
  const room = rooms.get(roomId);
  if (!room || (room.status !== "preparing" && room.status !== "ended")) return undefined;
  for (const player of room.players) forgetCombat(player.id);
  room.status = "waiting";
  room.players = room.players.map((player) => ({ ...player, role: "spectator", caught: false, health: undefined, armor: undefined, ammo: undefined, hasBomb: false }));
  delete room.bomb;
  delete room.preparingEndsAt;
  delete room.startedAt;
  delete room.endsAt;
  delete room.roundNumber;
  delete room.score;
  delete room.teamScore;
  delete room.roundWinnerTeamId;
  delete room.matchWinnerTeamId;
  room.players = room.players.map((player) => ({ ...player, teamId: undefined, reloadingUntil: undefined }));
  delete room.nextRoundAt;
  delete room.droppedBomb;
  room.fpvDrones = [];
  return room;
}

export function endGame(roomId: string, winner: RoomState["winner"], resultMessage: string) {
  const room = rooms.get(roomId);
  if (!room) return undefined;
  room.status = "ended";
  room.winner = winner;
  room.resultMessage = resultMessage;
  delete room.nextRoundAt;
  room.fpvDrones = [];
  return room;
}

export function catchNearbyHiders(roomId: string, seekerId: string, catchDistance: number) {
  const room = rooms.get(roomId);
  if (!room || room.status !== "playing") return { room, caughtIds: [] as string[] };
  const seeker = room.players.find((player) => player.id === seekerId && player.role === "seeker");
  if (!seeker) return { room, caughtIds: [] as string[] };
  const catchDistanceSquared = catchDistance * catchDistance;
  const caughtIds = room.players
    .filter((player) => player.role === "hider" && !player.caught)
    .filter((player) => {
      const dx = player.position[0] - seeker.position[0];
      const dz = player.position[2] - seeker.position[2];
      return dx * dx + dz * dz <= catchDistanceSquared;
    })
    .map((player) => player.id);

  if (caughtIds.length > 0) {
    room.players = room.players.map((player) => caughtIds.includes(player.id) ? { ...player, caught: true } : player);
  }
  return { room, caughtIds };
}

function directionFromRotation(rotation: Vec3) {
  const pitch = Number(rotation[0]) || 0;
  const yaw = Number(rotation[1]) || 0;
  const horizontal = Math.cos(pitch);
  return [-Math.sin(yaw) * horizontal, Math.sin(pitch), -Math.cos(yaw) * horizontal] as Vec3;
}

function isTacticalPlayer(player: PlayerState) {
  return player.role === "attacker" || player.role === "defender";
}

function pushKillFeed(room: RoomState, attackerName: string, victimName: string, weapon: string) {
  const entry: KillFeedEntry = {
    id: `kf-${randomUUID().slice(0, 8)}`,
    roundNumber: room.roundNumber ?? 1,
    attackerName,
    victimName,
    weapon,
    headshot: false,
    timestamp: new Date().toISOString(),
  };
  room.killFeed = [...(room.killFeed ?? []), entry].slice(-24);
}

/** 死亡结算：处理炸弹掉落与拆弹中断。 */
function killPlayer(room: RoomState, map: MapInfo, playerId: string) {
  const victim = room.players.find((player) => player.id === playerId);
  if (!victim) return;
  if (victim.hasBomb && !room.bomb?.plantedAt) {
    room.droppedBomb = {
      position: [...victim.position] as Vec3,
      droppedAt: new Date().toISOString(),
      roundNumber: room.roundNumber ?? 1,
    };
    room.bomb = { ...(room.bomb ?? { siteId: "site-a" }), carrierId: undefined };
  }
  // 拆弹者阵亡：立即中断拆弹（否则定时器到点会让死人"完成"拆弹）
  if (room.bomb?.plantedAt && room.bomb.defuserId === playerId && room.bomb.defusingUntil) {
    room.bomb = { ...room.bomb, defusingUntil: undefined, defuserId: undefined };
  }
  room.players = room.players.map((player) => player.id === playerId
    ? { ...player, hasBomb: false, health: 0, deaths: (player.deaths ?? 0) + 1 }
    : player);
}

/** 拾取掉落的炸弹（进攻方走近自动拾取）。 */
export function pickupDroppedBomb(roomId: string) {
  const room = rooms.get(roomId);
  if (!room || room.status !== "playing" || !room.droppedBomb) return undefined;
  const candidate = room.players.find((player) =>
    player.role === "attacker" &&
    (player.health ?? 100) > 0 &&
    !player.hasBomb &&
    Math.hypot(player.position[0] - room.droppedBomb!.position[0], player.position[2] - room.droppedBomb!.position[2]) <= BOMB_PICKUP_RADIUS);
  if (!candidate) return undefined;
  room.players = room.players.map((player) => player.id === candidate.id ? { ...player, hasBomb: true } : player);
  room.bomb = { ...(room.bomb ?? { siteId: "site-a" }), carrierId: candidate.id };
  delete room.droppedBomb;
  return { room, pickerName: candidate.name };
}

/**
 * 服务端权威 hitscan 开火。
 * 关键点：射线先与"玩家命中体"和"地图障碍物"同次求交，取最近者——
 * 若障碍物更近则命中被墙体阻挡（防穿墙杀人），返回 blocked: true。
 */
export function shootPlayer(roomId: string, shooterId: string) {
  const room = rooms.get(roomId);
  if (!room || room.status !== "playing") return { room, outcome: "inactive" as const };
  const shooter = room.players.find((player) => player.id === shooterId);
  const now = Date.now();
  const timers = combatFor(shooterId);
  if (!shooter || !isTacticalPlayer(shooter) || (shooter.health ?? 100) <= 0) return { room, outcome: "inactive" as const };
  if (timers.reloadUntil > now) return { room, outcome: "reloading" as const };
  if (now - timers.lastFireAt < FIRE_COOLDOWN_MS) return { room, outcome: "cooldown" as const };
  if ((shooter.ammo ?? 0) <= 0) return { room, outcome: "empty" as const };

  timers.lastFireAt = now;
  room.players = room.players.map((player) => player.id === shooterId ? { ...player, ammo: Math.max(0, (player.ammo ?? 0) - 1) } : player);

  const origin = shooter.position;
  const direction = directionFromRotation(shooter.rotation);
  const maxRange = 90;
  const mapId = room.mapId;

  let best: { player: PlayerState; distance: number } | null = null;
  for (const candidate of room.players) {
    if (!isTacticalPlayer(candidate) || candidate.role === shooter.role || (candidate.health ?? 100) <= 0) continue;
    const toTarget: Vec3 = [candidate.position[0] - origin[0], candidate.position[1] - origin[1], candidate.position[2] - origin[2]];
    const distance = Math.hypot(...toTarget);
    if (distance > maxRange || distance < 0.5) continue;
    const dot = (toTarget[0] * direction[0] + toTarget[1] * direction[1] + toTarget[2] * direction[2]) / distance;
    if (dot < 0.985) continue;
    const along = toTarget[0] * direction[0] + toTarget[1] * direction[1] + toTarget[2] * direction[2];
    const perpendicular = Math.sqrt(Math.max(0, distance * distance - along * along));
    if (perpendicular > 1.15 || (best && distance >= best.distance)) continue;
    best = { player: candidate, distance };
  }

  // 与地图障碍物求交：若墙体比目标更近，命中被阻挡
  const wallDistance = mapRayBlockDistance(mapId, origin, direction, maxRange);
  if (best && best.distance > wallDistance) {
    return { room, outcome: "blocked" as const, wallDistance };
  }

  if (!best) return { room, outcome: "miss" as const };

  const target = best.player;
  const damage = 34;
  const armorAbsorb = Math.min(target.armor ?? 0, Math.floor(damage * 0.4));
  const healthDamage = damage - armorAbsorb;
  const nextHealth = Math.max(0, (target.health ?? 100) - healthDamage);
  const killed = nextHealth <= 0;
  room.players = room.players.map((player) => {
    if (player.id === target.id) return { ...player, health: nextHealth, armor: Math.max(0, (player.armor ?? 0) - armorAbsorb) };
    if (player.id === shooterId && killed) return { ...player, kills: (player.kills ?? 0) + 1 };
    return player;
  });
  if (killed) {
    killPlayer(room, maps.get(room.mapId)!, target.id);
    pushKillFeed(room, shooter.name, target.name, "rifle");
  }
  return { room, outcome: "hit" as const, killed, targetId: target.id, targetName: target.name };
}

/** 射击命中 FPV 穿越机（将其击落）。返回被击落的无人机 id。 */
export function shootDownDrone(roomId: string, shooterId: string): { room: RoomState | undefined; droneId: string | null } {
  const room = rooms.get(roomId);
  if (!room || room.status !== "playing") return { room, droneId: null };
  const shooter = room.players.find((player) => player.id === shooterId);
  if (!shooter || !isTacticalPlayer(shooter) || (shooter.health ?? 100) <= 0) return { room, droneId: null };

  const origin = shooter.position;
  const direction = directionFromRotation(shooter.rotation);
  const maxRange = 90;
  let best: { id: string; distance: number } | null = null;
  for (const drone of room.fpvDrones ?? []) {
    if (drone.state !== "flying" || drone.ownerId === shooterId) continue;
    const toDrone: Vec3 = [drone.position[0] - origin[0], drone.position[1] - origin[1], drone.position[2] - origin[2]];
    const distance = Math.hypot(...toDrone);
    if (distance > maxRange || distance < 0.5) continue;
    const along = toDrone[0] * direction[0] + toDrone[1] * direction[1] + toDrone[2] * direction[2];
    if (along <= 0) continue;
    const perpendicular = Math.sqrt(Math.max(0, distance * distance - along * along));
    if (perpendicular > DRONE_HITBOX_HALF) continue;
    if (best && distance >= best.distance) continue;
    best = { id: drone.id, distance };
  }

  if (!best) return { room, droneId: null };
  const wallDistance = mapRayBlockDistance(room.mapId, origin, direction, maxRange);
  if (best.distance > wallDistance) return { room, droneId: null };

  room.fpvDrones = (room.fpvDrones ?? []).map((drone) => drone.id === best!.id ? { ...drone, state: "destroyed" as const } : drone);
  return { room, droneId: best.id };
}

export function reloadWeapon(roomId: string, playerId: string) {
  const room = rooms.get(roomId);
  const player = room?.players.find((item) => item.id === playerId);
  const now = Date.now();
  if (!room || room.status !== "playing" || !player || !isTacticalPlayer(player) || (player.health ?? 100) <= 0) return undefined;
  const timers = combatFor(playerId);
  if (timers.reloadUntil > now) return undefined;
  const ammo = player.ammo ?? 0;
  const reserveAmmo = player.reserveAmmo ?? 0;
  const needed = Math.max(0, 30 - ammo);
  const loaded = Math.min(needed, reserveAmmo);
  if (!loaded) return undefined;
  timers.reloadUntil = now + RELOAD_DURATION_MS;
  room.players = room.players.map((item) => item.id === playerId
    ? { ...item, reloadingUntil: timers.reloadUntil }
    : item);
  return { room, reloadUntil: timers.reloadUntil, duration: RELOAD_DURATION_MS };
}

/** 换弹计时结束后的回填（由 index.ts 定时器或惰性调用）。 */
export function completeReload(roomId: string, playerId: string) {
  const room = rooms.get(roomId);
  const player = room?.players.find((item) => item.id === playerId);
  if (!room || room.status !== "playing" || !player || (player.health ?? 100) <= 0 || !player.reloadingUntil || player.reloadingUntil > Date.now()) return undefined;
  const pending = 30 - (player.ammo ?? 0);
  if (pending <= 0) {
    room.players = room.players.map((item) => item.id === playerId ? { ...item, reloadingUntil: undefined } : item);
    return room;
  }
  const available = player.reserveAmmo ?? 0;
  const loaded = Math.min(pending, available);
  if (loaded <= 0) {
    room.players = room.players.map((item) => item.id === playerId ? { ...item, reloadingUntil: undefined } : item);
    return room;
  }
  room.players = room.players.map((item) => item.id === playerId
    ? { ...item, ammo: (item.ammo ?? 0) + loaded, reserveAmmo: (item.reserveAmmo ?? 0) - loaded, reloadingUntil: undefined }
    : item);
  return room;
}

export function plantBomb(roomId: string, playerId: string, siteId: string) {
  const room = rooms.get(roomId);
  if (!room || room.status !== "playing" || room.bomb?.plantedAt) return undefined;
  const player = room.players.find((item) => item.id === playerId && item.role === "attacker" && item.hasBomb && (item.health ?? 100) > 0);
  const map = maps.get(room.mapId);
  const site = map?.config.bombSites?.find((item) => item.id === siteId);
  if (!player || !map || !site) return undefined;
  const distance = Math.hypot(player.position[0] - site.center[0], player.position[2] - site.center[2]);
  if (distance > site.radius) return undefined;
  const plantedAt = new Date();
  const bomb: BombState = {
    siteId,
    carrierId: playerId,
    plantedAt: plantedAt.toISOString(),
    explodesAt: new Date(plantedAt.getTime() + (map.config.rules.bombTime ?? 40) * 1000).toISOString(),
    position: [...player.position] as Vec3,
  };
  room.bomb = bomb;
  room.players = room.players.map((item) => item.id === playerId ? { ...item, hasBomb: false } : item);
  delete room.droppedBomb;
  return { room, bomb };
}

/** 开始拆弹（长按 E 期间持续上报；达到 BOMB_DEFUSE_MS 判定成功）。 */
export function startDefuse(roomId: string, playerId: string) {
  const room = rooms.get(roomId);
  if (!room || room.status !== "playing" || !room.bomb?.plantedAt) return undefined;
  const player = room.players.find((item) => item.id === playerId && item.role === "defender" && (item.health ?? 100) > 0);
  const bomb = room.bomb;
  if (!player || !bomb.position) return undefined;
  if (!bomb.explodesAt || Date.parse(bomb.explodesAt) <= Date.now()) return undefined;
  if (bomb.defuserId && bomb.defuserId !== playerId) return undefined;
  const distance = Math.hypot(player.position[0] - bomb.position[0], player.position[2] - bomb.position[2]);
  if (distance > 4) return undefined;
  if (bomb.defusingUntil && bomb.defuserId === playerId && bomb.defusingUntil > Date.now()) return { room, defusingUntil: bomb.defusingUntil };
  const defusingUntil = Date.now() + BOMB_DEFUSE_MS;
  room.bomb = { ...bomb, defusingUntil, defuserId: playerId };
  return { room, defusingUntil };
}

/** 拆弹计时到点：由 index.ts 定时器调用。成功则清空安装状态。 */
export function completeDefuse(roomId: string) {
  const room = rooms.get(roomId);
  if (!room || room.status !== "playing" || !room.bomb?.plantedAt || !room.bomb.defusingUntil) return undefined;
  // Early timers are rescheduled by index.ts; never complete before the deadline.
  if (room.bomb.defusingUntil > Date.now()) return undefined;
  const defuserId = room.bomb.defuserId;
  const player = room.players.find((item) => item.id === defuserId && item.role === "defender" && (item.health ?? 100) > 0);
  const bomb = room.bomb;
  if (!player || !bomb.position || !bomb.explodesAt || bomb.defusingUntil! >= Date.parse(bomb.explodesAt) || Date.now() >= Date.parse(bomb.explodesAt) || Math.hypot(player.position[0] - bomb.position[0], player.position[2] - bomb.position[2]) > 4) {
    cancelDefuse(roomId);
    return undefined;
  }
  room.bomb = { siteId: room.bomb.siteId };
  const defuserName = room.players.find((player) => player.id === defuserId)?.name ?? "防守方";
  return { room, defuserName };
}

/** 拆弹中断（拆弹者移动/死亡/松开 E）。 */
export function cancelDefuse(roomId: string) {
  const room = rooms.get(roomId);
  if (!room?.bomb?.defusingUntil) return undefined;
  room.bomb = { ...room.bomb, defusingUntil: undefined, defuserId: undefined };
  return room;
}

// ---------------------------------------------------------------------------
// FPV 自爆穿越机
// ---------------------------------------------------------------------------

/** 发射穿越机（消耗 fpv 次数）。 */
export function launchFpvDrone(roomId: string, playerId: string) {
  const room = rooms.get(roomId);
  const owner = room?.players.find((player) => player.id === playerId);
  if (!room || room.status !== "playing" || !owner || owner.role !== "attacker" || (owner.health ?? 100) <= 0) return undefined;
  if ((room.fpvDrones ?? []).some((drone) => drone.ownerId === playerId && drone.state === "flying")) return undefined;
  const now = Date.now();
  const drone: FpvDroneEntity = {
    id: `drone-${randomUUID().slice(0, 8)}`,
    ownerId: playerId,
    ownerName: owner.name,
    position: [owner.position[0], Math.max(2.4, owner.position[1] + 0.8), owner.position[2]],
    yaw: owner.rotation[1] ?? 0,
    state: "flying",
    launchedAt: new Date().toISOString(),
    expiresAt: now + FPV_LIFETIME_MS,
    armedAt: now + FPV_ARM_DELAY_MS,
    maxSpeed: FPV_MAX_SPEED,
    blastRadius: FPV_BLAST_RADIUS,
    damage: FPV_DAMAGE,
  };
  room.fpvDrones = [...(room.fpvDrones ?? []), drone];
  return { room, drone };
}

/** 持帧上报穿越机位置（服务端限速 + 碰撞 + 燃料校验）。 */
export function updateFpvDrone(roomId: string, playerId: string, droneId: string, position: Vec3, yaw: number) {
  const room = rooms.get(roomId);
  if (!room || room.status !== "playing") return undefined;
  const drone = (room.fpvDrones ?? []).find((item) => item.id === droneId && item.ownerId === playerId && item.state === "flying");
  if (!drone) return undefined;
  const map = maps.get(room.mapId);
  if (!map) return undefined;
  const bounds = map.config.bounds;

  // 限速：客户端上报的位移不能超过 maxSpeed * 0.12s + 容差
  const tolerance = drone.maxSpeed * 0.12 * 1.6;
  const dx = position[0] - drone.position[0];
  const dy = position[1] - drone.position[1];
  const dz = position[2] - drone.position[2];
  const step = Math.hypot(dx, dy, dz);
  let next: Vec3;
  if (step > tolerance && step > 0.001) {
    const scale = tolerance / step;
    next = [
      drone.position[0] + dx * scale,
      drone.position[1] + dy * scale,
      drone.position[2] + dz * scale,
    ];
  } else {
    next = [position[0], position[1], position[2]];
  }
  // 边界 + 高度夹紧（最低 0.6m，最高 bounds.max[1]）
  next = [
    Math.max(bounds.min[0], Math.min(bounds.max[0], next[0])),
    Math.max(0.6, Math.min(bounds.max[1], next[1])),
    Math.max(bounds.min[2], Math.min(bounds.max[2], next[2])),
  ];
  // 障碍碰撞：撞墙则击落
  if (pointBlocked(room.mapId, next[0], next[2], next[1] + 0.3, 0.35)) {
    room.fpvDrones = (room.fpvDrones ?? []).map((item) => item.id === droneId ? { ...item, state: "destroyed" as const } : item);
    return { room, destroyed: true as const };
  }
  room.fpvDrones = (room.fpvDrones ?? []).map((item) => item.id === droneId ? { ...item, position: next, yaw: Number.isFinite(yaw) ? yaw : item.yaw } : item);
  return { room, destroyed: false as const };
}

/** 引爆穿越机：范围伤害（可伤害双方，含自己人但不伤害自己）。 */
export function detonateFpvDrone(roomId: string, playerId: string, droneId: string) {
  const room = rooms.get(roomId);
  if (!room || room.status !== "playing") return undefined;
  const drone = (room.fpvDrones ?? []).find((item) => item.id === droneId && item.ownerId === playerId && item.state === "flying");
  if (!drone) return undefined;
  if (drone.armedAt > Date.now()) return { room, notArmed: true as const };
  const map = maps.get(room.mapId);
  if (!map) return undefined;

  const radiusSquared = drone.blastRadius * drone.blastRadius;
  const hitIds = room.players
    .filter((player) => isTacticalPlayer(player) && (player.health ?? 100) > 0 && player.id !== playerId)
    .filter((player) => {
      const dx = player.position[0] - drone.position[0];
      const dy = player.position[1] - drone.position[1];
      const dz = player.position[2] - drone.position[2];
      return dx * dx + dy * dy + dz * dz <= radiusSquared;
    })
    .map((player) => player.id);

  room.fpvDrones = (room.fpvDrones ?? []).filter((item) => item.id !== droneId);
  for (const hitId of hitIds) {
    const target = room.players.find((player) => player.id === hitId);
    if (!target) continue;
    const nextHealth = Math.max(0, (target.health ?? 100) - drone.damage);
    const killed = nextHealth <= 0;
    if (killed) {
      pushKillFeed(room, room.players.find((player) => player.id === playerId)?.name ?? "穿越机", target.name, "fpv-drone");
      killPlayer(room, map, hitId);
    } else {
      room.players = room.players.map((player) => player.id === hitId ? { ...player, health: nextHealth } : player);
    }
  }
  return { room, hitIds, position: drone.position, blastRadius: drone.blastRadius };
}

/** 燃料耗尽自动回收（由 index.ts 周期调用）。 */
export function expireFpvDrones(roomId: string) {
  const room = rooms.get(roomId);
  if (!room || room.fpvDrones === undefined) return undefined;
  const now = Date.now();
  const before = room.fpvDrones.length;
  room.fpvDrones = room.fpvDrones.filter((drone) => drone.state === "flying" && drone.expiresAt > now);
  if (room.fpvDrones.length === before) return undefined;
  return room;
}
