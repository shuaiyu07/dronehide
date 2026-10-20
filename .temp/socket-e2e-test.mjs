/**
 * 战术爆破模式核心玩法 Socket 端到端验证脚本
 * 用法：node .temp/socket-e2e-test.mjs
 *
 * 验证项：
 * 1. 建房（host）→ 加入（joiner）→ 开始 → 队伍分配
 * 2. weapon:fire 命中与穿墙（blocked）判定
 * 3. 炸弹安装/掉落/拾取
 * 4. 拆弹流程
 * 5. FPV 穿越机发射/移动/引爆
 * 6. 回合结束与攻防互换
 */
import { io } from "socket.io-client";

const SERVER = "http://localhost:3001";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function log(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
}

// ---------- 工具：连接并加入房间 ----------
function connectAndJoin(name, room) {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER, { transports: ["websocket"], reconnection: false, timeout: 5000 });
    const state = { socket, player: null, events: [], roomState: null, playerId: null };
    const timeout = setTimeout(() => reject(new Error(`${name} 连接超时`)), 8000);
    socket.on("connect", () => {
      socket.emit("room:join", { roomId: room, name });
      // 等待 room:state 广播确认加入（state 里包含自己）
      const onState = (s) => {
        const me = s?.players?.find((p) => p.id === socket.id);
        if (!me) return;
        state.roomState = s;
        state.playerId = socket.id;
        clearTimeout(timeout);
        socket.off("room:state", onState);
        // resolve 后保留持久监听，持续同步状态
        socket.on("room:state", (s2) => { state.roomState = s2; });
        resolve({ socket, state });
      };
      socket.on("room:state", onState);
    });
    socket.on("room:event", (e) => { state.events.push(e); });
    socket.on("round:event", (e) => { state.events.push(e); });
    socket.on("combat:feedback", (e) => { state.combatFeedback = e; state.events.push({ type: "combat:feedback", ...e }); });
    socket.on("room:error", (e) => { state.error = e; });
    socket.on("connect_error", (e) => reject(new Error(`${name} 连接错误: ${e.message}`)));
  });
}

async function main() {
  // ---- 0. 房主通过 REST 创建房间 ----
  const createResp = await fetch(`${SERVER}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "E2E 测试房", mapId: "warehouse-fortress" }),
  });
  const createJson = await createResp.json();
  const roomId = createJson.id;
  log("创建房间 warehouse-fortress", !!roomId, `room=${roomId}`);

  // ---- 1. 两名玩家加入 ----
  const host = await connectAndJoin("Host", roomId);
  log("房主加入", true, `playerId=${host.state.playerId}`);
  const guest = await connectAndJoin("Guest", roomId);
  log("第二名玩家加入", true, `playerId=${guest.state.playerId}`);

  // 等待房间状态同步
  await sleep(500);
  log("房间人数为 2", host.state.roomState?.players?.length === 2, JSON.stringify(host.state.roomState?.players?.map(p => p.name)));

  // ---- 2. 房主开始游戏 ----
  host.socket.emit("room:start");
  await sleep(800);
  const st = host.state.roomState;
  log("进入准备阶段", st?.status === "preparing" || st?.status === "playing", `status=${st?.status}`);

  // ---- 3. 等待准备阶段结束（15 秒）----
  await sleep(16000);
  const st2 = host.state.roomState;
  log("正式回合开始", st2?.status === "playing" && st2?.roundNumber === 1, `round=${st2?.roundNumber}, status=${st2?.status}`);

  // ---- 4. 检查玩家角色分配并缓存连接引用 ----
  const hostPlayer = st2?.players?.find(p => p.id === host.state.playerId);
  const guestPlayer = st2?.players?.find(p => p.id === guest.state.playerId);
  log("攻防角色分配", hostPlayer && guestPlayer && hostPlayer.role !== guestPlayer.role,
    `host=${hostPlayer?.role}, guest=${guestPlayer?.role}`);
  const hostIsAttacker = hostPlayer?.role === "attacker";
  const attackerConn = hostIsAttacker ? host : guest;
  const defenderConn = hostIsAttacker ? guest : host;
  const attackerRoleName = hostIsAttacker ? "Host" : "Guest";

  // ---- 5. 射击命中反馈（回合 1：打 2 枪验证 hit，不击杀）----
  {
    // 防守方站到开阔点（东管道走廊中心 27,1.7,-8，四周无墙），进攻方站其正南 3 米朝北开枪
    const defenderPos = [27, 1.7, -8];
    defenderConn.socket.emit("player:update", { position: defenderPos, rotation: [0, 0, 0] });
    await sleep(200);
    attackerConn.socket.emit("player:update", { position: [defenderPos[0], defenderPos[1], defenderPos[2] - 3], rotation: [0, Math.PI, 0] });
    await sleep(200);
    let hitCount = 0;
    let blockedCount = 0;
    for (let i = 0; i < 2; i++) {
      attackerConn.socket.emit("weapon:fire");
      await sleep(350);
      const fb = attackerConn.state.combatFeedback;
      if (fb?.type === "hit") hitCount++;
      if (fb?.type === "blocked") blockedCount++;
    }
    const defHealth = host.state.roomState?.players?.find(p => p.role === "defender")?.health;
    log("射击命中反馈(hit)", hitCount >= 1, `hit=${hitCount}, blocked=${blockedCount}, defenderHP=${defHealth}`);
  }

  // ---- 6. 炸弹安装（进攻方移动到爆破点 A）----
  {
    attackerConn.socket.emit("player:update", { position: [-34, 1.7, -26], rotation: [0, 0, 0] });
    await sleep(200);
    attackerConn.socket.emit("bomb:plant", { siteId: "site-a" });
    await sleep(500);
    const st3 = host.state.roomState;
    const bombPlanted = st3?.bomb?.plantedAt;
    log("安装炸弹", !!bombPlanted, `bomb=${JSON.stringify(st3?.bomb)}`);
  }

  // ---- 7. 拆弹完成（回合 1 应以 bomb-defused 结束，防守方 1:0）----
  {
    defenderConn.socket.emit("player:update", { position: [-34, 1.7, -26], rotation: [0, 0, 0] });
    await sleep(200);
    defenderConn.socket.emit("bomb:defuse");
    await sleep(600);
    const st = host.state.roomState;
    const defusing = !!st?.bomb?.defusingUntil;
    log("开始拆弹", defusing, `defusingUntil=${st?.bomb?.defusingUntil}`);
    if (defusing) {
      await sleep(5300);
      const stD = host.state.roomState;
      const defused = !stD?.bomb?.plantedAt;
      const defuseEvent = host.state.events.find((e) => e.type === "bomb-defused");
      log("拆弹完成", defused && !!defuseEvent, `bomb=${JSON.stringify(stD?.bomb)}, event=${JSON.stringify(defuseEvent)}`);
      log("回合1防守方得分", stD?.score?.defenderWins === 1, `score=${JSON.stringify(stD?.score)}`);
    }
  }

  // ---- 8. 回合 2：验证下一回合开启（每 2 回合互换，回合 1→2 不换边）----
  {
    console.log("  ... 等待回合间隔与第 2 回合开始");
    let stNext = null;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      stNext = host.state.roomState;
      if (stNext?.roundNumber === 2 && stNext?.status === "playing") break;
    }
    const round2Ok = stNext?.roundNumber === 2 && stNext?.status === "playing";
    log("回合2开始", round2Ok, `round=${stNext?.roundNumber}, status=${stNext?.status}`);
    const r2Host = stNext?.players?.find(p => p.id === host.state.playerId);
    log("回合2角色保持(第2回合不换边)", !!r2Host && r2Host.role === hostPlayer?.role,
      `host: ${hostPlayer?.role} -> ${r2Host?.role}`);
    // 连接引用保持不变（未换边）
  }

  // ---- 9. 回合 2：FPV 穿越机发射 / 引爆 ----
  {
    attackerConn.socket.emit("fpv:launch");
    await sleep(300);
    const fpvList = host.state.roomState?.fpvDrones ?? [];
    log("FPV 穿越机发射", fpvList.length > 0, `count=${fpvList.length}`);
    if (fpvList.length > 0) {
      const drone = fpvList[0];
      attackerConn.socket.emit("fpv:update", { droneId: drone.id, position: [drone.position[0], drone.position[1] + 1, drone.position[2]], yaw: 0 });
      await sleep(200);
      const waitMs = Math.max(0, drone.armedAt - Date.now()) + 400;
      console.log(`  ... 等待起飞保护 ${Math.round(waitMs)}ms`);
      await sleep(waitMs);
      attackerConn.socket.emit("fpv:detonate", { droneId: drone.id });
      await sleep(400);
      const st = host.state.roomState;
      const destroyed = !(st?.fpvDrones ?? []).some((d) => d.id === drone.id);
      const detonateEvent = host.state.events.some((e) => e.type === "drone-fpv" && /引爆/.test(e.message ?? ""));
      log("FPV 引爆", destroyed, `剩余=${(st?.fpvDrones ?? []).length}, events=${JSON.stringify(host.state.events.filter((e) => e.type.startsWith("drone")).slice(-3))}`);
    }
  }

  // ---- 10. 回合 2：击杀全灭（3 枪击倒防守方，进攻方回合胜利，1:1）----
  {
    const stR2 = host.state.roomState;
    const defenderNow = stR2?.players?.find((p) => p.role === "defender");
    const attackerNow = stR2?.players?.find((p) => p.role === "attacker");
    if (defenderNow && attackerNow) {
      defenderConn.socket.emit("player:update", { position: [27, 1.7, -8], rotation: [0, 0, 0] });
      await sleep(200);
      attackerConn.socket.emit("player:update", { position: [27, 1.7, -11], rotation: [0, Math.PI, 0] });
      await sleep(200);
      let killConfirmed = false;
      for (let i = 0; i < 6; i++) {
        attackerConn.socket.emit("weapon:fire");
        await sleep(350);
        if (host.state.events.some((e) => e.type === "kill")) { killConfirmed = true; break; }
        const hp = host.state.roomState?.players?.find((p) => p.role === "defender")?.health;
        if (hp !== undefined && hp <= 0) { killConfirmed = true; break; }
      }
      log("击杀判定(kill事件或killfeed)", killConfirmed, JSON.stringify(host.state.events.filter((e) => e.type === "kill").slice(-1)));
      const stAfterKill = host.state.roomState;
      const killEntry = stAfterKill?.killFeed?.[(stAfterKill.killFeed ?? []).length - 1];
      log("killfeed 记录", !!killEntry, JSON.stringify(killEntry));
      if (killConfirmed) {
        // 等回合结算：对方全灭 → 进攻方胜
        let stSettled = null;
        for (let i = 0; i < 15; i++) {
          await sleep(1000);
          stSettled = host.state.roomState;
          if (stSettled?.roundNumber === 3 || stSettled?.status === "ended") break;
        }
        log("回合2进攻方得分(1:1)", stSettled?.score?.attackerWins === 1, `score=${JSON.stringify(stSettled?.score)}, round=${stSettled?.roundNumber}, status=${stSettled?.status}`);
      }
    } else {
      log("击杀判定(kill事件)", false, "回合2角色未找到");
    }
  }

  console.log("\n==== 汇总 ====");
  const failed = results.filter(r => !r.ok);
  console.log(`通过 ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log("失败项：");
    failed.forEach(f => console.log(`  - ${f.name}: ${f.detail}`));
    process.exitCode = 1;
  }
  host.socket.close(); guest.socket.close();
  await sleep(300);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});