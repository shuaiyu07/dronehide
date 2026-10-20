import type { MapConfig, MapInfo } from "./types.js";

export const demoMapConfig: MapConfig = {
  mapId: "demo-campus",
  gameMode: "hide-and-seek",
  spawnPoints: [
    {
      id: "seeker-start",
      role: "seeker",
      position: [0, 1.7, 22],
      rotation: [0, Math.PI, 0],
    },
    {
      id: "hider-start-a",
      role: "hider",
      position: [-17, 1.7, -12],
      rotation: [0, 0.6, 0],
    },
    {
      id: "hider-start-b",
      role: "hider",
      position: [18, 1.7, -10],
      rotation: [0, -0.6, 0],
    },
  ],
  zones: [
    {
      id: "library-hide-zone",
      name: "图书馆后侧躲藏区",
      center: [-16, 0, -12],
      radius: 7,
      kind: "hide",
    },
    {
      id: "north-forbidden-zone",
      name: "施工禁区",
      center: [0, 0, -24],
      radius: 5,
      kind: "forbidden",
    },
  ],
  bounds: {
    min: [-36, 0, -30],
    max: [36, 18, 30],
  },
  rules: {
    prepareTime: 30,
    gameTime: 300,
    catchDistance: 2.5,
    maxPlayers: 8,
  },
};

export const demoMap: MapInfo = {
  id: "demo-campus",
  name: "校园测试场景",
  description: "没有真实无人机模型时使用的程序化测试场景。后续可以直接替换为 .glb 地图。",
  source: "procedural",
  modelUrl: null,
  thumbnailUrl: null,
  status: "configured",
  updatedAt: "2026-09-18T00:00:00.000Z",
  provenance: {
    type: "built-in",
    attribution: "Drone Hide Platform 程序化测试场景",
  },
  config: demoMapConfig,
};
