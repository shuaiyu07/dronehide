import type { ApiHealth, DroneMission, DroneSdkStatus, MapConfig, MapInfo, MapProvenanceType, ResourcePackInfo, RoomSummary } from "../../shared/types.ts";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) throw new Error(`请求失败: ${response.status}`);
  return response.json() as Promise<T>;
}

export function getHealth() {
  return request<ApiHealth>("/api/health");
}

export async function getResourcePacks() {
  const result = await request<{ items: ResourcePackInfo[] }>("/api/resource-packs");
  return result.items;
}

export async function getMaps() {
  const result = await request<{ items: MapInfo[] }>("/api/maps");
  return result.items;
}

export async function getRooms() {
  const result = await request<{ items: RoomSummary[] }>("/api/rooms");
  return result.items;
}

export function getRoom(roomId: string) {
  return request<RoomSummary>(`/api/rooms/${encodeURIComponent(roomId.trim().toUpperCase())}`);
}

export function createRoom(name: string, mapId: string, resourcePackBaseUrl?: string) {
  return request<RoomSummary>("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name, mapId, ...(resourcePackBaseUrl ? { resourcePackBaseUrl } : {}) }),
  });
}

export function getDroneSdkStatus() {
  return request<DroneSdkStatus>("/api/drone/sdk-status");
}

export async function getDroneMissions() {
  const result = await request<{ items: DroneMission[] }>("/api/drone/missions");
  return result.items;
}

export type DroneMissionDraft = Omit<DroneMission, "id" | "createdAt">;

export function createDroneMission(input: DroneMissionDraft) {
  return request<DroneMission>("/api/drone/missions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateDroneMissionStatus(missionId: string, status: DroneMissionDraft["status"]) {
  return request<DroneMission>(`/api/drone/missions/${encodeURIComponent(missionId)}/status`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
}

export type MapImportInput = {
  file: File;
  name: string;
  description: string;
  provenanceType: Exclude<MapProvenanceType, "built-in">;
  sourceUrl: string;
  license: string;
  attribution: string;
  missionId: string;
};

export async function importMap(input: MapImportInput) {
  const body = new FormData();
  body.append("model", input.file);
  body.append("name", input.name);
  body.append("description", input.description);
  body.append("provenanceType", input.provenanceType);
  body.append("sourceUrl", input.sourceUrl);
  body.append("license", input.license);
  body.append("attribution", input.attribution);
  body.append("missionId", input.missionId);

  const response = await fetch("/api/maps/import", { method: "POST", body });
  const result = await response.json() as MapInfo | { message?: string };
  if (!response.ok) throw new Error("message" in result ? result.message ?? "地图导入失败" : "地图导入失败");
  return result as MapInfo;
}

export async function importMapPackage(input: { manifest: File; scene: File; collision?: File | null; thumbnail?: File | null }) {
  const body = new FormData();
  body.append("manifest", input.manifest);
  body.append("scene", input.scene);
  if (input.collision) body.append("collision", input.collision);
  if (input.thumbnail) body.append("thumbnail", input.thumbnail);
  const response = await fetch("/api/maps/import-package", { method: "POST", body });
  const result = await response.json() as MapInfo | { message?: string };
  if (!response.ok) throw new Error("message" in result ? result.message ?? "地图包导入失败" : "地图包导入失败");
  return result as MapInfo;
}

export async function importResourcePack(input: { manifest: File; assets: File[] }) {
  const body = new FormData();
  body.append("manifest", input.manifest);
  for (const asset of input.assets) body.append("assets", asset);
  const response = await fetch("/api/resource-packs/import", { method: "POST", body });
  const result = await response.json() as ResourcePackInfo | { message?: string };
  if (!response.ok) throw new Error("message" in result ? result.message ?? "资源包导入失败" : "资源包导入失败");
  return result as ResourcePackInfo;
}

export type RemoteMapInput = {
  name: string;
  description: string;
  modelUrl: string;
  sourceUrl: string;
  license: string;
  attribution: string;
};

export function addRemoteMap(input: RemoteMapInput) {
  return request<MapInfo>("/api/maps/remote", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type LocalMapInput = {
  fileName: string;
  name: string;
  description: string;
  sourceUrl: string;
  license: string;
  attribution: string;
};

export function addLocalMap(input: LocalMapInput) {
  return request<MapInfo>("/api/maps/local", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateMapConfig(mapId: string, config: MapConfig) {
  return request<MapInfo>(`/api/maps/${encodeURIComponent(mapId)}/config`, {
    method: "PUT",
    body: JSON.stringify({ config }),
  });
}
