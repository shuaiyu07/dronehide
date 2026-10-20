import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowUpRight,
  Box,
  Boxes,
  CheckCircle2,
  ClipboardList,
  CircleHelp,
  CloudUpload,
  Copy,
  Gamepad2,
  LayoutDashboard,
  Map,
  PackageCheck,
  PackagePlus,
  Plane,
  Play,
  Plus,
  Radio,
  Settings2,
  Users,
} from "lucide-react";
import { addLocalMap, addRemoteMap, createDroneMission, createRoom, getDroneMissions, getDroneSdkStatus, getHealth, getMaps, getResourcePacks, getRoom, getRooms, importMap, importMapPackage, importResourcePack, updateDroneMissionStatus, updateMapConfig, type RemoteMapInput } from "./api";
import GameRoom from "./GameRoom";
import MapConfigEditor from "./MapConfigEditor";
import TestScene from "./TestScene";
import type { ApiHealth, DroneMission, DroneMissionStatus, DroneSdkStatus, MapConfig, MapInfo, MapProvenanceType, ResourcePackInfo, RoomSummary } from "../../shared/types.ts";

type Section = "overview" | "maps" | "rooms" | "missions" | "resources";

const navItems: { id: Section; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "项目总览", icon: LayoutDashboard },
  { id: "maps", label: "地图管理", icon: Map },
  { id: "rooms", label: "联机房间", icon: Radio },
  { id: "missions", label: "无人机任务", icon: Plane },
  { id: "resources", label: "资源包", icon: PackageCheck },
];

const missionStatusLabels: Record<DroneMissionStatus, string> = {
  planned: "计划中",
  captured: "已采集",
  "model-ready": "模型已生成",
};

type RemoteMapPreset = RemoteMapInput & {
  id: string;
  fileName?: string;
  bestFor: string;
  scaleHint: string;
  createConfig: (mapId: string) => MapConfig;
};

function harbourSquareConfig(mapId: string): MapConfig {
  return {
    mapId,
    gameMode: "tactical-bomb",
    bounds: {
      min: [-42, 0, -34],
      max: [42, 24, 34],
    },
    rules: {
      prepareTime: 20,
      gameTime: 360,
      catchDistance: 2.5,
      maxPlayers: 12,
      roundsToWin: 1,
      bombTime: 40,
    },
    spawnPoints: [
      { id: "attacker-harbour-south", role: "attacker", position: [0, 1.7, -25], rotation: [0, 0, 0] },
      { id: "attacker-market-west", role: "attacker", position: [-21, 1.7, 7], rotation: [0, 0.7, 0] },
      { id: "defender-warehouse-east", role: "defender", position: [22, 1.7, 6], rotation: [0, -0.7, 0] },
      { id: "defender-quay-north", role: "defender", position: [0, 1.7, 24], rotation: [0, Math.PI, 0] },
    ],
    zones: [
      { id: "harbour-market-hide", name: "市场摊位躲藏区", center: [-16, 0, 8], radius: 9, kind: "hide" },
      { id: "harbour-warehouse-hide", name: "仓储建筑躲藏区", center: [18, 0, 5], radius: 9, kind: "hide" },
      { id: "harbour-mid-control", name: "中路无人机侦察区", center: [0, 0, -4], radius: 12, kind: "safe" },
      { id: "harbour-quay-limit", name: "码头边缘禁区", center: [0, 0, 29], radius: 5, kind: "forbidden" },
    ],
    bombSites: [
      { id: "site-a", name: "爆破点 A · 仓储区", center: [-16, 0, 8], radius: 6 },
      { id: "site-b", name: "爆破点 B · 码头区", center: [18, 0, 5], radius: 6 },
    ],
  };
}

const remoteMapPresets: RemoteMapPreset[] = [
  {
    id: "3dassets-harbour-square",
    name: "港口广场写实地图",
    description: "来自 3DAssets.dev 的 CC0 写实港口广场场景，当前使用项目已有的本地 2.4 MB GLB 副本，适合战术爆破原型。",
    fileName: "harbour-square-payload-v1.0.0.glb",
    modelUrl: "/uploads/maps/harbour-square-payload-v1.0.0.glb",
    sourceUrl: "https://3dassets.dev/assets/hero-shooter-harbour-payload-harbour-squ-d9c52d90-starter-scene",
    license: "CC0 1.0 Universal",
    attribution: "3DAssets.dev / CC0，无强制署名要求；保留来源记录",
    bestFor: "写实港口、仓储区、A/B 爆破点、无人机支援",
    scaleHint: "中大型场景，预设 12 人边界、两队出生点和 A/B 爆破点",
    createConfig: harbourSquareConfig,
  },
];

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function provenanceLabel(type: MapProvenanceType) {
  if (type === "drone-sdk") return "无人机 SDK 建模成果";
  if (type === "open-source") return "开源三维地图";
  return "内置测试场景";
}

function mapStatusLabel(status: MapInfo["status"]) {
  if (status === "configured") return "已配置";
  if (status === "published") return "已发布";
  return "待配置";
}

function mapSourceLabel(source: MapInfo["source"]) {
  if (source === "remote") return "网络 GLB 地图";
  if (source === "glb") return "本地 GLB 地图";
  return "程序化测试场景";
}

function roomStatusLabel(status: RoomSummary["status"]) {
  if (status === "waiting") return "等待中";
  if (status === "preparing") return "准备中";
  if (status === "playing") return "游戏中";
  return "已结束";
}

function resourceKindLabel(kind: ResourcePackInfo["assets"][number]["kind"]) {
  if (kind === "character") return "角色";
  if (kind === "model") return "模型";
  if (kind === "marker") return "标记";
  if (kind === "effect") return "特效";
  if (kind === "sound") return "音效";
  if (kind === "ui") return "界面";
  if (kind === "texture") return "贴图";
  return "道具";
}

function isRuntimeModelAsset(asset: ResourcePackInfo["assets"][number]) {
  const format = asset.format?.toLowerCase();
  const path = asset.path?.toLowerCase() ?? "";
  return Boolean(asset.path) && (asset.kind === "character" || asset.kind === "model") && (format === "glb" || format === "gltf" || /\.(glb|gltf)$/.test(path));
}

function runtimeModelAssetCount(pack: ResourcePackInfo) {
  return pack.assets.filter(isRuntimeModelAsset).length;
}

function resourcePackKey(pack: ResourcePackInfo) {
  return pack.baseUrl ?? `built-in:${pack.id}:${pack.version}`;
}

function findResourcePackByBaseUrl(resourcePacks: ResourcePackInfo[], baseUrl?: string) {
  return baseUrl ? resourcePacks.find((pack) => pack.baseUrl === baseUrl) ?? null : null;
}

function findExistingPresetMap(maps: MapInfo[], preset: RemoteMapPreset) {
  return maps.find((map) => map.modelUrl === preset.modelUrl || map.provenance.sourceUrl === preset.sourceUrl) ?? null;
}

function remoteMapInputFromPreset(preset: RemoteMapPreset): RemoteMapInput {
  const { id: _id, fileName: _fileName, bestFor: _bestFor, scaleHint: _scaleHint, createConfig: _createConfig, ...input } = preset;
  return input;
}

function App() {
  const [section, setSection] = useState<Section>("overview");
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [droneSdk, setDroneSdk] = useState<DroneSdkStatus | null>(null);
  const [missions, setMissions] = useState<DroneMission[]>([]);
  const [resourcePacks, setResourcePacks] = useState<ResourcePackInfo[]>([]);
  const [maps, setMaps] = useState<MapInfo[]>([]);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [copiedRoomId, setCopiedRoomId] = useState<string | null>(null);
  const [roomNotice, setRoomNotice] = useState("");
  const [showMapImporter, setShowMapImporter] = useState(false);
  const [showMapPackageImporter, setShowMapPackageImporter] = useState(false);
  const [showRemoteMapForm, setShowRemoteMapForm] = useState(false);
  const [mapFile, setMapFile] = useState<File | null>(null);
  const [mapPackageManifest, setMapPackageManifest] = useState<File | null>(null);
  const [mapPackageScene, setMapPackageScene] = useState<File | null>(null);
  const [mapPackageCollision, setMapPackageCollision] = useState<File | null>(null);
  const [mapPackageThumbnail, setMapPackageThumbnail] = useState<File | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isImportingMapPackage, setIsImportingMapPackage] = useState(false);
  const [isAddingRemoteMap, setIsAddingRemoteMap] = useState(false);
  const [showResourceImporter, setShowResourceImporter] = useState(false);
  const [resourceManifest, setResourceManifest] = useState<File | null>(null);
  const [resourceAssets, setResourceAssets] = useState<File[]>([]);
  const [selectedResourcePackKey, setSelectedResourcePackKey] = useState<string | null>(null);
  const [isImportingResourcePack, setIsImportingResourcePack] = useState(false);
  const [isEditingConfig, setIsEditingConfig] = useState(false);
  const [isSavingMission, setIsSavingMission] = useState(false);
  const [missionDraft, setMissionDraft] = useState({
    name: "",
    provider: "",
    aircraftModel: "",
    cameraModel: "",
    captureDate: new Date().toISOString().slice(0, 10),
    status: "planned" as DroneMissionStatus,
    notes: "",
  });
  const [mapDraft, setMapDraft] = useState({
    name: "",
    description: "",
    provenanceType: "open-source" as Exclude<MapProvenanceType, "built-in">,
    sourceUrl: "",
    license: "",
    attribution: "",
    missionId: "",
  });
  const [remoteMapDraft, setRemoteMapDraft] = useState({
    name: "",
    description: "",
    modelUrl: "",
    sourceUrl: "",
    license: "",
    attribution: "",
  });

  const selectedMap = useMemo(
    () => maps.find((map) => map.id === selectedMapId)
      ?? maps.find((map) => map.source === "procedural" && map.config.gameMode === "tactical-bomb" && map.status === "configured")
      ?? maps.find((map) => map.source !== "procedural" && map.status === "configured")
      ?? maps[0],
    [maps, selectedMapId],
  );

  const selectedResourcePack = useMemo(
    () => resourcePacks.find((pack) => selectedResourcePackKey === resourcePackKey(pack))
      ?? resourcePacks.find((pack) => !pack.builtIn && runtimeModelAssetCount(pack) > 0)
      ?? resourcePacks.find((pack) => runtimeModelAssetCount(pack) > 0)
      ?? resourcePacks.find((pack) => pack.builtIn)
      ?? resourcePacks[0]
      ?? null,
    [resourcePacks, selectedResourcePackKey],
  );

  const inviteUrlFor = (roomId: string) => {
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("room", roomId);
    return url.toString();
  };

  const openRoom = (roomId: string) => {
    setActiveRoomId(roomId);
    window.history.replaceState(null, "", inviteUrlFor(roomId));
  };

  const closeRoom = () => {
    setActiveRoomId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState(null, "", url);
  };

  const refresh = async () => {
    const [healthResult, mapsResult, roomsResult, sdkResult, missionsResult, resourcePacksResult] = await Promise.all([
      getHealth(), getMaps(), getRooms(), getDroneSdkStatus(), getDroneMissions(), getResourcePacks(),
    ]);
    setHealth(healthResult);
    setMaps(mapsResult);
    setRooms(roomsResult);
    setDroneSdk(sdkResult);
    setMissions(missionsResult);
    setResourcePacks(resourcePacksResult);

    const inviteRoomId = new URLSearchParams(window.location.search).get("room")?.trim().toUpperCase();
    if (!inviteRoomId) return;
    try {
      const room = await getRoom(inviteRoomId);
      setRooms((current) => [room, ...current.filter((item) => item.id !== room.id)]);
      setActiveRoomId(room.id);
    } catch {
      setRoomNotice("邀请链接已失效，或对应的房间已经关闭");
      closeRoom();
    }
  };

  useEffect(() => {
    let disposed = false;
    const retryRefresh = () => {
      refresh()
        .then(() => {
          if (!disposed) setRoomNotice((current) => current === "后端还没有启动，请先运行 npm run dev" ? "" : current);
        })
        .catch(() => {
          if (!disposed) setRoomNotice("后端还没有启动，正在自动重试…");
        });
    };
    retryRefresh();
    const retryTimer = window.setInterval(retryRefresh, 4000);
    return () => {
      disposed = true;
      window.clearInterval(retryTimer);
    };
  }, []);

  const handleCreateMission = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSavingMission(true);
    try {
      const mission = await createDroneMission({
        ...missionDraft,
        captureDate: new Date(`${missionDraft.captureDate}T12:00:00`).toISOString(),
      });
      setMissions((current) => [mission, ...current]);
      setMissionDraft((current) => ({ ...current, name: "", notes: "" }));
      setRoomNotice(`采集任务“${mission.name}”已登记`);
    } catch (error) {
      setRoomNotice(error instanceof Error ? error.message : "采集任务登记失败");
    } finally {
      setIsSavingMission(false);
    }
  };

  const handleMissionStatusChange = async (missionId: string, status: DroneMissionStatus) => {
    try {
      const mission = await updateDroneMissionStatus(missionId, status);
      setMissions((current) => current.map((item) => item.id === mission.id ? mission : item));
      setRoomNotice(`任务“${mission.name}”已更新为：${missionStatusLabels[mission.status]}`);
    } catch (error) {
      setRoomNotice(error instanceof Error ? error.message : "采集任务状态更新失败");
    }
  };

  const handleCreateRoom = async () => {
    if (!selectedMap) return;
    try {
      const room = await createRoom(`测试房间 ${rooms.length + 1}`, selectedMap.id, selectedResourcePack?.baseUrl);
      setRoomNotice(`房间 ${room.id} 已创建`);
      setRooms((current) => [room, ...current]);
      setSection("rooms");
      openRoom(room.id);
    } catch {
      setRoomNotice("创建房间失败，请确认后端正在运行");
    }
  };

  const handleJoinRoomByCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = roomCodeInput.trim().toUpperCase();
    if (!code) return;
    try {
      const room = await getRoom(code);
      setRooms((current) => [room, ...current.filter((item) => item.id !== room.id)]);
      setRoomCodeInput("");
      openRoom(room.id);
    } catch {
      setRoomNotice("没有找到这个房间，请检查房间码");
    }
  };

  const handleMapImport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mapFile) {
      setRoomNotice("请先选择一个 .glb 地图文件");
      return;
    }
    setIsImporting(true);
    try {
      const map = await importMap({ file: mapFile, ...mapDraft });
      setMaps((current) => [map, ...current]);
      setSelectedMapId(map.id);
      setRoomNotice(`地图“${map.name}”已导入，下一步请配置出生点和边界`);
      setShowMapImporter(false);
      setMapFile(null);
      setMapDraft({ name: "", description: "", provenanceType: "open-source", sourceUrl: "", license: "", attribution: "", missionId: "" });
    } catch (error) {
      setRoomNotice(error instanceof Error ? error.message : "地图导入失败");
    } finally {
      setIsImporting(false);
    }
  };

  const handleMapPackageImport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mapPackageManifest || !mapPackageScene) {
      setRoomNotice("地图包至少需要 manifest.json 和场景文件");
      return;
    }
    setIsImportingMapPackage(true);
    try {
      const map = await importMapPackage({ manifest: mapPackageManifest, scene: mapPackageScene, collision: mapPackageCollision, thumbnail: mapPackageThumbnail });
      setMaps((current) => [map, ...current]);
      setSelectedMapId(map.id);
      setRoomNotice(`地图包“${map.name}”已导入，可以继续配置出生点和规则`);
      setShowMapPackageImporter(false);
      setMapPackageManifest(null);
      setMapPackageScene(null);
      setMapPackageCollision(null);
      setMapPackageThumbnail(null);
    } catch (error) {
      setRoomNotice(error instanceof Error ? error.message : "地图包导入失败");
    } finally {
      setIsImportingMapPackage(false);
    }
  };

  const handleResourcePackImport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resourceManifest) {
      setRoomNotice("请先选择资源包 manifest.json");
      return;
    }
    setIsImportingResourcePack(true);
    try {
      const pack = await importResourcePack({ manifest: resourceManifest, assets: resourceAssets });
      setResourcePacks((current) => [pack, ...current.filter((item) => item.baseUrl !== pack.baseUrl)]);
      setSelectedResourcePackKey(resourcePackKey(pack));
      setRoomNotice(`资源包“${pack.name}”已导入`);
      setShowResourceImporter(false);
      setResourceManifest(null);
      setResourceAssets([]);
    } catch (error) {
      setRoomNotice(error instanceof Error ? error.message : "资源包导入失败");
    } finally {
      setIsImportingResourcePack(false);
    }
  };

  const handleMapConfigSave = async (config: MapConfig) => {
    if (!selectedMap) return;
    const updatedMap = await updateMapConfig(selectedMap.id, config);
    setMaps((current) => current.map((map) => map.id === updatedMap.id ? updatedMap : map));
    setIsEditingConfig(false);
    setRoomNotice(`地图“${updatedMap.name}”的出生点、区域和游戏规则已保存`);
  };

  const copyRoomInvite = async (roomId: string) => {
    const inviteUrl = inviteUrlFor(roomId);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(inviteUrl);
      setCopiedRoomId(roomId);
      setRoomNotice("邀请链接已复制，直接发给队友即可");
      window.setTimeout(() => setCopiedRoomId((current) => current === roomId ? null : current), 1800);
    } catch {
      window.prompt("复制这条邀请链接发给队友", inviteUrl);
    }
  };

  const handleRemoteMapAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsAddingRemoteMap(true);
    try {
      const map = await addRemoteMap(remoteMapDraft);
      setMaps((current) => [map, ...current]);
      setSelectedMapId(map.id);
      setRoomNotice(`网络地图“${map.name}”已登记，正在按 URL 加载预览`);
      setShowRemoteMapForm(false);
      setRemoteMapDraft({ name: "", description: "", modelUrl: "", sourceUrl: "", license: "", attribution: "" });
    } catch (error) {
      setRoomNotice(error instanceof Error ? error.message : "网络地图登记失败");
    } finally {
      setIsAddingRemoteMap(false);
    }
  };

  const handleRemoteMapPresetAdd = async (preset: RemoteMapPreset) => {
    const existing = findExistingPresetMap(maps, preset);
    if (existing) {
      setSelectedMapId(existing.id);
      setSection("maps");
      setIsAddingRemoteMap(true);
      try {
        const updatedMap = await updateMapConfig(existing.id, preset.createConfig(existing.id));
        setMaps((current) => current.map((map) => map.id === updatedMap.id ? updatedMap : map));
        setRoomNotice(`已选中本地写实地图“${existing.name}”，并应用了战术爆破推荐配置，可以继续微调`);
      } catch (error) {
        setRoomNotice(error instanceof Error ? error.message : "地图推荐配置应用失败");
      } finally {
        setIsAddingRemoteMap(false);
      }
      return;
    }
    setIsAddingRemoteMap(true);
    try {
      const map = preset.fileName
        ? await addLocalMap({ fileName: preset.fileName, name: preset.name, description: preset.description, sourceUrl: preset.sourceUrl, license: preset.license, attribution: preset.attribution })
        : await addRemoteMap(remoteMapInputFromPreset(preset));
      const configuredMap = await updateMapConfig(map.id, preset.createConfig(map.id));
      setMaps((current) => [configuredMap, ...current]);
      setSelectedMapId(configuredMap.id);
      setSection("maps");
      setRoomNotice(`${preset.fileName ? "本地写实地图" : "远程写实地图"}“${configuredMap.name}”已接入，并应用了战术爆破推荐配置`);
    } catch (error) {
      setRoomNotice(error instanceof Error ? error.message : "远程地图接入失败");
    } finally {
      setIsAddingRemoteMap(false);
    }
  };


  const stats = [
    { label: "可用地图", value: maps.length.toString().padStart(2, "0"), hint: "当前已配置", icon: Map, tone: "teal" },
    { label: "在线房间", value: rooms.length.toString().padStart(2, "0"), hint: "内存房间", icon: Radio, tone: "amber" },
    { label: "系统状态", value: health?.ok ? "正常" : "--", hint: health?.ok ? "API 已连接" : "等待连接", icon: Activity, tone: "green" },
    { label: "采集任务", value: missions.length.toString().padStart(2, "0"), hint: "SDK 工作流记录", icon: Plane, tone: "amber" },
  ];

  const activeRoom = activeRoomId ? rooms.find((room) => room.id === activeRoomId) : null;
  const activeRoomMap = activeRoom ? maps.find((map) => map.id === activeRoom.mapId) : null;
  const activeRoomResourcePack = findResourcePackByBaseUrl(resourcePacks, activeRoom?.resourcePackBaseUrl) ?? selectedResourcePack;

  if (activeRoom && activeRoomMap) {
    return <GameRoom roomId={activeRoom.id} map={activeRoomMap} inviteUrl={inviteUrlFor(activeRoom.id)} resourcePack={activeRoomResourcePack} onExit={closeRoom} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><Boxes size={21} strokeWidth={2.2} /></div>
          <div>
            <strong>DRONE HIDE</strong>
            <span>PLATFORM / PHASE 01</span>
          </div>
        </div>

        <div className="sidebar-section-label">工作台</div>
        <nav className="main-nav">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${section === id ? "active" : ""}`} onClick={() => setSection(id)}>
              <Icon size={18} />
              <span>{label}</span>
              {id === "rooms" && rooms.length > 0 ? <em>{rooms.length}</em> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-section-label">系统</div>
        <button className="nav-item muted"><Settings2 size={18} /><span>项目设置</span></button>
        <button className="nav-item muted"><CircleHelp size={18} /><span>开发说明</span></button>

        <div className="sidebar-footer">
          <div className="connection-row"><span className={`status-dot ${health?.ok ? "online" : ""}`} />{health?.ok ? "开发服务已连接" : "等待后端服务"}</div>
          <small>v0.1.0 · 本地开发环境</small>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <div className="breadcrumb">无人机实景地图 / Web 游戏化平台</div>
            <h1>{section === "overview" ? "项目总览" : section === "maps" ? "地图管理" : section === "rooms" ? "联机房间" : section === "missions" ? "无人机任务" : "资源包"}</h1>
          </div>
          <div className="topbar-actions">
            <div className="api-pill"><span className={`status-dot ${health?.ok ? "online" : ""}`} /> API {health?.ok ? "ONLINE" : "OFFLINE"}</div>
            <button className="primary-button" onClick={handleCreateRoom}><Plus size={17} />创建测试房间</button>
          </div>
        </header>

        {roomNotice ? <div className="notice-bar"><CheckCircle2 size={17} />{roomNotice}<button onClick={() => setRoomNotice("")}>关闭</button></div> : null}

        {section === "overview" && selectedMap ? (
          <div className="page-body">
            <section className="intro-band">
              <div>
                <div className="eyebrow"><span className="eyebrow-line" />{selectedMap.source === "procedural" ? "PHASE 01 / TEST ENVIRONMENT" : "PHASE 02 / MAP READY"}</div>
                <h2>{selectedMap.source === "procedural" ? <>先让平台跑起来，<br /><span>再接入真实航拍地图。</span></> : <>真实地图已经接入，<br /><span>现在开始联机测试。</span></>}</h2>
                <p>{selectedMap.source === "procedural" ? "当前使用程序化校园场景模拟无人机三维地图。地图准备好后，可以直接在地图管理中导入并配置。" : "当前地图已经完成网络加载、来源登记和游戏区域配置，可以创建房间进行多人捉迷藏测试。"}</p>
                <div className="intro-actions">
                  <button className="primary-button" onClick={() => setSection("maps")}><Map size={17} />查看测试地图</button>
                  <button className="text-button" onClick={() => setSection("rooms")}>进入房间管理 <ArrowUpRight size={16} /></button>
                </div>
              </div>
              <div className="intro-meta">
                <div className="meta-line"><span>当前地图</span><strong>{selectedMap.name}</strong></div>
                <div className="meta-line"><span>地图来源</span><strong>{mapSourceLabel(selectedMap.source)}</strong></div>
                <div className="meta-line"><span>下一步</span><strong>{selectedMap.source === "procedural" ? "导入真实地图" : "创建联机房间"}</strong></div>
              </div>
            </section>

            <section className="stats-grid">
              {stats.map(({ label, value, hint, icon: Icon, tone }) => (
                <div className="stat-card" key={label}>
                  <div className={`stat-icon ${tone}`}><Icon size={19} /></div>
                  <div><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>
                </div>
              ))}
            </section>

            <section className="workspace-panel">
                <div className="panel-heading">
                <div><div className="panel-kicker">LIVE PREVIEW</div><h3>{selectedMap.name}</h3></div>
                <div className="scene-legend">{selectedMap.config.gameMode === "tactical-bomb" ? <><span><i className="legend-dot seeker" />进攻方出生点</span><span><i className="legend-dot hider" />防守方出生点</span><span><i className="legend-dot zone" />爆破点</span></> : <><span><i className="legend-dot seeker" />寻找者出生点</span><span><i className="legend-dot hider" />躲藏者出生点</span><span><i className="legend-dot zone" />躲藏区域</span></>}</div>
              </div>
              <div className="scene-layout">
                <div className="scene-frame"><TestScene config={selectedMap.config} modelUrl={selectedMap.modelUrl} /><div className="scene-label"><Box size={15} />{selectedMap.modelUrl ? "Imported GLB / normalized preview" : "Procedural scene / no external model"}</div></div>
                <aside className="scene-notes">
                  <div className="notes-header"><Gamepad2 size={18} /><span>当前游戏配置</span></div>
                  <div className="config-list">
                    <div><span>游戏模式</span><strong>{selectedMap.config.gameMode === "tactical-bomb" ? "战术爆破" : "联机捉迷藏"}</strong></div>
                    <div><span>最大人数</span><strong>{selectedMap.config.rules.maxPlayers} 人</strong></div>
                    <div><span>准备时间</span><strong>{selectedMap.config.rules.prepareTime} 秒</strong></div>
                    <div><span>游戏时长</span><strong>{Math.round(selectedMap.config.rules.gameTime / 60)} 分钟</strong></div>
                  </div>
                  <div className="next-step"><CloudUpload size={18} /><div><strong>{selectedMap.source === "procedural" ? "地图生产链路" : "地图已准备"}</strong><span>{selectedMap.source === "procedural" ? "登记采集任务，完成建模后导入 GLB 并配置游戏区域" : "出生点、躲藏区和游戏规则已保存，可以进入联机房间测试"}</span></div></div>
                </aside>
              </div>
            </section>
          </div>
        ) : null}

        {section === "maps" ? (
          <div className="page-body">
            <div className="page-intro-row"><div><div className="panel-kicker">MAP REGISTRY</div><h2>地图管理</h2><p>管理内置场景、开源地图、无人机 SDK 建模成果和标准地图包。</p></div><div className="room-actions"><button className="secondary-button" onClick={() => setShowRemoteMapForm((current) => !current)}><CloudUpload size={17} />{showRemoteMapForm ? "收起网络地图" : "添加网络地图"}</button><button className="secondary-button" onClick={() => setShowMapImporter((current) => !current)}><CloudUpload size={17} />{showMapImporter ? "收起导入" : "导入本地 GLB"}</button><button className="primary-button" onClick={() => setShowMapPackageImporter((current) => !current)}><PackagePlus size={17} />{showMapPackageImporter ? "收起地图包" : "导入地图包"}</button></div></div>
            <section className="remote-preset-panel">
              <div className="remote-preset-head"><div><div className="panel-kicker">REALISTIC MAP STARTER</div><h3>可直接使用的写实地图</h3></div><span>港口 GLB 使用项目已有本地文件，不重复下载</span></div>
              <div className="remote-preset-grid">{remoteMapPresets.map((preset) => {
                const existing = findExistingPresetMap(maps, preset);
                return <article className="remote-preset-card" key={preset.id}>
                  <div><strong>{preset.name}</strong><span>{preset.license}</span></div>
                  <p>{preset.description}</p>
                  <div className="preset-meta"><span>{preset.bestFor}</span><span>{preset.scaleHint}</span></div>
                  <div className="resource-card-actions"><button className={existing ? "secondary-button" : "primary-button"} onClick={() => handleRemoteMapPresetAdd(preset)} disabled={isAddingRemoteMap}>{existing ? "已接入，选中地图" : preset.fileName ? "使用本地地图" : "接入远程地图"}</button></div>
                </article>;
              })}</div>
            </section>
            {showRemoteMapForm ? <section className="workspace-panel form-panel"><form onSubmit={handleRemoteMapAdd}>
              <div className="form-heading"><div><div className="panel-kicker">REMOTE MAP URL</div><h3>登记 GitHub / jsDelivr 地图</h3></div><span className="form-hint">只保存 URL，不下载地图到本机</span></div>
              <div className="form-grid">
                <label>地图名称<input value={remoteMapDraft.name} onChange={(event) => setRemoteMapDraft({ ...remoteMapDraft, name: event.target.value })} placeholder="例如：校园北区网络地图" required /></label>
                <label>GLB 网络地址<input type="url" value={remoteMapDraft.modelUrl} onChange={(event) => setRemoteMapDraft({ ...remoteMapDraft, modelUrl: event.target.value })} placeholder="https://cdn.jsdelivr.net/gh/用户名/仓库@v1.0.0/maps/map.glb" required /></label>
                <label>许可证<input value={remoteMapDraft.license} onChange={(event) => setRemoteMapDraft({ ...remoteMapDraft, license: event.target.value })} placeholder="例如：CC BY 4.0" required /></label>
                <label>原始来源链接<input type="url" value={remoteMapDraft.sourceUrl} onChange={(event) => setRemoteMapDraft({ ...remoteMapDraft, sourceUrl: event.target.value })} placeholder="GitHub 地图来源页面" /></label>
                <label>作者 / 署名<input value={remoteMapDraft.attribution} onChange={(event) => setRemoteMapDraft({ ...remoteMapDraft, attribution: event.target.value })} placeholder="作者、仓库或团队" /></label>
                <label className="wide-field">说明<textarea value={remoteMapDraft.description} onChange={(event) => setRemoteMapDraft({ ...remoteMapDraft, description: event.target.value })} placeholder="地图用途和备注" rows={3} /></label>
              </div>
              <div className="form-actions"><span>要求 HTTPS，且地址必须以 `.glb` 结尾。</span><button className="primary-button" type="submit" disabled={isAddingRemoteMap}>{isAddingRemoteMap ? "登记中..." : "保存网络地图"}</button></div>
            </form></section> : null}
            {showMapImporter ? <section className="workspace-panel form-panel"><form onSubmit={handleMapImport}>
              <div className="form-heading"><div><div className="panel-kicker">IMPORT PIPELINE</div><h3>导入三维地图</h3></div><span className="form-hint">最大 100 MB · 仅支持 `.glb`</span></div>
              <div className="form-grid">
                <label>地图文件<input type="file" accept=".glb,model/gltf-binary" onChange={(event) => setMapFile(event.target.files?.[0] ?? null)} required /></label>
                <label>地图名称<input value={mapDraft.name} onChange={(event) => setMapDraft({ ...mapDraft, name: event.target.value })} placeholder="例如：校园北区" required /></label>
                <label>来源类型<select value={mapDraft.provenanceType} onChange={(event) => setMapDraft({ ...mapDraft, provenanceType: event.target.value as Exclude<MapProvenanceType, "built-in">, missionId: "" })}><option value="open-source">开源三维地图</option><option value="drone-sdk">无人机 SDK 建模成果</option></select></label>
                {mapDraft.provenanceType === "drone-sdk" ? <label>关联采集任务<select value={mapDraft.missionId} onChange={(event) => setMapDraft({ ...mapDraft, missionId: event.target.value })} required><option value="">选择已生成模型的任务</option>{missions.filter((mission) => mission.status === "model-ready").map((mission) => <option key={mission.id} value={mission.id}>{mission.name} · {mission.id}</option>)}</select></label> : null}
                <label>许可证 / 来源说明<input value={mapDraft.license} onChange={(event) => setMapDraft({ ...mapDraft, license: event.target.value })} placeholder={mapDraft.provenanceType === "open-source" ? "例如：CC0 / MIT / CC BY 4.0" : "例如：无人机 SDK 航拍建模成果"} required={mapDraft.provenanceType === "open-source"} /></label>
                <label>来源链接<input value={mapDraft.sourceUrl} onChange={(event) => setMapDraft({ ...mapDraft, sourceUrl: event.target.value })} placeholder="GitHub 或资源原始地址" /></label>
                <label>作者 / 署名<input value={mapDraft.attribution} onChange={(event) => setMapDraft({ ...mapDraft, attribution: event.target.value })} placeholder="作者、仓库或团队" /></label>
                <label className="wide-field">说明<textarea value={mapDraft.description} onChange={(event) => setMapDraft({ ...mapDraft, description: event.target.value })} placeholder="地图用途、区域和备注" rows={3} /></label>
              </div>
              <div className="form-actions"><span>{mapFile ? `已选择：${mapFile.name}` : "请选择一个地图文件"}</span><button className="primary-button" type="submit" disabled={isImporting}>{isImporting ? "导入中..." : "保存地图"}</button></div>
            </form></section> : null}
            {showMapPackageImporter ? <section className="workspace-panel form-panel"><form onSubmit={handleMapPackageImport}>
              <div className="form-heading"><div><div className="panel-kicker">DHMAP PACKAGE IMPORT</div><h3>导入标准地图包</h3></div><span className="form-hint">manifest.json + scene + 可选碰撞体 / 缩略图</span></div>
              <div className="form-grid">
                <label>地图包清单<input type="file" accept=".json,application/json" onChange={(event) => setMapPackageManifest(event.target.files?.[0] ?? null)} required /></label>
                <label>场景文件<input type="file" onChange={(event) => setMapPackageScene(event.target.files?.[0] ?? null)} required /></label>
                <label>碰撞文件<input type="file" onChange={(event) => setMapPackageCollision(event.target.files?.[0] ?? null)} /></label>
                <label>缩略图<input type="file" accept="image/*" onChange={(event) => setMapPackageThumbnail(event.target.files?.[0] ?? null)} /></label>
              </div>
              <div className="form-actions"><span>{mapPackageManifest && mapPackageScene ? `已选择清单和场景：${mapPackageScene.name}` : "manifest 的 scene.path 必须对应场景文件名"}</span><button className="primary-button" type="submit" disabled={isImportingMapPackage}>{isImportingMapPackage ? "导入中..." : "导入地图包"}</button></div>
            </form></section> : null}
            <div className="map-grid">{maps.map((map) => <article className={`map-card ${selectedMap?.id === map.id ? "selected" : ""}`} key={map.id} onClick={() => setSelectedMapId(map.id)}><div className="map-card-visual"><Map size={27} /><span>{map.source === "procedural" ? "TEST SCENE" : "GLB MODEL"}</span></div><div className="map-card-body"><div className="map-card-title"><h3>{map.name}</h3><span className={`status-tag ${map.status}`}>{mapStatusLabel(map.status)}</span></div><p>{map.description}</p><div className="map-card-footer"><span>{provenanceLabel(map.provenance.type)}</span><span>{formatTime(map.updatedAt)}</span></div></div></article>)}</div>
            {selectedMap ? <>
              <section className="workspace-panel map-preview-panel"><div className="panel-heading"><div><div className="panel-kicker">SELECTED MAP</div><h3>{selectedMap.name}</h3></div><div className="panel-heading-actions"><button className="secondary-button" onClick={() => setIsEditingConfig((current) => !current)}><Settings2 size={16} />{isEditingConfig ? "收起配置" : "编辑地图配置"}</button><button className="text-button" onClick={() => setSection("overview")}>返回总览 <ArrowUpRight size={16} /></button></div></div><div className="compact-scene"><TestScene config={selectedMap.config} modelUrl={selectedMap.modelUrl} /></div></section>
              {isEditingConfig ? <MapConfigEditor config={selectedMap.config} onSave={handleMapConfigSave} onCancel={() => setIsEditingConfig(false)} /> : null}
            </> : null}
          </div>
        ) : null}

        {section === "rooms" ? (
          <div className="page-body"><div className="page-intro-row"><div><div className="panel-kicker">MULTIPLAYER LOBBY</div><h2>联机房间</h2><p>创建房间后，复制邀请链接或发送房间码即可让队友加入。</p></div><div className="room-actions"><form className="room-code-form" onSubmit={handleJoinRoomByCode}><input value={roomCodeInput} onChange={(event) => setRoomCodeInput(event.target.value)} placeholder="输入房间码" maxLength={8} aria-label="房间码" /><button className="secondary-button" type="submit"><Users size={16} />加入</button></form><button className="primary-button" onClick={handleCreateRoom}><Plus size={17} />创建测试房间</button></div></div><section className="room-list">{rooms.length === 0 ? <div className="empty-state"><Users size={26} /><strong>还没有联机房间</strong><span>创建一个房间，开始测试多人同步。</span><button className="secondary-button" onClick={handleCreateRoom}>创建第一个房间</button></div> : rooms.map((room) => <div className="room-row" key={room.id}><div className="room-avatar"><Users size={19} /></div><div className="room-main"><strong>{room.name}</strong><span>地图：{maps.find((map) => map.id === room.mapId)?.name ?? room.mapId}</span></div><div className="room-status"><span className={`status-dot ${room.status === "waiting" ? "online" : ""}`} />{roomStatusLabel(room.status)}</div><div className="room-players"><Users size={15} />{room.playerCount} / 8</div><button className="icon-button" title="复制邀请链接" onClick={() => copyRoomInvite(room.id)}>{copiedRoomId === room.id ? <CheckCircle2 size={17} /> : <Copy size={17} />}</button><button className="icon-button" title="进入游戏" onClick={() => openRoom(room.id)}><Gamepad2 size={17} /></button></div>)}</section></div>
        ) : null}

        {section === "missions" ? (
          <div className="page-body">
            <div className="page-intro-row"><div><div className="panel-kicker">DRONE SDK PIPELINE</div><h2>无人机采集任务</h2><p>记录航拍任务与设备信息，跟踪从采集到三维模型交付的过程。</p></div><span className={`sdk-status ${droneSdk?.connected ? "connected" : "simulated"}`}><span className={`status-dot ${droneSdk?.connected ? "online" : ""}`} />{droneSdk?.mode === "device-bridge" ? "设备桥接已连接" : "模拟桥接 · 未连接真机"}</span></div>
            <section className="sdk-bridge-panel">
              <Plane size={19} /><div><strong>{droneSdk?.provider ?? "SDK 桥接状态读取中"}</strong><span>{droneSdk?.message ?? "等待服务端响应"}</span></div>
            </section>
            <section className="workspace-panel form-panel mission-form-panel"><form onSubmit={handleCreateMission}>
              <div className="form-heading"><div><div className="panel-kicker">NEW CAPTURE MISSION</div><h3>登记采集任务</h3></div><span className="form-hint">当前记录任务数据，不会直接控制无人机</span></div>
              <div className="form-grid">
                <label>任务名称<input value={missionDraft.name} onChange={(event) => setMissionDraft({ ...missionDraft, name: event.target.value })} placeholder="例如：校园北区航拍" maxLength={80} required /></label>
                <label>采集日期<input type="date" value={missionDraft.captureDate} onChange={(event) => setMissionDraft({ ...missionDraft, captureDate: event.target.value })} required /></label>
                <label>无人机型号<input value={missionDraft.aircraftModel} onChange={(event) => setMissionDraft({ ...missionDraft, aircraftModel: event.target.value })} placeholder="例如：DJI Mini 4 Pro" maxLength={80} /></label>
                <label>相机型号<input value={missionDraft.cameraModel} onChange={(event) => setMissionDraft({ ...missionDraft, cameraModel: event.target.value })} placeholder="例如：机载广角相机" maxLength={80} /></label>
                <label>SDK / 数据来源<input value={missionDraft.provider} onChange={(event) => setMissionDraft({ ...missionDraft, provider: event.target.value })} placeholder="例如：DJI Mobile SDK / 模拟数据" maxLength={80} /></label>
                <label className="wide-field">任务备注<textarea value={missionDraft.notes} onChange={(event) => setMissionDraft({ ...missionDraft, notes: event.target.value })} placeholder="采集区域、航线、影像数量或建模说明" rows={3} maxLength={500} /></label>
              </div>
              <div className="form-actions"><span>登记后可更新任务状态；模型生成后可在地图管理中关联 GLB。</span><button className="primary-button" type="submit" disabled={isSavingMission}><Plus size={16} />{isSavingMission ? "保存中..." : "登记任务"}</button></div>
            </form></section>
            <section className="workspace-panel mission-panel">
              <div className="panel-heading"><div><div className="panel-kicker">MISSION REGISTER</div><h3>任务记录 <span className="count-label">{missions.length}</span></h3></div></div>
              {missions.length === 0 ? <div className="mission-empty"><ClipboardList size={24} /><strong>还没有采集任务</strong><span>先登记一次航拍或模拟采集任务。</span></div> : <div className="mission-list">{missions.map((mission) => {
                const linkedMap = maps.find((map) => map.provenance.missionId === mission.id);
                return <article className="mission-row" key={mission.id}>
                  <div className="mission-icon"><Plane size={17} /></div>
                  <div className="mission-main"><strong>{mission.name}</strong><span>{mission.id} · {mission.provider || "未填写 SDK / 数据来源"}</span><small>{mission.aircraftModel} · {mission.cameraModel} · {new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(mission.captureDate))}</small>{mission.notes ? <p>{mission.notes}</p> : null}{linkedMap ? <small className="linked-map">已关联地图：{linkedMap.name}</small> : null}</div>
                  <label className="mission-state">任务阶段<select value={mission.status} onChange={(event) => handleMissionStatusChange(mission.id, event.target.value as DroneMissionStatus)} aria-label={`${mission.name}任务阶段`}>{Object.entries(missionStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                </article>;
              })}</div>}
            </section>
          </div>
        ) : null}

        {section === "resources" ? (
          <div className="page-body">
            <div className="page-intro-row"><div><div className="panel-kicker">RESOURCE PACK REGISTRY</div><h2>游戏资源包</h2><p>平台读取标准 `manifest.json`；角色、道具、音效、贴图和 UI 可以替换，没有外部模型时自动回退。</p></div><div className="room-actions"><span className="sdk-status connected"><span className="status-dot online" />默认回退资源已可用</span><button className="primary-button" onClick={() => setShowResourceImporter((current) => !current)}><PackagePlus size={17} />{showResourceImporter ? "收起导入" : "导入资源包"}</button></div></div>
            {showResourceImporter ? <section className="workspace-panel form-panel"><form onSubmit={handleResourcePackImport}>
              <div className="form-heading"><div><div className="panel-kicker">DHPACK PACKAGE IMPORT</div><h3>导入游戏资源包</h3></div><span className="form-hint">manifest.json + 任意资源文件</span></div>
              <div className="form-grid">
                <label>资源包清单<input type="file" accept=".json,application/json" onChange={(event) => setResourceManifest(event.target.files?.[0] ?? null)} required /></label>
                <label className="wide-field">资源文件<input type="file" multiple onChange={(event) => setResourceAssets(Array.from(event.target.files ?? []))} /></label>
              </div>
              <div className="form-actions"><span>{resourceManifest ? `清单：${resourceManifest.name} · 已选资源 ${resourceAssets.length} 个` : "资源项 path 必须对应已选择的文件名"}</span><button className="primary-button" type="submit" disabled={isImportingResourcePack}>{isImportingResourcePack ? "导入中..." : "导入资源包"}</button></div>
            </form></section> : null}
            <section className="resource-note"><PackageCheck size={19} /><div><strong>资源与游戏规则解耦</strong><span>模型、道具、特效和标记可以替换；房间、联机同步、抓捕和结算仍使用同一套服务端规则。</span></div></section>
            {resourcePacks.length > 0 ? <section className="resource-grid">{resourcePacks.map((pack) => {
              const packKey = resourcePackKey(pack);
              const runtimeCount = runtimeModelAssetCount(pack);
              const isSelectedPack = selectedResourcePack ? resourcePackKey(selectedResourcePack) === packKey : false;
              return <article className={`resource-card ${isSelectedPack ? "selected" : ""}`} key={packKey}>
                <div className="resource-card-head"><div className="resource-icon"><PackageCheck size={20} /></div><div><h3>{pack.name}</h3><span>{pack.id} · v{pack.version}</span></div>{pack.builtIn ? <span className="status-tag configured">内置</span> : <span className="status-tag draft">外部</span>}</div>
                <p>{pack.description}</p>
                <div className="resource-meta"><span>作者：{pack.author}</span><span>许可证：{pack.license}</span><span>运行时角色模型：{runtimeCount > 0 ? `${runtimeCount} 个` : "默认回退"}</span></div>
                <div className="resource-card-actions"><button className={isSelectedPack ? "secondary-button" : "primary-button"} onClick={() => setSelectedResourcePackKey(packKey)}>{isSelectedPack ? "当前游戏资源" : "设为游戏资源"}</button></div>
                <div className="resource-asset-list">{pack.assets.map((asset) => <div key={asset.id}><span>{asset.label}</span><small>{resourceKindLabel(asset.kind)}{asset.fallback ? " · 默认回退" : asset.path ? ` · ${asset.format ?? "外部文件"}` : ""}</small></div>)}</div>
              </article>;
            })}</section> : <section className="workspace-panel resource-empty"><PackageCheck size={25} /><strong>未发现资源包清单</strong><span>请检查 `server/uploads/plugins/` 下的 `manifest.json`。游戏仍将使用内置默认资源运行。</span></section>}
            <section className="workspace-panel resource-manifest-guide"><div className="panel-heading"><div><div className="panel-kicker">PACKAGE CONTRACT</div><h3>两个开放接入口</h3></div></div><div className="manifest-columns"><div><strong>地图包 `.dhmap`</strong><code>kind=map · scene · collision · config</code></div><div><strong>游戏资源包 `.dhpack`</strong><code>kind=game-resources · assets</code></div><div><strong>格式策略</strong><code>sourceFormats 可扩展，runtimeFormat 统一</code></div></div></section>
          </div>
        ) : null}
      </main>
    </div>
  );
}

export default App;
