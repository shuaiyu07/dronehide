import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { io, type Socket } from "socket.io-client";
import type { MapInfo, RoomState } from "../../shared/types.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function socketEvent(socket: Socket, event: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const listener = (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    };
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for socket event: ${event}`));
    }, 5000);
    socket.once(event, listener);
  });
}
async function until(condition: () => boolean | Promise<boolean>, label: string, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await pause(25);
  }
  throw new Error(`Timed out: ${label}`);
}

test("Socket.IO bomb and player lifecycle", { timeout: 60000 }, async (t) => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", "server/src/index.ts"], {
    cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let logs = "";
  child.stdout!.on("data", (data) => { logs += data; });
  child.stderr!.on("data", (data) => { logs += data; });
  const clients: Socket[] = [];
  t.after(async () => {
    clients.forEach((socket) => socket.disconnect());
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
  const base = `http://127.0.0.1:${port}`;
  await until(async () => {
    if (child.exitCode !== null) throw new Error(logs);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, "isolated server startup");
  const mapList = await (await fetch(`${base}/api/maps`)).json() as { items: MapInfo[] };
  const map = mapList.items.find((item) => item.id === "warehouse-fortress")!;
  assert.ok(map);
  const response = await fetch(`${base}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Socket regression", mapId: map.id }) });
  assert.equal(response.status, 201);
  const created = await response.json() as RoomState;
  let state = created;
  for (let index = 0; index < 4; index += 1) {
    const socket = io(base, { autoConnect: false, transports: ["websocket"], reconnection: false, timeout: 3000 });
    clients.push(socket);
    socket.on("room:state", (room: RoomState) => { state = room; });
    const connected = socketEvent(socket, "connect");
    socket.connect();
    await connected;
    socket.emit("room:join", { roomId: created.id, name: `Client ${index}` });
    await until(() => state.players.some((p) => p.id === socket.id), "join confirmation");
  }
  clients[0].emit("room:start");
  await until(() => state.status === "playing", "initial preparation", map.config.rules.prepareTime * 1000 + 4000);
  const attackers = clients.filter((s) => state.players.find((p) => p.id === s.id)?.role === "attacker");
  const defenders = clients.filter((s) => state.players.find((p) => p.id === s.id)?.role === "defender");
  const player = (socket: Socket) => state.players.find((p) => p.id === socket.id)!;
  const move = async (socket: Socket, position: [number, number, number]) => {
    socket.emit("player:update", { position, rotation: [0, 0, 0] });
    await until(() => player(socket)?.position.every((value, i) => Math.abs(value - position[i]) < 0.01), `position acknowledgement ${position.join(",")} from ${player(socket)?.position.join(",")}`);
  };

  // These routes intentionally pass through open lanes in Warehouse Fortress. The
  // browser sends small movement updates; the test keeps a few legal waypoints
  // instead of relying on the old, unsafe full-map teleport behaviour.
  const moveVia = async (socket: Socket, waypoints: [number, number, number][]) => {
    for (const waypoint of waypoints) await move(socket, waypoint);
  };

  await t.test("reload conserves ammo over real socket and timer", async () => {
    attackers[0].emit("weapon:fire");
    await until(() => player(attackers[0]).ammo === 29, "shot");
    attackers[0].emit("weapon:reload");
    await until(() => Boolean(player(attackers[0]).reloadingUntil), "reload start");
    assert.equal(player(attackers[0]).reserveAmmo, 90);
    await until(() => !player(attackers[0]).reloadingUntil, "reload completion");
    assert.equal(player(attackers[0]).ammo, 30);
    assert.equal(player(attackers[0]).reserveAmmo, 89);
  });
  const site = map.config.bombSites![0];
  const bombPosition: [number, number, number] = [site.center[0], 1.7, site.center[2]];
  await moveVia(attackers[0], [[-36, 1.7, 10], bombPosition]);
  attackers[0].emit("bomb:plant", { siteId: site.id });
  await until(() => Boolean(state.bomb?.plantedAt), "plant");
  await moveVia(defenders[0], [[42, 1.7, -32], [42, 1.7, 37.5], [-35, 1.7, 37.5], [-35, 1.7, 10], bombPosition]);
  await moveVia(defenders[1], [[42, 1.7, 37.5], [-35, 1.7, 37.5], [-35, 1.7, 10], bombPosition]);

  await t.test("other players cannot interrupt or replace the defuser", async () => {
    defenders[0].emit("bomb:defuse");
    await until(() => Boolean(state.bomb?.defusingUntil), "defuse start");
    const deadline = state.bomb!.defusingUntil;
    await move(attackers[1], [...player(attackers[1]).position]);
    assert.equal(state.bomb?.defusingUntil, deadline);
    const denied = socketEvent(defenders[1], "room:error");
    defenders[1].emit("bomb:defuse");
    await denied;
    assert.equal(state.bomb?.defuserId, defenders[0].id);
    defenders[1].emit("bomb:defuse:cancel");
    await pause(100);
    assert.equal(state.bomb?.defusingUntil, deadline);
  });

  await t.test("defuser movement cancels and allows another defender to start", async () => {
    await move(defenders[0], [bombPosition[0] + 0.2, 1.7, bombPosition[2]]);
    assert.equal(state.bomb?.defusingUntil, undefined);
    defenders[1].emit("bomb:defuse");
    await until(() => state.bomb?.defuserId === defenders[1].id, "new defuser");
  });

  await t.test("planted bomb remains live when all attackers leave", async () => {
    for (const socket of attackers) {
      const id = socket.id;
      socket.emit("room:leave");
      await until(() => !state.players.some((p) => p.id === id), "attacker departure");
    }
    assert.equal(state.status, "playing");
    assert.ok(state.bomb?.plantedAt);
    await until(() => state.status === "ended", "defuse settlement");
    assert.equal(state.roundEndReason, "bomb-defused");
    assert.equal(state.score?.defenderWins, 1);
    assert.equal(state.teamScore?.bravo, 1);
  });

  await t.test("leaving intermission resets the room and cancels next round", async () => {
    const id = defenders[0].id;
    defenders[0].emit("room:leave");
    await until(() => state.status === "waiting" && !state.players.some((p) => p.id === id), "return to lobby");
    assert.equal(state.nextRoundAt, undefined);
    assert.equal(state.bomb, undefined);
    await pause(6300);
    assert.equal(state.status, "waiting");
    assert.equal(state.players.length, 1);
  });
});
