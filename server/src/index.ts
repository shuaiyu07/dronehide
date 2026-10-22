import http from "node:http";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import multer from "multer";
import { Server } from "socket.io";
import { droneSdkAdapter } from "./droneSdkAdapter.ts";
import { assertGlbMagic, assertSafeUploadName, assertUniqueUploadNames, isGlbPathname, type UploadField, type UploadRoute, uploadErrorResponse, validateUploadFile, validateUploadType } from "./uploadSecurity.ts";
import { resolvePlayerMove } from "../../shared/collision.ts";
import { addPlayer, beginGame, cancelDefuse, cancelPreparation, catchNearbyHiders, completeDefuse, completeReload, consumeDroneCharge, createDroneMission, createImportedMap, createLocalMap, createMapPackage, createRemoteMap, createRoom, detonateFpvDrone, endGame, expireFpvDrones, finishRound, getDroneMission, getMap, getRoom, launchFpvDrone, listDroneMissions, listMaps, listResourcePacks, listRooms, pickupDroppedBomb, plantBomb, prepareGame, reloadWeapon, removePlayer, shootDownDrone, shootPlayer, startDefuse, startNextRound, updateDroneMissionStatus, updateFpvDrone, updateMapConfig, updatePlayer, validateMapConfig, validateMapPackageManifest, validateResourcePackManifest } from "./store.ts";
import type { DroneAbility, DroneMissionStatus, MapConfig, MapPackageManifest, MapProvenanceType, PlayerRole, ResourcePackManifest, RoundEndReason, Vec3 } from "../../shared/types.ts";

const PORT = Number(process.env.PORT ?? 3001);
const configuredClientOrigins = String(process.env.CLIENT_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const corsOptions = {
  // A Quick Tunnel URL changes each run. When no fixed URL is configured, reflect the
  // caller origin for this temporary classroom-test server. Set CLIENT_ORIGIN before
  // production deployment to restrict access to a known domain.
  origin: configuredClientOrigins.length > 0 ? configuredClientOrigins : true,
  methods: ["GET", "POST", "PUT"],
};
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions,
});

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uploadRoot = path.join(serverRoot, "uploads");
const projectUploadRoot = path.resolve(serverRoot, "..", "uploads");
const clientDistRoot = path.resolve(serverRoot, "..", "client", "dist");
const clientIndexPath = path.join(clientDistRoot, "index.html");
mkdirSync(path.join(uploadRoot, "maps"), { recursive: true });
mkdirSync(path.join(uploadRoot, "plugins"), { recursive: true });

const mapUpload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, path.join(uploadRoot, "maps")),
    filename: (_request, file, callback) => callback(null, `map-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    try {
      validateUploadType(file, "map", "model");
      callback(null, true);
    } catch (error) {
      callback(error as Error);
    }
  },
});

function createPackageUpload(route: Extract<UploadRoute, "map-package" | "resource-pack">) {
  return multer({
    preservePath: true,
    storage: multer.diskStorage({
      destination: (_request, _file, callback) => {
        const stagingRoot = path.join(uploadRoot, "package-staging");
        mkdirSync(stagingRoot, { recursive: true });
        callback(null, stagingRoot);
      },
      filename: (_request, file, callback) => callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${path.basename(file.originalname)}`),
    }),
    limits: { fileSize: 100 * 1024 * 1024, files: 64 },
    fileFilter: (_request, file, callback) => {
      try {
        validateUploadType(file, route, file.fieldname as UploadField);
        callback(null, true);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

const mapPackageUpload = createPackageUpload("map-package");
const resourcePackUpload = createPackageUpload("resource-pack");

function uploadedFile(files: Record<string, Express.Multer.File[]> | undefined, field: string) {
  return files?.[field]?.[0];
}

function packageFileName(file: Express.Multer.File) {
  assertSafeUploadName(file.originalname);
  return file.originalname;
}

function validateStoredUpload(file: Express.Multer.File, route: UploadRoute, field: UploadField) {
  validateUploadFile(file, route, field);
  if (path.extname(file.originalname).toLowerCase() === ".glb") assertGlbMagic(file.path, file.originalname);
}

function packageFiles(files: Express.Multer.File[], packageRoot: string) {
  const urls = new Map<string, string>();
  for (const file of files) {
    const fileName = packageFileName(file);
    const target = path.join(packageRoot, fileName);
    renameSync(file.path, target);
    urls.set(file.originalname, fileName);
  }
  return urls;
}

function cleanupPackageFiles(files: Express.Multer.File[]) {
  for (const file of files) {
    try {
      unlinkSync(file.path);
    } catch {
      // The file may already have been moved into its package directory.
    }
  }
}

function parseManifest(file: Express.Multer.File | undefined) {
  if (!file) throw new Error("请上传 manifest.json");
  try {
    return JSON.parse(readFileSync(file.path, "utf8")) as unknown;
  } catch {
    throw new Error("manifest.json 不是有效的 JSON 文件");
  }
}

function packageFolder(prefix: string, id: string, version: string) {
  const safeId = `${id}-${version}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(uploadRoot, prefix, `${safeId}-${Date.now()}-${Math.round(Math.random() * 1e6)}`);
}

function uploadHandler(middleware: express.RequestHandler) {
  return (request: express.Request, response: express.Response, next: express.NextFunction) => {
    middleware(request, response, (error) => {
      if (error) {
        const uploaded = Object.values((request.files ?? {}) as Record<string, Express.Multer.File[]>).flat();
        cleanupPackageFiles(uploaded);
        const failure = uploadErrorResponse(error);
        response.status(failure.statusCode).json({ message: failure.message });
        return;
      }
      next();
    });
  };
}

const roomTimers = new Map<string, NodeJS.Timeout>();
const bombTimers = new Map<string, NodeJS.Timeout>();
const nextRoundTimers = new Map<string, NodeJS.Timeout>();
const defuseTimers = new Map<string, NodeJS.Timeout>();
const reloadTimers = new Map<string, NodeJS.Timeout>();

function clearRoomTimer(roomId: string) {
  const timer = roomTimers.get(roomId);
  if (timer) clearTimeout(timer);
  roomTimers.delete(roomId);
}

function clearBombTimer(roomId: string) {
  const timer = bombTimers.get(roomId);
  if (timer) clearTimeout(timer);
  bombTimers.delete(roomId);
}

function clearNextRoundTimer(roomId: string) {
  const timer = nextRoundTimers.get(roomId);
  if (timer) clearTimeout(timer);
  nextRoundTimers.delete(roomId);
}

function clearDefuseTimer(roomId: string) {
  const timer = defuseTimers.get(timerKey(roomId));
  if (timer) clearTimeout(timer);
  defuseTimers.delete(timerKey(roomId));
}

function clearReloadTimer(playerKey: string) {
  const timer = reloadTimers.get(playerKey);
  if (timer) clearTimeout(timer);
  reloadTimers.delete(playerKey);
}

function timerKey(roomId: string) {
  return roomId;
}

/** 拆弹到点结算（由 startDefuse 定时器触发）。 */
function settleDefuse(roomId: string) {
  const deadline = getRoom(roomId)?.bomb?.defusingUntil;
  defuseTimers.delete(timerKey(roomId));
  if (deadline && deadline > Date.now()) {
    defuseTimers.set(timerKey(roomId), setTimeout(() => settleDefuse(roomId), deadline - Date.now()));
    return;
  }
  const result = completeDefuse(roomId);
  if (!result) return;
  defuseTimers.delete(timerKey(roomId));
  io.to(roomId).emit("round:event", { type: "bomb-defused", message: `${result.defuserName} 完成拆弹，防守方拿下本回合` });
  finishRoundAndSchedule(roomId, "defender", "bomb-defused", "炸弹已拆除，防守方获胜");
}

/** 换弹到点回填（由 reloadWeapon 定时器触发）。 */
function settleReload(roomId: string, playerId: string) {
  const key = `${roomId}:${playerId}`;
  const deadline = getRoom(roomId)?.players.find((player) => player.id === playerId)?.reloadingUntil;
  if (deadline && deadline > Date.now()) {
    reloadTimers.set(key, setTimeout(() => settleReload(roomId, playerId), deadline - Date.now()));
    return;
  }
  const room = completeReload(roomId, playerId);
  reloadTimers.delete(key);
  if (room) io.to(roomId).emit("room:state", room);
}

/**
 * 单回合结算 + 下一回合排程。
 * 赛点（一方达标 roundsToWin）时不设 nextRoundAt，全场结束。
 */
function finishRoundAndSchedule(roomId: string, winner: "attacker" | "defender", reason: RoundEndReason, message: string) {
  for (const player of getRoom(roomId)?.players ?? []) clearReloadTimer(`${roomId}:${player.id}`);
  clearRoomTimer(roomId);
  clearBombTimer(roomId);
  clearDefuseTimer(roomId);
  const room = finishRound(roomId, winner, reason, message);
  if (!room) return undefined;
  io.to(roomId).emit("round:event", { type: "round-end", message: room.resultMessage ?? "回合结束" });
  io.to(roomId).emit("room:state", room);
  if (room.nextRoundAt !== undefined) {
    const delay = Math.max(0, room.nextRoundAt - Date.now());
    const timer = setTimeout(() => {
      nextRoundTimers.delete(roomId);
      const latest = getRoom(roomId);
      if (!latest || latest.status !== "ended" || latest.nextRoundAt === undefined) return;
      const nextRoom = startNextRound(roomId);
      if (!nextRoom) return;
      io.to(roomId).emit("round:event", { type: "round-start", message: `第 ${nextRoom.roundNumber ?? 1} 回合开始${(nextRoom.roundNumber ?? 1) % 2 === 1 ? "，攻防互换" : ""}` });
      io.to(roomId).emit("room:state", nextRoom);
      if (nextRoom.preparingEndsAt) scheduleGameStart(roomId, nextRoom.preparingEndsAt);
    }, delay);
    nextRoundTimers.set(roomId, timer);
  } else {
    // 全场结束（赛点）：清掉其它排程
    clearNextRoundTimer(roomId);
  }
  return room;
}

/** 穿越机燃料周期回收：每秒扫描一次所有房间。 */
setInterval(() => {
  for (const room of listRooms()) {
    const expired = expireFpvDrones(room.id);
    if (expired) io.to(room.id).emit("room:state", expired);
  }
}, 1000).unref();

function finishRoom(roomId: string, winner: "attacker" | "defender" | "seeker" | "hider" | "draw", message: string) {
  clearRoomTimer(roomId);
  clearBombTimer(roomId);
  const room = endGame(roomId, winner, message);
  if (room) io.to(roomId).emit("room:state", room);
}

function scheduleRoomEnd(roomId: string, endsAt: string) {
  const delay = Math.max(0, new Date(endsAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    const room = getRoom(roomId);
    const map = room ? getMap(room.mapId) : undefined;
    if (!room || room.status !== "playing") return;
    if (map?.config.gameMode === "tactical-bomb") {
      if (room.bomb?.plantedAt) return;
      finishRoundAndSchedule(roomId, "defender", "time-expired", "回合时间结束，进攻方未完成目标，防守方获胜");
      return;
    }
    finishRoom(roomId, "hider", "时间到，仍有躲藏者未被找到");
  }, delay);
  roomTimers.set(roomId, timer);
}

function scheduleBombExplosion(roomId: string, explodesAt: string) {
  clearBombTimer(roomId);
  const delay = Math.max(0, new Date(explodesAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    const room = getRoom(roomId);
    const map = room ? getMap(room.mapId) : undefined;
    if (room?.status === "playing" && map?.config.gameMode === "tactical-bomb" && room.bomb?.plantedAt) {
      finishRoundAndSchedule(roomId, "attacker", "bomb-exploded", "炸弹爆炸，进攻方获胜");
    }
  }, delay);
  bombTimers.set(roomId, timer);
}

function checkTacticalVictory(roomId: string) {
  const room = getRoom(roomId);
  const map = room ? getMap(room.mapId) : undefined;
  if (!room || !map || room.status !== "playing" || map.config.gameMode !== "tactical-bomb") return false;
  const attackersAlive = room.players.some((player) => player.role === "attacker" && (player.health ?? 100) > 0);
  const defendersAlive = room.players.some((player) => player.role === "defender" && (player.health ?? 100) > 0);
  if (!attackersAlive && !room.bomb?.plantedAt) {
    finishRoundAndSchedule(roomId, "defender", "attackers-eliminated", "进攻方全部出局，防守方获胜");
    return true;
  }
  if (!defendersAlive) {
    finishRoundAndSchedule(roomId, "attacker", "defenders-eliminated", "防守方全部出局，进攻方获胜");
    return true;
  }
  return false;
}

function scheduleGameStart(roomId: string, preparingEndsAt: string) {
  const delay = Math.max(0, new Date(preparingEndsAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    roomTimers.delete(roomId);
    const room = beginGame(roomId);
    if (!room || !room.endsAt) return;
    io.to(roomId).emit("room:state", room);
    scheduleRoomEnd(roomId, room.endsAt);
  }, delay);
  roomTimers.set(roomId, timer);
}

function returnPreparingRoomToWaiting(roomId: string) {
  const room = getRoom(roomId);
  if (room?.status !== "preparing" || room.players.length >= 2) return room;
  clearRoomTimer(roomId);
  const resetRoom = cancelPreparation(roomId);
  if (resetRoom) io.to(roomId).emit("room:state", resetRoom);
  return resetRoom;
}

function clampPosition(position: Vec3, bounds: { min: Vec3; max: Vec3 }): Vec3 {
  return [
    Math.max(bounds.min[0], Math.min(bounds.max[0], Number(position[0]) || 0)),
    Math.max(bounds.min[1], Math.min(bounds.max[1], Number(position[1]) || 1.7)),
    Math.max(bounds.min[2], Math.min(bounds.max[2], Number(position[2]) || 0)),
  ];
}

app.use(cors(corsOptions));
app.use(express.json());
app.use("/uploads", express.static(uploadRoot, {
  setHeaders: (response) => response.setHeader("X-Content-Type-Options", "nosniff"),
}));
// Keep previously imported project assets available without duplicating large GLB files.
app.use("/uploads", express.static(projectUploadRoot, {
  setHeaders: (response) => response.setHeader("X-Content-Type-Options", "nosniff"),
}));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "drone-hide-platform-server",
    timestamp: new Date().toISOString(),
    version: "0.2.0",
  });
});

app.get("/api/drone/sdk-status", (_request, response) => {
  response.json(droneSdkAdapter.getStatus());
});

app.get("/api/resource-packs", (_request, response) => {
  response.json({ items: listResourcePacks() });
});

app.post("/api/resource-packs/import", uploadHandler(resourcePackUpload.fields([
  { name: "manifest", maxCount: 1 },
  { name: "assets", maxCount: 63 },
])), (request, response) => {
  const files = (request.files ?? {}) as Record<string, Express.Multer.File[]>;
  const allFiles = Object.values(files).flat();
  try {
    assertUniqueUploadNames(allFiles);
    for (const file of allFiles) validateStoredUpload(file, "resource-pack", file.fieldname as UploadField);
    const manifestFile = uploadedFile(files, "manifest");
    const rawManifest = parseManifest(manifestFile);
    const validationError = validateResourcePackManifest(rawManifest);
    if (validationError) throw new Error(validationError);
    const manifest = rawManifest as ResourcePackManifest;
    const assetFiles = files.assets ?? [];
    const normalizedAssets = manifest.assets.map((asset) => {
      if (!asset.path) return asset;
      assertSafeUploadName(asset.path);
      const matchingFile = assetFiles.find((file) => file.originalname === asset.path);
      if (!matchingFile) throw new Error(`资源文件未上传：${path.basename(asset.path)}`);
      return { ...asset, path: packageFileName(matchingFile) };
    });
    const packageRoot = packageFolder("plugins", manifest.id, manifest.version);
    mkdirSync(packageRoot, { recursive: true });
    packageFiles(assetFiles, packageRoot);
    writeFileSync(path.join(packageRoot, "manifest.json"), JSON.stringify({ ...manifest, assets: normalizedAssets }, null, 2), "utf8");
    if (manifestFile) unlinkSync(manifestFile.path);
    const packs = listResourcePacks();
    const pack = packs.find((item) => item.baseUrl === `/uploads/plugins/${path.basename(packageRoot)}`);
    response.status(201).json(pack ?? { ...manifest, assets: normalizedAssets, builtIn: false, baseUrl: `/uploads/plugins/${path.basename(packageRoot)}` });
  } catch (error) {
    cleanupPackageFiles(allFiles);
    const failure = uploadErrorResponse(error);
    response.status(failure.statusCode).json({ message: failure.message });
  }
});

app.get("/api/drone/missions", (_request, response) => {
  response.json({ items: listDroneMissions() });
});

app.post("/api/drone/missions", (request, response) => {
  const name = String(request.body?.name ?? "").trim();
  if (!name) {
    response.status(400).json({ message: "请填写采集任务名称" });
    return;
  }

  const requestedStatus = String(request.body?.status ?? "planned") as DroneMissionStatus;
  const status: DroneMissionStatus = ["planned", "captured", "model-ready"].includes(requestedStatus) ? requestedStatus : "planned";
  const mission = createDroneMission(droneSdkAdapter.prepareMission({
    name: name.slice(0, 80),
    provider: String(request.body?.provider ?? "").trim(),
    aircraftModel: String(request.body?.aircraftModel ?? "未填写机型").trim() || "未填写机型",
    cameraModel: String(request.body?.cameraModel ?? "未填写相机").trim() || "未填写相机",
    captureDate: String(request.body?.captureDate ?? new Date().toISOString()).trim() || new Date().toISOString(),
    status,
    notes: String(request.body?.notes ?? "").trim().slice(0, 500),
  }));
  response.status(201).json(mission);
});

app.put("/api/drone/missions/:missionId/status", (request, response) => {
  const status = String(request.body?.status ?? "");
  if (!["planned", "captured", "model-ready"].includes(status)) {
    response.status(400).json({ message: "任务状态只能是 planned、captured 或 model-ready" });
    return;
  }
  const mission = updateDroneMissionStatus(request.params.missionId, status as DroneMissionStatus);
  if (!mission) {
    response.status(404).json({ message: "采集任务不存在" });
    return;
  }
  response.json(mission);
});

app.get("/api/maps", (_request, response) => {
  response.json({ items: listMaps() });
});

app.get("/api/maps/:mapId", (request, response) => {
  const map = getMap(request.params.mapId);
  if (!map) {
    response.status(404).json({ message: "地图不存在" });
    return;
  }
  response.json(map);
});

app.post("/api/maps/import", uploadHandler(mapUpload.single("model")), (request, response) => {
  if (!request.file) {
    response.status(400).json({ message: "请选择 .glb 三维地图文件（最大 100 MB）" });
    return;
  }

  try {
    validateStoredUpload(request.file, "map", "model");
  } catch (error) {
    unlinkSync(request.file.path);
    const failure = uploadErrorResponse(error);
    response.status(failure.statusCode).json({ message: failure.message });
    return;
  }

  const name = String(request.body?.name ?? "").trim();
  if (!name) {
    unlinkSync(request.file.path);
    response.status(400).json({ message: "请填写地图名称" });
    return;
  }

  const requestedProvenance = String(request.body?.provenanceType ?? "open-source") as MapProvenanceType;
  if (!["open-source", "drone-sdk"].includes(requestedProvenance)) {
    unlinkSync(request.file.path);
    response.status(400).json({ message: "请选择开源地图或无人机 SDK 建模成果" });
    return;
  }

  const sourceUrl = String(request.body?.sourceUrl ?? "").trim();
  const license = String(request.body?.license ?? "").trim();
  const attribution = String(request.body?.attribution ?? "").trim();
  const missionId = String(request.body?.missionId ?? "").trim();

  if (requestedProvenance === "open-source" && !license) {
    unlinkSync(request.file.path);
    response.status(400).json({ message: "开源地图必须记录许可证" });
    return;
  }
  if (requestedProvenance === "drone-sdk" && (!missionId || !getDroneMission(missionId))) {
    unlinkSync(request.file.path);
    response.status(400).json({ message: "无人机建模成果必须关联一个采集任务" });
    return;
  }
  if (requestedProvenance === "drone-sdk" && getDroneMission(missionId)?.status !== "model-ready") {
    unlinkSync(request.file.path);
    response.status(400).json({ message: "采集任务需先标记为“模型已生成”才能关联地图" });
    return;
  }

  const map = createImportedMap({
    name: name.slice(0, 80),
    description: String(request.body?.description ?? "").trim().slice(0, 300) || "待配置的三维地图",
    modelUrl: `/uploads/maps/${request.file.filename}`,
    provenance: {
      type: requestedProvenance,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(license ? { license } : {}),
      ...(attribution ? { attribution } : {}),
      ...(missionId ? { missionId } : {}),
    },
  });
  response.status(201).json(map);
});

app.post("/api/maps/local", (request, response) => {
  const name = String(request.body?.name ?? "").trim();
  const fileName = String(request.body?.fileName ?? "").trim();
  const modelUrl = `/uploads/maps/${encodeURIComponent(path.basename(fileName))}`;
  const sourceUrl = String(request.body?.sourceUrl ?? "").trim();
  const license = String(request.body?.license ?? "").trim();
  const attribution = String(request.body?.attribution ?? "").trim();
  if (!name) {
    response.status(400).json({ message: "请填写地图名称" });
    return;
  }
  if (!/^[a-zA-Z0-9._-]+\.glb$/i.test(fileName)) {
    response.status(400).json({ message: "本地地图文件名必须是安全的 .glb 文件名" });
    return;
  }
  if (!existsSync(path.join(projectUploadRoot, "maps", fileName)) && !existsSync(path.join(uploadRoot, "maps", fileName))) {
    response.status(404).json({ message: "项目本地 uploads/maps 中找不到这个 GLB 文件" });
    return;
  }
  if (!license) {
    response.status(400).json({ message: "本地开源地图必须记录许可证" });
    return;
  }
  const map = createLocalMap({
    name: name.slice(0, 80),
    description: String(request.body?.description ?? "").trim().slice(0, 300) || "项目已有的本地 GLB 地图",
    modelUrl,
    provenance: {
      type: "open-source",
      ...(sourceUrl ? { sourceUrl } : {}),
      license,
      ...(attribution ? { attribution } : {}),
    },
  });
  response.status(201).json(map);
});

app.post("/api/maps/import-package", uploadHandler(mapPackageUpload.fields([
  { name: "manifest", maxCount: 1 },
  { name: "scene", maxCount: 1 },
  { name: "collision", maxCount: 1 },
  { name: "thumbnail", maxCount: 1 },
])), (request, response) => {
  const files = (request.files ?? {}) as Record<string, Express.Multer.File[]>;
  const allFiles = Object.values(files).flat();
  try {
    assertUniqueUploadNames(allFiles);
    for (const file of allFiles) validateStoredUpload(file, "map-package", file.fieldname as UploadField);
    const manifestFile = uploadedFile(files, "manifest");
    const rawManifest = parseManifest(manifestFile);
    const validationError = validateMapPackageManifest(rawManifest);
    if (validationError) throw new Error(validationError);
    const manifest = rawManifest as MapPackageManifest;
    const sceneFile = uploadedFile(files, "scene");
    assertSafeUploadName(manifest.scene.path);
    if (!sceneFile || path.basename(manifest.scene.path) !== packageFileName(sceneFile)) {
      throw new Error(`地图包 scene 文件必须与上传文件一致：${path.basename(manifest.scene.path)}`);
    }
    const collisionFile = uploadedFile(files, "collision");
    if (manifest.collision) assertSafeUploadName(manifest.collision.path);
    if (manifest.collision && (!collisionFile || path.basename(manifest.collision.path) !== packageFileName(collisionFile))) {
      throw new Error(`地图包 collision 文件必须与上传文件一致：${path.basename(manifest.collision.path)}`);
    }
    const thumbnailFile = uploadedFile(files, "thumbnail");
    if (manifest.thumbnail) assertSafeUploadName(manifest.thumbnail.path);
    if (manifest.thumbnail && (!thumbnailFile || path.basename(manifest.thumbnail.path) !== packageFileName(thumbnailFile))) {
      throw new Error(`地图包 thumbnail 文件必须与上传文件一致：${path.basename(manifest.thumbnail.path)}`);
    }
    if (manifest.provenanceType === "drone-sdk" && (!manifest.missionId || !getDroneMission(manifest.missionId))) {
      throw new Error("无人机建模地图包必须关联一个采集任务");
    }
    if (manifest.provenanceType === "drone-sdk" && getDroneMission(manifest.missionId!)?.status !== "model-ready") {
      throw new Error("采集任务需先标记为“模型已生成”才能关联地图包");
    }

    const packageRoot = packageFolder("maps/packages", manifest.id, manifest.version);
    mkdirSync(packageRoot, { recursive: true });
    const storedFiles = packageFiles(allFiles.filter((file) => file.fieldname !== "manifest"), packageRoot);
    writeFileSync(path.join(packageRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    if (manifestFile) unlinkSync(manifestFile.path);
    const map = createMapPackage({
      manifest,
      sceneUrl: `/uploads/maps/packages/${path.basename(packageRoot)}/${encodeURIComponent(storedFiles.get(sceneFile.originalname) ?? packageFileName(sceneFile))}`,
      ...(collisionFile ? { collisionUrl: `/uploads/maps/packages/${path.basename(packageRoot)}/${encodeURIComponent(storedFiles.get(collisionFile.originalname) ?? packageFileName(collisionFile))}` } : {}),
      ...(thumbnailFile ? { thumbnailUrl: `/uploads/maps/packages/${path.basename(packageRoot)}/${encodeURIComponent(storedFiles.get(thumbnailFile.originalname) ?? packageFileName(thumbnailFile))}` } : {}),
    });
    response.status(201).json(map);
  } catch (error) {
    cleanupPackageFiles(allFiles);
    const failure = uploadErrorResponse(error);
    response.status(failure.statusCode).json({ message: failure.message });
  }
});

app.post("/api/maps/remote", (request, response) => {
  const name = String(request.body?.name ?? "").trim();
  const modelUrl = String(request.body?.modelUrl ?? "").trim();
  const description = String(request.body?.description ?? "").trim().slice(0, 300) || "来自网络的三维地图";
  const sourceUrl = String(request.body?.sourceUrl ?? "").trim();
  const license = String(request.body?.license ?? "").trim();
  const attribution = String(request.body?.attribution ?? "").trim();

  let parsedModelUrl: URL;
  try {
    parsedModelUrl = new URL(modelUrl);
  } catch {
    response.status(400).json({ message: "网络地图 URL 格式无效" });
    return;
  }
  if (parsedModelUrl.protocol !== "https:") {
    response.status(400).json({ message: "网络地图必须使用 HTTPS 地址" });
    return;
  }
  if (!name) {
    response.status(400).json({ message: "请填写地图名称" });
    return;
  }
  if (!isGlbPathname(parsedModelUrl.pathname)) {
    response.status(400).json({ message: "网络地图地址必须指向 .glb 文件" });
    return;
  }
  if (!license) {
    response.status(400).json({ message: "网络开源地图必须记录许可证" });
  return;
  }

  const map = createRemoteMap({
    name: name.slice(0, 80),
    description,
    modelUrl: parsedModelUrl.toString(),
    provenance: {
      type: "open-source",
      ...(sourceUrl ? { sourceUrl } : {}),
      license,
      ...(attribution ? { attribution } : {}),
    },
  });
  response.status(201).json(map);
});

app.put("/api/maps/:mapId/config", (request, response) => {
  const mapId = request.params.mapId;
  const validationError = validateMapConfig(request.body?.config, mapId);
  if (validationError) {
    response.status(400).json({ message: validationError });
    return;
  }

  const map = updateMapConfig(mapId, request.body.config as MapConfig);
  if (!map) {
    response.status(404).json({ message: "地图不存在" });
    return;
  }
  response.json(map);
});

app.get("/api/rooms", (_request, response) => {
  response.json({ items: listRooms() });
});

app.get("/api/rooms/:roomId", (request, response) => {
  const room = getRoom(request.params.roomId.toUpperCase());
  if (!room) {
    response.status(404).json({ message: "房间不存在或已关闭" });
    return;
  }
  response.json({
    id: room.id,
    name: room.name,
    mapId: room.mapId,
    resourcePackBaseUrl: room.resourcePackBaseUrl,
    status: room.status,
    hostId: room.hostId,
    playerCount: room.players.length,
    createdAt: room.createdAt,
  });
});

app.post("/api/rooms", (request, response) => {
  const name = String(request.body?.name ?? "未命名房间").trim() || "未命名房间";
  const mapId = String(request.body?.mapId ?? "demo-campus");
  const resourcePackBaseUrl = typeof request.body?.resourcePackBaseUrl === "string" ? request.body.resourcePackBaseUrl.trim() : "";
  if (!getMap(mapId)) {
    response.status(400).json({ message: "指定地图不存在" });
    return;
  }
  if (resourcePackBaseUrl && !listResourcePacks().some((pack) => pack.baseUrl === resourcePackBaseUrl)) {
    response.status(400).json({ message: "指定资源包不存在" });
    return;
  }
  response.status(201).json(createRoom(name, mapId, resourcePackBaseUrl || undefined));
});

function defaultPlayer(socketId: string, name: string, role: PlayerRole = "spectator") {
  return {
    id: socketId,
    name,
    role,
    position: [0, 1.7, 0] as Vec3,
    rotation: [0, 0, 0] as Vec3,
    caught: false,
  };
}

io.on("connection", (socket) => {
  const leaveCurrentRoom = () => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    socket.data.roomId = undefined;
    socket.leave(roomId);
    clearReloadTimer(`${roomId}:${socket.id}`);
    if (getRoom(roomId)?.bomb?.defuserId === socket.id) clearDefuseTimer(roomId);
    removePlayer(roomId, socket.id);
    const room = returnPreparingRoomToWaiting(roomId) ?? getRoom(roomId);
    const map = room ? getMap(room.mapId) : undefined;
    if (map?.config.gameMode === "tactical-bomb" && room?.status === "playing") checkTacticalVictory(roomId);
    if (room?.status === "ended" && room.players.length < 2) {
      clearNextRoundTimer(roomId);
      clearRoomTimer(roomId);
      clearBombTimer(roomId);
      clearDefuseTimer(roomId);
      cancelPreparation(roomId);
    }
    if (map?.config.gameMode !== "tactical-bomb" && room?.status === "playing" && !room.players.some((player) => player.role === "hider" && !player.caught)) {
      finishRoom(roomId, "seeker", "所有躲藏者已离开，寻找者获胜");
      return;
    }
    io.to(roomId).emit("room:state", getRoom(roomId));
  };
  socket.on("room:join", ({ roomId, name }: { roomId: string; name: string }) => {
    const normalizedRoomId = String(roomId ?? "").trim().toUpperCase();
    const room = getRoom(normalizedRoomId);
    if (!room) {
      socket.emit("room:error", { message: "房间不存在" });
      return;
    }
    const map = getMap(room.mapId);
    if (room.status !== "waiting") {
      socket.emit("room:error", { message: "游戏已经开始，暂时不能加入" });
      return;
    }
    if (map && room.players.length >= map.config.rules.maxPlayers) {
      socket.emit("room:error", { message: `房间已满，最多 ${map.config.rules.maxPlayers} 人` });
      return;
    }
    if (socket.data.roomId !== normalizedRoomId) leaveCurrentRoom();
    socket.join(normalizedRoomId);
    socket.data.roomId = normalizedRoomId;
    addPlayer(normalizedRoomId, defaultPlayer(socket.id, String(name ?? "").trim().slice(0, 16) || "玩家"));
    io.to(normalizedRoomId).emit("room:state", getRoom(normalizedRoomId));
  });

  socket.on("room:leave", () => {
    leaveCurrentRoom();
  });

  socket.on("player:update", ({ position, rotation }: { position: Vec3; rotation?: Vec3 }) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    const room = getRoom(roomId);
    const map = room ? getMap(room.mapId) : undefined;
    if (!room || !map || room.status !== "playing") return;
    const actor = room.players.find((player) => player.id === socket.id);
    if (!actor || actor.role === "spectator" || (map.config.gameMode === "tactical-bomb" && (actor.health ?? 100) <= 0)) return;
    const safePosition = resolvePlayerMove(map.config, actor.position, position);
    if (!Array.isArray(position) || position.length !== 3 || position.some((value, axis) => !Number.isFinite(value) || Math.abs(value - safePosition[axis]) > 0.01)) {
      socket.emit("player:correction", { position: safePosition });
    }
    const safeRotation: Vec3 = Array.isArray(rotation) && rotation.length === 3 && rotation.every((value) => Number.isFinite(value))
      ? rotation
      : [0, 0, 0];
    const positionBefore = room.players.find((player) => player.id === socket.id)?.position;
    updatePlayer(roomId, socket.id, { position: safePosition, rotation: safeRotation });
    if (map.config.gameMode === "tactical-bomb") {
      // 掉落炸弹自动拾取（进攻方走近 2.2m 内）
      const picked = pickupDroppedBomb(roomId);
      if (picked) {
        io.to(roomId).emit("round:event", { type: "bomb-picked-up", message: `${picked.pickerName} 拾取了掉落的炸弹` });
      }
      // 拆弹者位移超过阈值则中断拆弹（原地心跳不触发）
      if (positionBefore) {
        const moved = Math.hypot(positionBefore[0] - safePosition[0], positionBefore[2] - safePosition[2]);
        if (moved > 0.05 && room.bomb?.defuserId === socket.id) {
          const cancelled = cancelDefuse(roomId);
          if (cancelled) {
            clearDefuseTimer(roomId);
            io.to(roomId).emit("round:event", { type: "defuse-cancelled", message: "拆弹被中断（拆弹者移动）" });
          }
        }
      }
      io.to(roomId).emit("room:state", getRoom(roomId));
      return;
    }
    const result = catchNearbyHiders(roomId, socket.id, map.config.rules.catchDistance);
    if (result.caughtIds.length > 0 && result.room) {
      const seekerName = result.room.players.find((player) => player.id === socket.id)?.name ?? "寻找者";
      const caughtNames = result.room.players.filter((player) => result.caughtIds.includes(player.id)).map((player) => player.name).join("、");
      io.to(roomId).emit("round:event", { type: "caught", message: `${seekerName} 找到了 ${caughtNames}` });
    }
    const remainingHiders = result.room?.players.some((player) => player.role === "hider" && !player.caught);
    if (result.caughtIds.length > 0 && !remainingHiders) {
      finishRoom(roomId, "seeker", "所有躲藏者都被找到，寻找者获胜");
      return;
    }
    io.to(roomId).emit("room:state", result.room ?? getRoom(roomId));
  });

  socket.on("drone:activate", ({ ability }: { ability: DroneAbility }) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId || !["recon", "fpv"].includes(ability)) return;
    const room = getRoom(roomId);
    if (!room || room.status !== "playing") {
      socket.emit("room:error", { message: "只有正式游戏阶段才能使用无人机" });
      return;
    }
    const map = getMap(room.mapId);
    const actor = room.players.find((player) => player.id === socket.id);
    const isTactical = map?.config.gameMode === "tactical-bomb";
    const expectedRole = isTactical ? "attacker" : "seeker";
    if (!actor || actor.role !== expectedRole || (isTactical ? (actor.health ?? 100) <= 0 : actor.caught)) {
      socket.emit("room:error", { message: isTactical ? "只有存活的进攻方可以使用无人机" : "只有未被抓捕的寻找者可以使用无人机" });
      return;
    }
    if (ability === "fpv" && isTactical) {
      socket.emit("room:error", { message: "穿越机已升级为可飞行实体，请使用 fpv:launch 发射" });
      return;
    }
    if (!consumeDroneCharge(roomId, socket.id, ability)) {
      socket.emit("room:error", { message: ability === "recon" ? "侦察机本局已使用" : "自爆穿越机本局已使用" });
      return;
    }

    const updatedRoom = getRoom(roomId);
    const updatedActor = updatedRoom?.players.find((player) => player.id === socket.id);
    if (!updatedRoom || !updatedActor) return;

    // recon 分支：原地扫描（两种模式共用）
    const scanRadius = 36;
    const expiresAt = new Date(Date.now() + 8000).toISOString();
    const scanRadiusSquared = scanRadius * scanRadius;
    const targetRole = isTactical ? "defender" : "hider";
    const targets = updatedRoom.players
      .filter((player) => player.role === targetRole && (isTactical ? (player.health ?? 100) > 0 : !player.caught))
      .filter((player) => {
        const dx = player.position[0] - updatedActor.position[0];
        const dz = player.position[2] - updatedActor.position[2];
        return dx * dx + dz * dz <= scanRadiusSquared;
      })
      .map((player) => ({ id: player.id, name: player.name, position: [...player.position] as Vec3, expiresAt }));
    socket.emit("drone:scan-result", { targets, expiresAt, message: targets.length > 0 ? `侦察机发现 ${targets.length} 名${isTactical ? "防守方" : "躲藏者"}` : "侦察机未发现附近目标" });
    io.to(roomId).emit("room:state", updatedRoom);
  });

  // FPV 穿越机：发射（先扣次数再创建实体）
  socket.on("fpv:launch", () => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    const room = getRoom(roomId);
    const map = room ? getMap(room.mapId) : undefined;
    if (!room || !map || room.status !== "playing" || map.config.gameMode !== "tactical-bomb") {
      socket.emit("room:error", { message: "当前不能发射穿越机" });
      return;
    }
    const actor = room.players.find((player) => player.id === socket.id);
    if (!actor || actor.role !== "attacker" || (actor.health ?? 100) <= 0) {
      socket.emit("room:error", { message: "只有存活的进攻方可以发射穿越机" });
      return;
    }
    if (!consumeDroneCharge(roomId, socket.id, "fpv")) {
      socket.emit("room:error", { message: "自爆穿越机本回合已使用" });
      return;
    }
    const result = launchFpvDrone(roomId, socket.id);
    if (!result) {
      // 已有飞行中的穿越机：退还次数
      const restored = getRoom(roomId);
      if (restored) {
        const owner = restored.players.find((player) => player.id === socket.id);
        if (owner?.droneLoadout) {
          updatePlayer(roomId, socket.id, { droneLoadout: { ...owner.droneLoadout, fpv: owner.droneLoadout.fpv + 1 } });
        }
      }
      socket.emit("room:error", { message: "你已有一架飞行中的穿越机" });
      return;
    }
    io.to(roomId).emit("round:event", { type: "drone-fpv", message: `${actor.name} 释放了自爆穿越机` });
    io.to(roomId).emit("room:state", result.room);
  });

  // FPV 穿越机：持帧位置上报（服务端限速 + 撞墙击落）
  socket.on("fpv:update", ({ droneId, position, yaw }: { droneId: string; position: Vec3; yaw?: number }) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId || typeof droneId !== "string") return;
    const position0 = Number(position?.[0]);
    const position1 = Number(position?.[1]);
    const position2 = Number(position?.[2]);
    if (![position0, position1, position2].every(Number.isFinite)) return;
    const result = updateFpvDrone(roomId, socket.id, droneId, [position0, position1, position2], Number(yaw) || 0);
    if (!result) return;
    if (result.destroyed) {
      const drone = (result.room.fpvDrones ?? []).find((item) => item.id === droneId);
      io.to(roomId).emit("round:event", { type: "drone-destroyed", message: drone ? `${drone.ownerName} 的穿越机撞毁` : "穿越机撞毁" });
      io.to(roomId).emit("room:state", result.room);
    }
  });

  // FPV 穿越机：引爆（范围伤害，不含自己）
  socket.on("fpv:detonate", ({ droneId }: { droneId?: string }) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || room.status !== "playing") return;
    const targetId = typeof droneId === "string" && droneId
      ? droneId
      : (room.fpvDrones ?? []).find((drone) => drone.ownerId === socket.id && drone.state === "flying")?.id;
    if (!targetId) return;
    const result = detonateFpvDrone(roomId, socket.id, targetId);
    if (!result) return;
    if (result.notArmed) {
      socket.emit("room:error", { message: "穿越机起飞保护中，稍后才能引爆" });
      return;
    }
    io.to(roomId).emit("round:event", {
      type: "drone-fpv",
      message: result.hitIds.length > 0
        ? `自爆穿越机引爆，波及 ${result.hitIds.length} 名玩家`
        : "自爆穿越机已引爆，但没有命中目标",
    });
    if (!checkTacticalVictory(roomId)) io.to(roomId).emit("room:state", result.room);
  });

  socket.on("weapon:fire", () => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    const room = getRoom(roomId);
    const map = room ? getMap(room.mapId) : undefined;
    if (!room || !map || map.config.gameMode !== "tactical-bomb" || room.status !== "playing") return;

    const result = shootPlayer(roomId, socket.id);
    if (!result.room) return;

    switch (result.outcome) {
      case "hit": {
        if (result.killed) {
          io.to(roomId).emit("round:event", { type: "kill", message: `${result.targetName ?? "目标"} 已被击倒` });
        } else {
          socket.emit("combat:feedback", { type: "hit", targetName: result.targetName });
        }
        break;
      }
      case "blocked": {
        socket.emit("combat:feedback", { type: "blocked", wallDistance: result.wallDistance });
        break;
      }
      case "empty": {
        socket.emit("combat:feedback", { type: "empty" });
        break;
      }
      case "reloading": {
        socket.emit("combat:feedback", { type: "reloading" });
        break;
      }
      case "miss": {
        // 未命中玩家：尝试命中敌方穿越机（击落）
        const droneHit = shootDownDrone(roomId, socket.id);
        if (droneHit.droneId && droneHit.room) {
          const drone = (droneHit.room.fpvDrones ?? []).find((item) => item.id === droneHit.droneId);
          io.to(roomId).emit("round:event", { type: "drone-destroyed", message: `${drone?.ownerName ?? "对方"} 的穿越机被击落` });
          io.to(roomId).emit("room:state", droneHit.room);
          return;
        }
        break;
      }
      default:
        break;
    }
    if (!checkTacticalVictory(roomId)) io.to(roomId).emit("room:state", result.room);
  });

  socket.on("weapon:reload", () => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    const result = reloadWeapon(roomId, socket.id);
    if (!result) return;
    io.to(roomId).emit("round:event", { type: "reload", message: "正在换弹…" });
    io.to(roomId).emit("room:state", result.room);
    const key = `${roomId}:${socket.id}`;
    clearReloadTimer(key);
    const timer = setTimeout(() => {
      settleReload(roomId, socket.id);
    }, result.duration);
    reloadTimers.set(key, timer);
  });

  socket.on("bomb:plant", ({ siteId }: { siteId: string }) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    const result = plantBomb(roomId, socket.id, String(siteId ?? ""));
    if (!result) {
      socket.emit("room:error", { message: "你不在爆破点范围内，或当前不能安装炸弹" });
      return;
    }
    if (result.bomb.explodesAt) scheduleBombExplosion(roomId, result.bomb.explodesAt);
    io.to(roomId).emit("round:event", { type: "bomb-planted", message: `炸弹已安装在 ${result.bomb.siteId.toUpperCase()}，防守方开始拆除` });
    io.to(roomId).emit("room:state", result.room);
  });

  // 拆弹：长按 E 持续上报（每次按下触发；断线/移动/松开都会取消）
  socket.on("bomb:defuse", () => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    const previousDeadline = getRoom(roomId)?.bomb?.defusingUntil;
    const result = startDefuse(roomId, socket.id);
    if (!result) {
      socket.emit("room:error", { message: "需要靠近已安装的炸弹（4 米内）才能拆除" });
      return;
    }
    const freshRoom = getRoom(roomId);
    // 幂等保护：仅当本房间结算定时器已注册时跳过（长按 E 每 80ms 上报一次）。
    // 不能用 defusingUntil 判断——startDefuse 首次调用即会设置它，否则定时器永远不会注册。
    const alreadyScheduled = defuseTimers.has(timerKey(roomId));
    io.to(roomId).emit("room:state", freshRoom ?? result.room);
    if (alreadyScheduled && previousDeadline === result.defusingUntil) return;
    io.to(roomId).emit("round:event", { type: "defuse-start", message: "防守方正在拆除炸弹" });
    clearDefuseTimer(roomId);
    const delay = Math.max(0, result.defusingUntil - Date.now());
    const timer = setTimeout(() => {
      settleDefuse(roomId);
    }, delay);
    defuseTimers.set(timerKey(roomId), timer);
  });

  // 拆弹取消（松开 E / 移动）
  socket.on("bomb:defuse:cancel", () => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room?.bomb?.defusingUntil || room.bomb.defuserId !== socket.id) return;
    const cancelled = cancelDefuse(roomId);
    if (cancelled) {
      clearDefuseTimer(roomId);
      io.to(roomId).emit("round:event", { type: "defuse-cancelled", message: "拆弹被中断" });
      io.to(roomId).emit("room:state", cancelled);
    }
  });

  socket.on("room:start", () => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    const currentRoom = getRoom(roomId);
    if (!currentRoom) return;
    if (currentRoom.hostId !== socket.id) {
      socket.emit("room:error", { message: "只有房主可以开始游戏" });
      return;
    }
    if (currentRoom.players.length < 2) {
      socket.emit("room:error", { message: "至少需要 2 名玩家才能开始" });
      return;
    }
    const room = prepareGame(roomId);
    if (!room || !room.preparingEndsAt) return;
    scheduleGameStart(roomId, room.preparingEndsAt);
    io.to(roomId).emit("room:state", room);
  });

  socket.on("room:restart", () => {
    const roomId = socket.data.roomId as string | undefined;
    const currentRoom = roomId ? getRoom(roomId) : undefined;
    if (!roomId || !currentRoom || currentRoom.hostId !== socket.id || currentRoom.status !== "ended" || currentRoom.nextRoundAt !== undefined) {
      socket.emit("room:error", { message: "整场结束后，由房主开始新一场比赛" });
      return;
    }
    if (currentRoom.players.length < 2) return;
    clearNextRoundTimer(roomId);
    clearRoomTimer(roomId);
    clearBombTimer(roomId);
    clearDefuseTimer(roomId);
    cancelPreparation(roomId);
    const room = prepareGame(roomId);
    if (room?.preparingEndsAt) scheduleGameStart(roomId, room.preparingEndsAt);
    io.to(roomId).emit("room:state", room);
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom();
  });
});

// Keep API, Socket.IO, and upload paths out of the SPA fallback so missing backend
// resources retain their normal 404 responses.
app.use(["/api", "/uploads", "/socket.io"], (_request, response) => {
  response.sendStatus(404);
});
app.use(express.static(clientDistRoot));
app.use((request, response, next) => {
  if (request.method !== "GET" && request.method !== "HEAD") return next();
  if (path.extname(request.path) || !request.accepts("html")) return next();
  if (!existsSync(clientIndexPath)) return next();
  return response.sendFile(clientIndexPath);
});

server.listen(PORT, () => {
  console.log(`Drone Hide API listening on http://localhost:${PORT}`);
});
