import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { getCollisionBoxes, PLAYER_RADIUS, resolvePlayerMove, type CollisionBox } from "../../shared/collision.js";
import type { BombState, DroneScanTarget, FpvDroneEntity, MapConfig, PlayerRole, PlayerState, ResourcePackAsset, ResourcePackInfo, Vec3 } from "../../shared/types.ts";

type GameSceneProps = {
  config: MapConfig;
  players: PlayerState[];
  localPlayerId: string | null;
  onMove: (position: Vec3, rotation: Vec3) => void;
  onFire?: () => void;
  onUse?: () => void;
  onUseRelease?: () => void;
  onReload?: () => void;
  onFpvLaunch?: () => void;
  onFpvMove?: (droneId: string, position: Vec3, yaw: number) => void;
  onFpvDetonate?: () => void;
  canMove: boolean;
  modelUrl?: string | null;
  resourcePack?: ResourcePackInfo | null;
  scanTargets?: DroneScanTarget[];
  bomb?: BombState | null;
  droppedBomb?: { position: Vec3 } | null;
  fpvDrones?: FpvDroneEntity[];
  localFpvDroneId?: string | null;
  positionCorrection?: Vec3 | null;
  onPositionCorrectionApplied?: () => void;
};

const playerColors: Record<PlayerState["role"], string> = {
  attacker: "#d8684d",
  defender: "#287d8a",
  seeker: "#d8684d",
  hider: "#287d8a",
  spectator: "#879590",
};

const playerEyeHeight = 1.7;
const playerRadius = PLAYER_RADIUS;
const gravity = -20;
const jumpSpeed = 7.2;

/** warehouse 障碍的视觉配色（按 kind） */
const obstacleColors: Record<string, string> = {
  wall: "#cfd8dc",
  shelf: "#a1887f",
  container: "#5d8aa8",
  pipe: "#90a4ae",
  tower: "#8d6e63",
  crate: "#d7ccc8",
};

/** 计算脚下最高的障碍顶面（用于跳上高箱）。 */
function groundHeight(boxes: CollisionBox[], x: number, z: number, currentFeetY: number) {
  let ground = 0;
  for (const box of boxes) {
    if (x + playerRadius > box.minX && x - playerRadius < box.maxX &&
      z + playerRadius > box.minZ && z - playerRadius < box.maxZ &&
      box.maxY <= currentFeetY + 0.3 && box.maxY > ground) {
      ground = box.maxY;
    }
  }
  return ground;
}

function encodeRelativeUrl(path: string) {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function isRuntimeModelAsset(asset: ResourcePackAsset) {
  const format = asset.format?.toLowerCase();
  const path = asset.path?.toLowerCase() ?? "";
  return Boolean(asset.path) && (asset.kind === "character" || asset.kind === "model") && (format === "glb" || format === "gltf" || /\.(glb|gltf)$/.test(path));
}

function matchesRole(asset: ResourcePackAsset, role: PlayerRole) {
  const text = [asset.id, asset.label, ...(asset.tags ?? [])].join(" ").toLowerCase();
  if (role === "seeker" || role === "attacker") return /seeker|seek|catch|hunter|finder|attacker|terrorist|进攻|寻找|抓捕/.test(text);
  if (role === "hider" || role === "defender") return /hider|hide|runner|defender|counter|ct|防守|躲藏|隐藏/.test(text);
  return false;
}

function resolveRoleModelUrls(resourcePack?: ResourcePackInfo | null): Partial<Record<PlayerRole, string>> {
  if (!resourcePack?.baseUrl) return {};
  const assets = resourcePack.assets.filter(isRuntimeModelAsset);
  const toUrl = (asset: ResourcePackAsset) => asset.path ? `${resourcePack.baseUrl}/${encodeRelativeUrl(asset.path)}` : undefined;
  const generic = assets.find((asset) => !matchesRole(asset, "seeker") && !matchesRole(asset, "hider")) ?? assets[0];
  return {
    attacker: toUrl(assets.find((asset) => matchesRole(asset, "attacker")) ?? assets.find((asset) => matchesRole(asset, "seeker")) ?? generic),
    defender: toUrl(assets.find((asset) => matchesRole(asset, "defender")) ?? assets.find((asset) => matchesRole(asset, "hider")) ?? generic),
    seeker: toUrl(assets.find((asset) => matchesRole(asset, "seeker")) ?? generic),
    hider: toUrl(assets.find((asset) => matchesRole(asset, "hider")) ?? generic),
  };
}

function normalizeCharacterModel(source: THREE.Object3D) {
  const wrapper = new THREE.Group();
  const model = source.clone(true);
  wrapper.add(model);
  wrapper.updateMatrixWorld(true);

  let bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const height = Math.max(size.y, 0.01);
  const scale = 1.72 / height;
  model.scale.multiplyScalar(scale);
  wrapper.updateMatrixWorld(true);

  bounds = new THREE.Box3().setFromObject(model);
  centerAndGroundModel(model, bounds);
  model.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return wrapper;
}

function centerAndGroundModel(model: THREE.Object3D, bounds: THREE.Box3) {
  const center = bounds.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.y -= bounds.min.y;
  model.position.z -= center.z;
}

export default function GameScene({
  config, players, localPlayerId, onMove, onFire, onUse, onUseRelease, onReload,
  onFpvLaunch, onFpvMove, onFpvDetonate, canMove, modelUrl = null, resourcePack = null, scanTargets = [],
  bomb = null, droppedBomb = null, fpvDrones = [], localFpvDroneId = null, positionCorrection = null, onPositionCorrectionApplied,
}: GameSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const playersRef = useRef(players);
  const localIdRef = useRef(localPlayerId);
  const onMoveRef = useRef(onMove);
  const onFireRef = useRef(onFire);
  const onUseRef = useRef(onUse);
  const onUseReleaseRef = useRef(onUseRelease);
  const onReloadRef = useRef(onReload);
  const onFpvLaunchRef = useRef(onFpvLaunch);
  const onFpvMoveRef = useRef(onFpvMove);
  const onFpvDetonateRef = useRef(onFpvDetonate);
  const scanTargetsRef = useRef(scanTargets);
  const bombRef = useRef(bomb);
  const droppedBombRef = useRef(droppedBomb);
  const fpvDronesRef = useRef(fpvDrones);
  const localFpvDroneIdRef = useRef(localFpvDroneId);
  const positionCorrectionRef = useRef<Vec3 | null>(null);
  const onPositionCorrectionAppliedRef = useRef(onPositionCorrectionApplied);
  const pressedKeysRef = useRef(new Set<string>());
  const touchDirectionRef = useRef({ horizontal: 0, vertical: 0 });
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const pointerLockedRef = useRef(false);
  const crouchingRef = useRef(false);
  const verticalVelocityRef = useRef(0);
  const onGroundRef = useRef(true);
  const fpvStateRef = useRef<{ droneId: string; position: Vec3; lastSent: number } | null>(null);
  const [modelLoadNotice, setModelLoadNotice] = useState("");
  const [pointerHint, setPointerHint] = useState("点击画面进入第一人称视角");
  const [fpvNotice, setFpvNotice] = useState("");

  playersRef.current = players;
  localIdRef.current = localPlayerId;
  onMoveRef.current = onMove;
  onFireRef.current = onFire;
  onUseRef.current = onUse;
  onUseReleaseRef.current = onUseRelease;
  onReloadRef.current = onReload;
  onFpvLaunchRef.current = onFpvLaunch;
  onFpvMoveRef.current = onFpvMove;
  onFpvDetonateRef.current = onFpvDetonate;
  scanTargetsRef.current = scanTargets;
  bombRef.current = bomb;
  droppedBombRef.current = droppedBomb;
  fpvDronesRef.current = fpvDrones;
  localFpvDroneIdRef.current = localFpvDroneId;
  if (positionCorrection) positionCorrectionRef.current = positionCorrection;
  onPositionCorrectionAppliedRef.current = onPositionCorrectionApplied;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    const roleModelUrls = resolveRoleModelUrls(resourcePack);
    const hasRuntimeRoleModels = Object.values(roleModelUrls).some(Boolean);
    setModelLoadNotice(modelUrl ? "正在加载三维地图..." : hasRuntimeRoleModels ? `正在加载资源包：${resourcePack?.name}` : "");

    const obstacles = getCollisionBoxes(config);
    const hasObstacles = obstacles.length > 0;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(hasObstacles ? "#b9c9d6" : "#dce8e2");
    scene.fog = new THREE.Fog(hasObstacles ? "#b9c9d6" : "#dce8e2", 65, 150);

    const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 220);
    camera.position.set(14, 22, 18);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight("#f7fff9", "#71827b", 2.4));
    const sun = new THREE.DirectionalLight("#fff4d6", 3);
    sun.position.set(-25, 45, 22);
    sun.castShadow = true;
    scene.add(sun);

    const width = config.bounds.max[0] - config.bounds.min[0];
    const depth = config.bounds.max[2] - config.bounds.min[2];
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshStandardMaterial({ color: hasObstacles ? "#9fae9c" : "#b4cdbb", roughness: 0.9 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((config.bounds.min[0] + config.bounds.max[0]) / 2, 0, (config.bounds.min[2] + config.bounds.max[2]) / 2);
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(Math.max(width, depth), 24, "#759888", "#a1b9aa");
    grid.position.y = 0.03;
    grid.position.x = ground.position.x;
    grid.position.z = ground.position.z;
    grid.material.transparent = true;
    grid.material.opacity = 0.32;
    scene.add(grid);

    // warehouse 障碍盒渲染（与碰撞同源）
    for (const box of obstacles) {
      if (box.kind === "collision") continue;
      const geometry = new THREE.BoxGeometry(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
      const material = new THREE.MeshStandardMaterial({
        color: obstacleColors[box.kind] ?? "#b0bec5",
        roughness: box.kind === "shelf" ? 0.85 : 0.7,
        metalness: box.kind === "container" ? 0.35 : 0.08,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }

    const wallMaterial = new THREE.MeshStandardMaterial({ color: "#e9eee7", roughness: 0.8 });
    const roofMaterial = new THREE.MeshStandardMaterial({ color: "#bd6d4e", roughness: 0.8 });
    const addBuilding = (size: [number, number, number], position: [number, number, number]) => {
      const building = new THREE.Mesh(new THREE.BoxGeometry(...size), wallMaterial);
      building.position.set(...position);
      building.castShadow = true;
      building.receiveShadow = true;
      scene.add(building);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(size[0] + 1, 0.7, size[2] + 1), roofMaterial);
      roof.position.set(position[0], position[1] + size[1] / 2 + 0.35, position[2]);
      roof.castShadow = true;
      scene.add(roof);
    };
    const addFallbackBuildings = () => {
      addBuilding([18, 8, 13], [-16, 4, -13]);
      addBuilding([17, 11, 13], [19, 5.5, -12]);
      addBuilding([18, 5.5, 9], [15, 2.75, 19]);
    };
    if (modelUrl) {
      new GLTFLoader().load(modelUrl, (gltf) => {
        if (disposed) return;
        const model = gltf.scene;
        const initialBounds = new THREE.Box3().setFromObject(model);
        const initialSize = initialBounds.getSize(new THREE.Vector3());
        const maxSide = Math.max(initialSize.x, initialSize.y, initialSize.z, 1);
        const targetSide = Math.max(1, Math.min(width, depth) * 0.88);
        const wrapper = new THREE.Group();
        wrapper.add(model);
        wrapper.scale.setScalar(targetSide / maxSide);
        wrapper.updateMatrixWorld(true);
        const normalizedBounds = new THREE.Box3().setFromObject(wrapper);
        centerAndGroundModel(wrapper, normalizedBounds);
        wrapper.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
        scene.add(wrapper);
        setModelLoadNotice("");
      }, undefined, () => {
        if (disposed) return;
        addFallbackBuildings();
        setModelLoadNotice("模型加载失败，当前已切换到校园测试建筑");
      });
    } else if (!hasObstacles) {
      addFallbackBuildings();
    }

    config.spawnPoints.forEach((point) => {
      const color = point.role === "seeker" || point.role === "attacker" ? "#d8684d" : "#287d8a";
      const marker = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 0.9, 0.12, 24),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.16 }),
      );
      marker.position.set(point.position[0], 0.12, point.position[2]);
      scene.add(marker);
    });

    for (const zone of config.zones) {
      const zoneMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(zone.radius, zone.radius, 0.08, 48),
        new THREE.MeshBasicMaterial({ color: zone.kind === "hide" ? "#39a98b" : "#d8684d", transparent: true, opacity: 0.22 }),
      );
      zoneMesh.position.set(zone.center[0], 0.08, zone.center[2]);
      scene.add(zoneMesh);
    }

    for (const site of config.bombSites ?? []) {
      const siteMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(site.radius, site.radius, 0.1, 64),
        new THREE.MeshBasicMaterial({ color: "#f2c14e", transparent: true, opacity: 0.26 }),
      );
      siteMesh.position.set(site.center[0], 0.14, site.center[2]);
      scene.add(siteMesh);
      const siteRing = new THREE.Mesh(
        new THREE.RingGeometry(site.radius * 0.88, site.radius, 64),
        new THREE.MeshBasicMaterial({ color: "#f9e27d", transparent: true, opacity: 0.82, side: THREE.DoubleSide }),
      );
      siteRing.rotation.x = -Math.PI / 2;
      siteRing.position.set(site.center[0], 0.21, site.center[2]);
      scene.add(siteRing);
    }

    // ---- 炸弹 / 掉落炸弹 / FPV 穿越机 / 爆炸特效 持久化对象 ----
    const bombGroup = new THREE.Group();
    const bombBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.3, 0.4),
      new THREE.MeshStandardMaterial({ color: "#333944", roughness: 0.6, metalness: 0.4 }),
    );
    bombBody.castShadow = true;
    const bombLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 12, 12),
      new THREE.MeshBasicMaterial({ color: "#ff3b30" }),
    );
    bombLight.position.set(0, 0.24, 0);
    bombGroup.add(bombBody, bombLight);
    bombGroup.visible = false;
    scene.add(bombGroup);

    const droppedBombGroup = new THREE.Group();
    const droppedBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.28, 0.36),
      new THREE.MeshStandardMaterial({ color: "#4a5261", roughness: 0.6, metalness: 0.35 }),
    );
    const droppedRing = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.86, 32),
      new THREE.MeshBasicMaterial({ color: "#ffb84d", transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    droppedRing.rotation.x = -Math.PI / 2;
    droppedRing.position.y = 0.05;
    droppedBombGroup.add(droppedBody, droppedRing);
    droppedBombGroup.visible = false;
    scene.add(droppedBombGroup);

    const droneObjects = new Map<string, THREE.Group>();
    const makeDroneObject = () => {
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.18, 0.5),
        new THREE.MeshStandardMaterial({ color: "#2f3640", roughness: 0.5, metalness: 0.5 }),
      );
      body.castShadow = true;
      const rotorMaterial = new THREE.MeshBasicMaterial({ color: "#9fd8ff", transparent: true, opacity: 0.55 });
      for (const [rx, rz] of [[0.32, 0.32], [-0.32, 0.32], [0.32, -0.32], [-0.32, -0.32]] as [number, number][]) {
        const rotor = new THREE.Mesh(new THREE.CircleGeometry(0.26, 16), rotorMaterial);
        rotor.rotation.x = -Math.PI / 2;
        rotor.position.set(rx, 0.14, rz);
        group.add(rotor);
      }
      group.add(body);
      return group;
    };

    // 爆炸扩散球特效
    const explosions: { mesh: THREE.Mesh; startedAt: number }[] = [];
    const explosionMaterial = new THREE.MeshBasicMaterial({ color: "#ffb545", transparent: true, opacity: 0.6 });
    const spawnExplosion = (position: Vec3, radius: number) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 24), explosionMaterial.clone());
      mesh.position.set(position[0], position[1], position[2]);
      scene.add(mesh);
      explosions.push({ mesh, startedAt: performance.now() });
    };
    // 记录上一帧飞行中的穿越机，用于检测引爆/坠落并生成爆炸特效
    const lastFrameDrones = new Map<string, Vec3>();

    const scanMarkerObjects = new Map<string, THREE.Object3D>();
    const scanMarkerMaterial = new THREE.MeshBasicMaterial({ color: "#f2c14e", transparent: true, opacity: 0.92 });
    const scanMarkerRingMaterial = new THREE.MeshBasicMaterial({ color: "#fff0a8", transparent: true, opacity: 0.65, side: THREE.DoubleSide });
    const createScanMarker = () => {
      const group = new THREE.Group();
      const beacon = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.9, 4), scanMarkerMaterial);
      beacon.position.y = 2.4;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.65, 0.82, 32), scanMarkerRingMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.08;
      group.add(beacon, ring);
      return group;
    };

    const roleModelTemplates = new Map<PlayerRole, THREE.Object3D>();
    const roleModelKeys = new Map<PlayerRole, string>();
    const playerObjects = new Map<string, { object: THREE.Object3D; role: PlayerRole; assetKey: string }>();
    const createFallbackPlayerObject = (player: PlayerState) => {
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.45, 1.05, 5, 12),
        new THREE.MeshStandardMaterial({ color: playerColors[player.role], emissive: playerColors[player.role], emissiveIntensity: 0.12 }),
      );
      mesh.castShadow = true;
      mesh.position.y = 0.85;
      group.add(mesh);
      const visor = new THREE.Mesh(
        new THREE.BoxGeometry(0.36, 0.15, 0.08),
        new THREE.MeshStandardMaterial({ color: "#172725", roughness: 0.7 }),
      );
      visor.position.set(0, 1.28, -0.43);
      group.add(visor);
      return group;
    };
    const makePlayerObject = (player: PlayerState) => {
      const template = roleModelTemplates.get(player.role);
      const object = template ? template.clone(true) : createFallbackPlayerObject(player);
      scene.add(object);
      return object;
    };
    const assetKeyForRole = (role: PlayerRole) => roleModelKeys.get(role) ?? `fallback-${role}`;

    const roleModelLoader = new GLTFLoader();
    (Object.entries(roleModelUrls) as [PlayerRole, string | undefined][]).forEach(([role, url]) => {
      if (!url) return;
      roleModelLoader.load(url, (gltf) => {
        if (disposed) return;
        roleModelTemplates.set(role, normalizeCharacterModel(gltf.scene));
        roleModelKeys.set(role, url);
        setModelLoadNotice((current) => current.startsWith("正在加载资源包") ? "" : current);
      }, undefined, () => {
        if (disposed) return;
        setModelLoadNotice("角色资源加载失败，已使用默认几何体角色");
      });
    });

    const initialLocalPlayer = players.find((player) => player.id === localPlayerId);
    const localPosition: Vec3 = [...(initialLocalPlayer?.position ?? [0, 1.7, 0])] as Vec3;
    yawRef.current = initialLocalPlayer?.rotation[1] ?? 0;
    pitchRef.current = 0;
    const viewDirection = new THREE.Vector3(0, 0, -1);
    const rightDirection = new THREE.Vector3(1, 0, 0);
    let lastTime = performance.now();
    let lastSent = 0;
    let frame = 0;
    let hasPendingUpdate = false;
    let touchLook: { pointerId: number; x: number; y: number } | null = null;

    const onPointerLockChange = () => {
      pointerLockedRef.current = document.pointerLockElement === renderer.domElement;
      setPointerHint(pointerLockedRef.current ? "" : "点击画面进入第一人称视角");
    };
    const onMouseMove = (event: MouseEvent) => {
      if (!pointerLockedRef.current || !canMove) return;
      const sensitivity = fpvStateRef.current ? 0.0026 : 0.0022;
      yawRef.current -= event.movementX * sensitivity;
      pitchRef.current = Math.max(-1.35, Math.min(1.35, pitchRef.current - event.movementY * (fpvStateRef.current ? 0.0021 : 0.0018)));
      hasPendingUpdate = true;
    };
    const requestPointerLock = () => {
      if (canMove && typeof renderer.domElement.requestPointerLock === "function") renderer.domElement.requestPointerLock();
    };
    const onPointerFire = (event: PointerEvent) => {
      if (!canMove || event.pointerType !== "mouse" || event.button !== 0 || !pointerLockedRef.current) return;
      event.preventDefault();
      if (fpvStateRef.current) {
        onFpvDetonateRef.current?.();
        return;
      }
      onFireRef.current?.();
    };
    const onTouchLookStart = (event: PointerEvent) => {
      if (!canMove || event.pointerType !== "touch") return;
      touchLook = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const onTouchLookMove = (event: PointerEvent) => {
      if (!touchLook || event.pointerId !== touchLook.pointerId) return;
      const deltaX = event.clientX - touchLook.x;
      const deltaY = event.clientY - touchLook.y;
      touchLook.x = event.clientX;
      touchLook.y = event.clientY;
      yawRef.current -= deltaX * 0.004;
      pitchRef.current = Math.max(-0.95, Math.min(0.95, pitchRef.current - deltaY * 0.003));
      hasPendingUpdate = true;
    };
    const onTouchLookEnd = (event: PointerEvent) => {
      if (touchLook?.pointerId === event.pointerId) touchLook = null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!canMove) return;
      const key = event.key.toLowerCase();
      if (key === "e") {
        event.preventDefault();
        if (fpvStateRef.current) {
          onFpvDetonateRef.current?.();
          return;
        }
        onUseRef.current?.();
        return;
      }
      if (key === "q") {
        event.preventDefault();
        if (!fpvStateRef.current) onFpvLaunchRef.current?.();
        return;
      }
      if (key === "r") {
        event.preventDefault();
        onReloadRef.current?.();
        return;
      }
      if (key === " ") {
        event.preventDefault();
        if (!fpvStateRef.current && onGroundRef.current) {
          verticalVelocityRef.current = jumpSpeed;
          onGroundRef.current = false;
          hasPendingUpdate = true;
        }
        return;
      }
      if (["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Shift", "Control"].includes(event.key)) {
        event.preventDefault();
        pressedKeysRef.current.add(key);
        crouchingRef.current = pressedKeysRef.current.has("control");
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === "e" && !fpvStateRef.current) onUseReleaseRef.current?.();
      pressedKeysRef.current.delete(key);
      crouchingRef.current = pressedKeysRef.current.has("control");
    };
    const clearInput = () => {
      if (pressedKeysRef.current.has("e") && !fpvStateRef.current) onUseReleaseRef.current?.();
      pressedKeysRef.current.clear();
      touchDirectionRef.current = { horizontal: 0, vertical: 0 };
      crouchingRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearInput);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    document.addEventListener("mousemove", onMouseMove);
    renderer.domElement.addEventListener("click", requestPointerLock);
    renderer.domElement.addEventListener("pointerdown", onPointerFire);
    renderer.domElement.addEventListener("pointerdown", onTouchLookStart);
    renderer.domElement.addEventListener("pointermove", onTouchLookMove);
    renderer.domElement.addEventListener("pointerup", onTouchLookEnd);
    renderer.domElement.addEventListener("pointercancel", onTouchLookEnd);

    const resize = () => {
      const nextWidth = mount.clientWidth;
      const nextHeight = mount.clientHeight;
      camera.aspect = nextWidth / Math.max(nextHeight, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(nextWidth, nextHeight, false);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    const animate = (time: number) => {
      const delta = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      const currentPlayers = playersRef.current;
      const currentScanTargets = scanTargetsRef.current;
      const currentBomb = bombRef.current;
      const currentDroppedBomb = droppedBombRef.current;
      const currentFpvDrones = fpvDronesRef.current;
      const currentLocalFpvDroneId = localFpvDroneIdRef.current;
      const localPlayer = currentPlayers.find((player) => player.id === localIdRef.current);
      const pressedKeys = pressedKeysRef.current;
      const touchDirection = touchDirectionRef.current;
      const localFpvDrone = currentLocalFpvDroneId ? currentFpvDrones.find((drone) => drone.id === currentLocalFpvDroneId) : undefined;

      // ---- FPV 模式：接管相机与 WASD ----
      if (localFpvDrone && localFpvDrone.state === "flying" && !fpvStateRef.current) {
        fpvStateRef.current = { droneId: localFpvDrone.id, position: [...localFpvDrone.position] as Vec3, lastSent: 0 };
        setFpvNotice("穿越机视角 · WASD 移动 · Shift升/Ctrl降 · E/左键引爆");
        window.setTimeout(() => setFpvNotice(""), 2600);
      }
      if (fpvStateRef.current && (!localFpvDrone || localFpvDrone.state !== "flying")) {
        fpvStateRef.current = null;
        setFpvNotice("穿越机已回收/损毁，已切回本人视角");
        window.setTimeout(() => setFpvNotice(""), 2600);
      }
      if (fpvStateRef.current && localFpvDrone) {
        const fpv = fpvStateRef.current;
        const horizontal = (pressedKeys.has("d") || pressedKeys.has("arrowright") ? 1 : 0) - (pressedKeys.has("a") || pressedKeys.has("arrowleft") ? 1 : 0) + touchDirection.horizontal;
        const vertical = (pressedKeys.has("w") || pressedKeys.has("arrowup") ? 1 : 0) - (pressedKeys.has("s") || pressedKeys.has("arrowdown") ? 1 : 0) - touchDirection.vertical;
        const lift = (pressedKeys.has("shift") ? 1 : 0) - (pressedKeys.has("control") ? 1 : 0);
        const length = Math.hypot(horizontal, vertical) || 1;
        const speed = 14;
        if (canMove && (horizontal || vertical || lift)) {
          viewDirection.set(-Math.sin(yawRef.current), 0, -Math.cos(yawRef.current)).normalize();
          rightDirection.set(Math.cos(yawRef.current), 0, -Math.sin(yawRef.current)).normalize();
          const dx = ((rightDirection.x * horizontal + viewDirection.x * vertical) / length) * speed * delta;
          const dz = ((rightDirection.z * horizontal + viewDirection.z * vertical) / length) * speed * delta;
          const dy = lift * 8 * delta;
          fpv.position = [
            Math.max(config.bounds.min[0], Math.min(config.bounds.max[0], fpv.position[0] + dx)),
            Math.max(0.6, Math.min(config.bounds.max[1], fpv.position[1] + dy)),
            Math.max(config.bounds.min[2], Math.min(config.bounds.max[2], fpv.position[2] + dz)),
          ];
        }
        if (time - fpv.lastSent > 80) {
          fpv.lastSent = time;
          onFpvMoveRef.current?.(fpv.droneId, [...fpv.position] as Vec3, yawRef.current);
        }
        camera.position.set(fpv.position[0], fpv.position[1], fpv.position[2]);
        camera.lookAt(
          fpv.position[0] - Math.sin(yawRef.current) * Math.cos(pitchRef.current),
          fpv.position[1] + Math.sin(pitchRef.current),
          fpv.position[2] - Math.cos(yawRef.current) * Math.cos(pitchRef.current),
        );
      } else {
        // ---- 普通第一人称 ----
        const correction = positionCorrectionRef.current;
        if (correction) {
          localPosition[0] = correction[0];
          localPosition[1] = correction[1];
          localPosition[2] = correction[2];
          verticalVelocityRef.current = 0;
          onGroundRef.current = true;
          positionCorrectionRef.current = null;
          onPositionCorrectionAppliedRef.current?.();
        }
        if (localPlayer && !pressedKeys.size && !touchDirection.horizontal && !touchDirection.vertical && onGroundRef.current) {
          localPosition[0] = localPlayer.position[0];
          localPosition[1] = localPlayer.position[1];
          localPosition[2] = localPlayer.position[2];
        }

        const horizontal = (pressedKeys.has("d") || pressedKeys.has("arrowright") ? 1 : 0) - (pressedKeys.has("a") || pressedKeys.has("arrowleft") ? 1 : 0) + touchDirection.horizontal;
        const vertical = (pressedKeys.has("w") || pressedKeys.has("arrowup") ? 1 : 0) - (pressedKeys.has("s") || pressedKeys.has("arrowdown") ? 1 : 0) - touchDirection.vertical;
        const length = Math.hypot(horizontal, vertical) || 1;
        if (canMove && (horizontal || vertical)) {
          const sprinting = pressedKeys.has("shift") && !crouchingRef.current;
          const speed = crouchingRef.current ? 3.2 : sprinting ? 9.5 : 6.2;
          viewDirection.set(-Math.sin(yawRef.current), 0, -Math.cos(yawRef.current)).normalize();
          rightDirection.set(Math.cos(yawRef.current), 0, -Math.sin(yawRef.current)).normalize();
          const dx = ((rightDirection.x * horizontal + viewDirection.x * vertical) / length) * speed * delta;
          const dz = ((rightDirection.z * horizontal + viewDirection.z * vertical) / length) * speed * delta;
          const safePosition = resolvePlayerMove(config, localPosition, [localPosition[0] + dx, localPosition[1], localPosition[2] + dz]);
          localPosition[0] = safePosition[0];
          localPosition[2] = safePosition[2];
          hasPendingUpdate = true;
        }
        // 重力
        const feetY = localPosition[1] - playerEyeHeight;
        const ground = groundHeight(obstacles, localPosition[0], localPosition[2], feetY);
        if (!onGroundRef.current) {
          verticalVelocityRef.current += gravity * delta;
          localPosition[1] += verticalVelocityRef.current * delta;
          const nextFeet = localPosition[1] - playerEyeHeight;
          if (verticalVelocityRef.current <= 0) {
            const nextGround = groundHeight(obstacles, localPosition[0], localPosition[2], nextFeet + 0.35);
            if (nextGround > 0 && nextFeet <= nextGround) {
              localPosition[1] = nextGround + playerEyeHeight;
              verticalVelocityRef.current = 0;
              onGroundRef.current = true;
            } else if (localPosition[1] - playerEyeHeight <= 0) {
              localPosition[1] = playerEyeHeight;
              verticalVelocityRef.current = 0;
              onGroundRef.current = true;
            }
          }
        } else {
          // 站立状态下支撑面变化（走下高箱）
          if (feetY > ground + 0.05) {
            onGroundRef.current = false;
            verticalVelocityRef.current = 0;
          } else {
            localPosition[1] = ground + playerEyeHeight;
          }
        }
        if (canMove && hasPendingUpdate && time - lastSent > 80) {
          lastSent = time;
          hasPendingUpdate = false;
          onMoveRef.current([...localPosition] as Vec3, [pitchRef.current, yawRef.current, 0]);
        }

        const cameraHeight = crouchingRef.current ? localPosition[1] - 0.45 : localPosition[1];
        camera.position.set(localPosition[0], cameraHeight, localPosition[2]);
        camera.lookAt(
          localPosition[0] - Math.sin(yawRef.current) * Math.cos(pitchRef.current),
          cameraHeight + Math.sin(pitchRef.current),
          localPosition[2] - Math.cos(yawRef.current) * Math.cos(pitchRef.current),
        );
      }

      const visibleIds = new Set(currentPlayers.map((player) => player.id));
      for (const [id, record] of playerObjects) {
        if (!visibleIds.has(id)) {
          scene.remove(record.object);
          playerObjects.delete(id);
        }
      }
      for (const player of currentPlayers) {
        const nextAssetKey = assetKeyForRole(player.role);
        let record = playerObjects.get(player.id);
        if (!record || record.role !== player.role || record.assetKey !== nextAssetKey) {
          if (record) scene.remove(record.object);
          record = { object: makePlayerObject(player), role: player.role, assetKey: nextAssetKey };
          playerObjects.set(player.id, record);
        }
        const position = player.id === localIdRef.current ? localPosition : player.position;
        record.object.position.set(position[0], Math.max(config.bounds.min[1], position[1] - playerEyeHeight), position[2]);
        record.object.rotation.y = player.rotation[1] ?? 0;
        record.object.visible = player.id !== localIdRef.current && !player.caught && (player.health ?? 1) > 0;
      }

      const visibleScanIds = new Set<string>();
      for (const target of currentScanTargets) {
        if (new Date(target.expiresAt).getTime() <= Date.now()) continue;
        visibleScanIds.add(target.id);
        let marker = scanMarkerObjects.get(target.id);
        if (!marker) {
          marker = createScanMarker();
          scanMarkerObjects.set(target.id, marker);
          scene.add(marker);
        }
        marker.position.set(target.position[0], 0, target.position[2]);
        marker.rotation.y += delta * 2.8;
        marker.visible = true;
      }
      for (const [id, marker] of scanMarkerObjects) {
        if (!visibleScanIds.has(id)) {
          scene.remove(marker);
          scanMarkerObjects.delete(id);
        }
      }

      // ---- 已安装炸弹：闪烁灯 ----
      if (currentBomb?.plantedAt && currentBomb.position) {
        bombGroup.visible = true;
        bombGroup.position.set(currentBomb.position[0], Math.max(0.15, currentBomb.position[1] - playerEyeHeight + 0.18), currentBomb.position[2]);
        bombLight.material.color.setHex(Math.floor(time / 300) % 2 === 0 ? 0xff3b30 : 0x571210);
      } else {
        bombGroup.visible = false;
      }

      // ---- 掉落炸弹 ----
      if (currentDroppedBomb) {
        droppedBombGroup.visible = true;
        droppedBombGroup.position.set(currentDroppedBomb.position[0], Math.max(0.14, currentDroppedBomb.position[1] - playerEyeHeight + 0.16), currentDroppedBomb.position[2]);
        droppedRing.rotation.z += delta * 1.6;
      } else {
        droppedBombGroup.visible = false;
      }

      // ---- FPV 穿越机渲染 ----
      const visibleDroneIds = new Set(currentFpvDrones.filter((drone) => drone.state === "flying").map((drone) => drone.id));
      // 检测消失的穿越机（引爆/坠落/被击落）：生成爆炸特效
      for (const [id, position] of lastFrameDrones) {
        if (!visibleDroneIds.has(id)) spawnExplosion(position, 7);
      }
      lastFrameDrones.clear();
      for (const drone of currentFpvDrones) {
        if (drone.state === "flying") lastFrameDrones.set(drone.id, [...drone.position] as Vec3);
      }
      for (const [id, object] of droneObjects) {
        if (!visibleDroneIds.has(id)) {
          scene.remove(object);
          droneObjects.delete(id);
        }
      }
      for (const drone of currentFpvDrones) {
        if (drone.state !== "flying") continue;
        let object = droneObjects.get(drone.id);
        if (!object) {
          object = makeDroneObject();
          droneObjects.set(drone.id, object);
          scene.add(object);
        }
        object.position.set(drone.position[0], drone.position[1], drone.position[2]);
        object.rotation.y = drone.yaw;
      }

      // ---- 爆炸特效衰减 ----
      for (let i = explosions.length - 1; i >= 0; i -= 1) {
        const explosion = explosions[i];
        const age = (time - explosion.startedAt) / 1000;
        if (age > 0.8) {
          scene.remove(explosion.mesh);
          explosion.mesh.geometry.dispose();
          (explosion.mesh.material as THREE.Material).dispose();
          explosions.splice(i, 1);
          continue;
        }
        const t = age / 0.8;
        explosion.mesh.scale.setScalar(0.3 + t * 0.9);
        (explosion.mesh.material as THREE.MeshBasicMaterial).opacity = 0.65 * (1 - t);
      }

      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearInput);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("mousemove", onMouseMove);
      renderer.domElement.removeEventListener("click", requestPointerLock);
      renderer.domElement.removeEventListener("pointerdown", onPointerFire);
      renderer.domElement.removeEventListener("pointerdown", onTouchLookStart);
      renderer.domElement.removeEventListener("pointermove", onTouchLookMove);
      renderer.domElement.removeEventListener("pointerup", onTouchLookEnd);
      renderer.domElement.removeEventListener("pointercancel", onTouchLookEnd);
      if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
      clearInput();
      fpvStateRef.current = null;
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach((material) => material.dispose());
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
  }, [canMove, config, localPlayerId, modelUrl, resourcePack]);

  const setTouchDirection = (horizontal: number, vertical: number) => {
    if (canMove) touchDirectionRef.current = { horizontal, vertical };
  };
  const clearTouchDirection = () => {
    touchDirectionRef.current = { horizontal: 0, vertical: 0 };
  };

  return <div className="game-scene-wrap"><div className="game-scene" ref={mountRef} aria-label="战术爆破第一人称三维游戏场景" />{canMove ? <><div className="scene-crosshair" aria-hidden="true" /><div className="scene-pointer-hint">{fpvNotice || pointerHint || "左键开火 · E 安装/拆除 · R 换弹 · Q 穿越机 · Shift 加速 · 空格跳"}</div><div className="touch-move-pad" aria-label="移动方向控制"><button aria-label="向前移动" onPointerDown={() => setTouchDirection(0, -1)} onPointerUp={clearTouchDirection} onPointerLeave={clearTouchDirection} onPointerCancel={clearTouchDirection}><ChevronUp size={25} /></button><button aria-label="向左移动" onPointerDown={() => setTouchDirection(-1, 0)} onPointerUp={clearTouchDirection} onPointerLeave={clearTouchDirection} onPointerCancel={clearTouchDirection}><ChevronLeft size={25} /></button><span aria-hidden="true" /><button aria-label="向右移动" onPointerDown={() => setTouchDirection(1, 0)} onPointerUp={clearTouchDirection} onPointerLeave={clearTouchDirection} onPointerCancel={clearTouchDirection}><ChevronRight size={25} /></button><button aria-label="向后移动" onPointerDown={() => setTouchDirection(0, 1)} onPointerUp={clearTouchDirection} onPointerLeave={clearTouchDirection} onPointerCancel={clearTouchDirection}><ChevronDown size={25} /></button></div></> : null}{modelLoadNotice ? <div className="scene-load-notice" role="status">{modelLoadNotice}</div> : null}</div>;
}
