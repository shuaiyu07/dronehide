import { warehouseObstacles } from "./warehouseMap.js";
import type { MapConfig, Vec3 } from "./types.ts";

export interface CollisionBox {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
  kind: string;
}

export const PLAYER_RADIUS = 0.42;
export const PLAYER_HEIGHT = 1.7;
const cache = new WeakMap<MapConfig, CollisionBox[]>();

export function getCollisionBoxes(config: MapConfig): CollisionBox[] {
  const cached = cache.get(config);
  if (cached) return cached;
  const sources = [
    ...(config.mapId === "warehouse-fortress" ? warehouseObstacles() : []),
    ...(config.collisionBoxes ?? []).map((box) => ({ ...box, kind: "collision" })),
  ];
  const boxes = sources.map((box) => ({
    minX: box.center[0] - box.size[0] / 2, maxX: box.center[0] + box.size[0] / 2,
    minY: box.center[1] - box.size[1] / 2, maxY: box.center[1] + box.size[1] / 2,
    minZ: box.center[2] - box.size[2] / 2, maxZ: box.center[2] + box.size[2] / 2,
    kind: box.kind,
  }));
  cache.set(config, boxes);
  return boxes;
}

export function playerBlocked(boxes: CollisionBox[], position: Vec3): boolean {
  const [x, y, z] = position;
  return boxes.some((box) =>
    x + PLAYER_RADIUS > box.minX + 1e-6 && x - PLAYER_RADIUS < box.maxX - 1e-6 &&
    z + PLAYER_RADIUS > box.minZ + 1e-6 && z - PLAYER_RADIUS < box.maxZ - 1e-6 &&
    y > box.minY + 1e-6 && y - PLAYER_HEIGHT < box.maxY - 1e-6);
}

/** Sweep small increments so a long update cannot skip a thin wall; slide along free axes. */
export function resolvePlayerMove(config: MapConfig, from: Vec3, requested: Vec3): Vec3 {
  if (!Array.isArray(requested) || requested.length !== 3 || !requested.every((value) => typeof value === "number" && Number.isFinite(value))) return [...from];
  const target: Vec3 = [
    Math.max(config.bounds.min[0] + PLAYER_RADIUS, Math.min(config.bounds.max[0] - PLAYER_RADIUS, requested[0])),
    Math.max(config.bounds.min[1] + PLAYER_HEIGHT, Math.min(config.bounds.max[1], requested[1])),
    Math.max(config.bounds.min[2] + PLAYER_RADIUS, Math.min(config.bounds.max[2] - PLAYER_RADIUS, requested[2])),
  ];
  const boxes = getCollisionBoxes(config);
  if (boxes.length === 0) return target;
  const delta = target.map((value, axis) => value - from[axis]) as Vec3;
  const steps = Math.ceil(Math.max(...delta.map(Math.abs)) / 0.18);
  if (steps === 0) return [...from];
  // Reject pathological requests instead of spending unbounded work per socket message.
  if (steps > 4096) return [...from];
  const next: Vec3 = [...from];
  for (let step = 0; step < steps; step += 1) {
    for (const axis of [1, 0, 2]) {
      const candidate: Vec3 = [...next];
      candidate[axis] += delta[axis] / steps;
      if (!playerBlocked(boxes, candidate)) next[axis] = candidate[axis];
    }
  }
  return next;
}
