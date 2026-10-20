import type { MapConfig, MapInfo } from "./types.js";

/**
 * 共享程序化战术地图："仓储要塞 / Warehouse Fortress"。
 *
 * 设计目标（与港口 GLB 并列的第二张主地图，纯代码生成，零磁盘占用）：
 * 1. 比 CSGO 常规点位更"大"更"绕"：大型仓库内纵横交错的货架阵、中央集装箱迷宫、
 *    两条地下管道通道、外部货柜堆场与瞭望塔，路线数量明显多于常规点位。
 * 2. 碰撞几何与视觉几何完全同源：同一个 Box 列表既在服务端做 hitscan / 移动碰撞，
 *    也在客户端生成 Three.js 网格，天然防穿墙、防穿人，且不依赖外部 GLB。
 * 3. A/B 爆破点分别位于"仓库深处"和"集装箱堆场"，进攻方有多条迂回路线，
 *    无人机的侦察/自爆玩法在多层掩体之间有真实价值。
 *
 * 所有障碍均为轴对齐盒（AABB），由 `warehouseObstacles()` 提供，服务端与客户端共用。
 */

export interface ObstacleBox {
  /** 盒中心坐标 */
  center: [number, number, number];
  /** 全尺寸（x, y, z） */
  size: [number, number, number];
  /** 视觉类别，仅客户端渲染使用：wall / shelf / container / pipe / tower / crate */
  kind: "wall" | "shelf" | "container" | "pipe" | "tower" | "crate";
}

const OBSTACLES: ObstacleBox[] = [
  // ---------- 仓储要塞主体（仓库 A，位于西北象限，爆破点 A 在内部） ----------
  // 外墙（留出多个门洞：南墙两处、东墙一处、北墙一处）
  { center: [-26, 5, -22], size: [28, 10, 1], kind: "wall" },      // 南墙左段
  { center: [-12, 5, -22], size: [2, 10, 1], kind: "wall" },       // 南墙门柱
  { center: [-6, 5, -22], size: [2, 10, 1], kind: "wall" },        // 南墙门柱
  { center: [2, 5, -22], size: [14, 10, 1], kind: "wall" },        // 南墙右段（门洞 -11..-7 宽 4）
  { center: [-40, 5, -12], size: [1, 10, 21], kind: "wall" },      // 西墙
  { center: [-10, 5, -34.5], size: [60, 10, 1], kind: "wall" },    // 北墙
  { center: [-22, 5, -33], size: [1, 10, 4], kind: "wall" },       // 东墙上段
  { center: [-22, 5, -26], size: [1, 10, 2], kind: "wall" },       // 东墙下段（门洞 -30..-28 与 -25..-23）

  // 仓库内货架阵（两排双向可穿行，形成"绕"的核心区）
  { center: [-33, 2.4, -29], size: [3, 4.8, 5], kind: "shelf" },
  { center: [-33, 2.4, -21], size: [3, 4.8, 5], kind: "shelf" },
  { center: [-26, 2.4, -29], size: [3, 4.8, 5], kind: "shelf" },
  { center: [-26, 2.4, -21], size: [3, 4.8, 5], kind: "shelf" },
  { center: [-18, 2.4, -31.5], size: [3, 4.8, 6], kind: "shelf" },
  { center: [-18, 2.4, -23], size: [3, 4.8, 6], kind: "shelf" },
  { center: [-14, 2.4, -27], size: [5, 4.8, 3], kind: "shelf" },   // 横向货架，制造绕行
  { center: [-30, 2.4, -25], size: [6, 4.8, 3], kind: "shelf" },   // 横向货架

  // 仓库内中心物资台（爆破点 A 就在附近）
  { center: [-34, 1.5, -18], size: [10, 3, 2], kind: "crate" },
  { center: [-34, 1.5, -13], size: [10, 3, 2], kind: "crate" },

  // ---------- 中央集装箱迷宫（中路，最"绕"的区域） ----------
  { center: [0, 1.5, -16], size: [12, 3, 3], kind: "container" },
  { center: [12, 1.5, -14], size: [3, 3, 12], kind: "container" },
  { center: [0, 1.5, -4], size: [3, 3, 14], kind: "container" },
  { center: [-10, 1.5, -6], size: [10, 3, 3], kind: "container" },
  { center: [8, 1.5, 2], size: [12, 3, 3], kind: "container" },
  { center: [18, 1.5, -4], size: [3, 3, 10], kind: "container" },
  { center: [-2, 1.5, 6], size: [10, 3, 3], kind: "container" },
  { center: [-14, 1.5, 0], size: [3, 3, 10], kind: "container" },
  { center: [-6, 1.5, 12], size: [3, 3, 8], kind: "container" },
  { center: [10, 1.5, 10], size: [10, 3, 3], kind: "container" },
  // 二层集装箱（可从旁边高箱跳上，形成高低差）
  { center: [12, 4.4, -14], size: [3, 2.8, 6], kind: "container" },

  // ---------- 地下管道通道（两条，连接南北） ----------
  // 管道本体在客户端渲染为"下沉走廊 + 顶部半覆盖"，碰撞用两侧墙模拟
  { center: [24, 1.6, -8], size: [2, 3.2, 26], kind: "pipe" },     // 管道一（东侧）左壁
  { center: [30, 1.6, -8], size: [2, 3.2, 26], kind: "pipe" },     // 管道一右壁
  { center: [-20, 1.6, 14], size: [2, 3.2, 24], kind: "pipe" },    // 管道二（西侧）
  { center: [-26, 1.6, 14], size: [2, 3.2, 24], kind: "pipe" },

  // ---------- 集装箱堆场（东南，爆破点 B 所在） ----------
  { center: [26, 1.5, 20], size: [12, 3, 3], kind: "container" },
  { center: [32, 1.5, 12], size: [3, 3, 10], kind: "container" },
  { center: [20, 1.5, 26], size: [3, 3, 10], kind: "container" },
  { center: [30, 1.5, 28], size: [10, 3, 3], kind: "container" },
  { center: [22, 4.4, 18], size: [6, 2.8, 3], kind: "container" }, // 二层箱
  { center: [26, 1.5, 34], size: [14, 3, 3], kind: "container" },

  // ---------- 南部码头货柜与瞭望塔 ----------
  { center: [-8, 1.5, 28], size: [10, 3, 3], kind: "container" },
  { center: [2, 1.5, 32], size: [3, 3, 8], kind: "container" },
  { center: [-18, 1.5, 30], size: [3, 3, 8], kind: "container" },
  { center: [38, 3, 30], size: [4, 6, 4], kind: "tower" },         // 瞭望塔（防守方狙击位）
  { center: [-38, 3, 26], size: [4, 6, 4], kind: "tower" },        // 瞭望塔

  // ---------- 零散掩体 ----------
  { center: [22, 1.2, -26], size: [4, 2.4, 4], kind: "crate" },
  { center: [14, 1.2, -28], size: [4, 2.4, 4], kind: "crate" },
  { center: [34, 1.2, 4], size: [4, 2.4, 4], kind: "crate" },
  { center: [-4, 1.2, -26], size: [4, 2.4, 4], kind: "crate" },
  { center: [-32, 1.2, 8], size: [5, 2.4, 3], kind: "crate" },
  { center: [8, 1.2, 22], size: [4, 2.4, 4], kind: "crate" },
  { center: [-12, 1.2, 22], size: [4, 2.4, 4], kind: "crate" },
];

/** 障碍盒列表（服务端碰撞 / hitscan 与客户端渲染共用）。 */
export function warehouseObstacles(): ObstacleBox[] {
  return OBSTACLES.map((box) => ({
    center: [...box.center] as [number, number, number],
    size: [...box.size] as [number, number, number],
    kind: box.kind,
  }));
}

export const warehouseFortressConfig: MapConfig = {
  mapId: "warehouse-fortress",
  gameMode: "tactical-bomb",
  bounds: { min: [-44, 0, -38], max: [44, 22, 38] },
  rules: {
    prepareTime: 15,
    gameTime: 300,
    catchDistance: 2.5,
    maxPlayers: 12,
    roundsToWin: 3,
    bombTime: 40,
  },
  spawnPoints: [
    // 进攻方出生：西南集结区（两条主路线：中路集装箱迷宫 / 东侧管道）
    { id: "attacker-sw-1", role: "attacker", position: [-36, 1.7, 18], rotation: [0, -0.9, 0] },
    { id: "attacker-sw-2", role: "attacker", position: [-34, 1.7, 24], rotation: [0, -0.9, 0] },
    { id: "attacker-sw-3", role: "attacker", position: [-30, 1.7, 30], rotation: [0, -1.2, 0] },
    // 防守方出生：东北哨所（可以分兵守 A 仓库 / B 堆场）
    { id: "defender-ne-1", role: "defender", position: [36, 1.7, -20], rotation: [0, 2.3, 0] },
    { id: "defender-ne-2", role: "defender", position: [34, 1.7, -26], rotation: [0, 2.3, 0] },
    { id: "defender-ne-3", role: "defender", position: [30, 1.7, -32], rotation: [0, 2.6, 0] },
  ],
  zones: [
    { id: "zone-warehouse-a", name: "A 仓库货架区", center: [-26, 0, -26], radius: 14, kind: "hide" },
    { id: "zone-container-mid", name: "中路集装箱迷宫", center: [0, 0, -4], radius: 16, kind: "hide" },
    { id: "zone-yard-b", name: "B 集装箱堆场", center: [26, 0, 20], radius: 12, kind: "hide" },
    { id: "zone-pipe-east", name: "东管道走廊", center: [27, 0, -8], radius: 6, kind: "safe" },
    { id: "zone-pipe-west", name: "西管道走廊", center: [-23, 0, 14], radius: 6, kind: "safe" },
  ],
  bombSites: [
    // Keep site centers in walkable space: the old points overlapped nearby props
    // once player-radius collision was enabled on both the client and server.
    { id: "site-a", name: "爆破点 A · 西侧前沿", center: [-36, 0, 10], radius: 5.5 },
    { id: "site-b", name: "爆破点 B · 集装箱堆场", center: [26, 0, 24], radius: 5.5 },
  ],
};

export const warehouseFortressMap: MapInfo = {
  id: "warehouse-fortress",
  name: "仓储要塞（大型战术图）",
  description:
    "程序化生成的大型战术爆破地图：仓库货架阵、集装箱迷宫、双层高箱、两条管道走廊和瞭望塔。碰撞与视觉同源，不需要外部 GLB，路线多、绕点多，为无人机侦察与自爆玩法设计。",
  source: "procedural",
  modelUrl: null,
  thumbnailUrl: null,
  status: "configured",
  updatedAt: "2026-10-13T00:00:00.000Z",
  provenance: {
    type: "built-in",
    attribution: "Drone Hide Platform 程序化生成 · 原创几何，无第三方资产",
  },
  config: warehouseFortressConfig,
};
