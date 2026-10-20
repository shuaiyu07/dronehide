import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { ArrowLeft, CheckCircle2, Clock3, Copy, Crosshair, Gamepad2, LogOut, PackageCheck, Play, Radio, Rocket, Shield, ShieldCheck, Swords, Target, Users } from "lucide-react";
import GameScene from "./GameScene";
import type { DroneAbility, DroneScanTarget, FpvDroneEntity, MapInfo, PlayerState, ResourcePackInfo, RoomState, Vec3 } from "../../shared/types.ts";

type GameRoomProps = {
  roomId: string;
  map: MapInfo;
  inviteUrl: string;
  resourcePack: ResourcePackInfo | null;
  onExit: () => void;
};

function roleLabel(role: PlayerState["role"]) {
  if (role === "attacker") return "进攻方";
  if (role === "defender") return "防守方";
  if (role === "seeker") return "寻找者";
  if (role === "hider") return "躲藏者";
  return "等待分配";
}

function formatCountdown(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function statusLabel(status: RoomState["status"]) {
  if (status === "waiting") return "等待开局";
  if (status === "preparing") return "准备阶段";
  if (status === "playing") return "回合进行";
  return "回合结束";
}

function runtimeModelAssetCount(pack: ResourcePackInfo | null) {
  if (!pack) return 0;
  return pack.assets.filter((asset) => {
    const format = asset.format?.toLowerCase();
    const path = asset.path?.toLowerCase() ?? "";
    return Boolean(asset.path) && (asset.kind === "character" || asset.kind === "model") && (format === "glb" || format === "gltf" || /\.(glb|gltf)$/.test(path));
  }).length;
}

function distance2d(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function alive(player: PlayerState) {
  if (player.role === "attacker" || player.role === "defender") return (player.health ?? 100) > 0;
  return !player.caught;
}

function resultLabel(room: RoomState, localPlayer: PlayerState | null) {
  if (room.matchWinnerTeamId && localPlayer?.teamId) return room.matchWinnerTeamId === localPlayer.teamId ? "你所在的队伍赢得整场比赛" : "对方队伍赢得整场比赛";
  if (room.winner === "draw") return "平局";
  if (!room.winner || !localPlayer) return "本局结束";
  if (room.winner === localPlayer.role) return "你所在的队伍获胜";
  return "本局失利";
}

export default function GameRoom({ roomId, map, inviteUrl, resourcePack, onExit }: GameRoomProps) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [playerName, setPlayerName] = useState("");
  const playerNameRef = useRef("");
  const [nameInput, setNameInput] = useState("");
  const [message, setMessage] = useState("正在连接房间...");
  const [roundEvent, setRoundEvent] = useState("");
  const [scanTargets, setScanTargets] = useState<DroneScanTarget[]>([]);
  const [positionCorrection, setPositionCorrection] = useState<Vec3 | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copiedInvite, setCopiedInvite] = useState(false);
  const isTacticalBomb = map.config.gameMode === "tactical-bomb";

  useEffect(() => {
    const nextSocket = io();
    setSocket(nextSocket);
    nextSocket.on("connect", () => {
      setIsConnected(true);
      setPlayerId(nextSocket.id ?? null);
      if (playerNameRef.current) {
        setMessage("连接已恢复，正在重新加入房间");
        nextSocket.emit("room:join", { roomId, name: playerNameRef.current });
      } else {
        setMessage("已连接，输入昵称后加入房间");
      }
    });
    nextSocket.on("room:state", (nextRoom: RoomState) => {
      setRoom(nextRoom);
      if (nextRoom.status === "waiting" || nextRoom.status === "ended") setScanTargets([]);
      setMessage(nextRoom.status === "waiting" ? "等待玩家加入" : nextRoom.status === "preparing" ? "队伍已分配，等待正式开始" : nextRoom.status === "playing" ? "回合进行中" : "本回合已结束");
    });
    nextSocket.on("player:correction", ({ position }: { position: Vec3 }) => {
      setPositionCorrection(position);
    });
    nextSocket.on("combat:feedback", ({ type, targetName }: { type: string; targetName?: string }) => {
      if (type === "hit") setRoundEvent(targetName ? `命中 ${targetName}` : "命中");
      else if (type === "blocked") setRoundEvent("子弹被掩体挡住");
      else if (type === "empty") setRoundEvent("弹匣已空，按 R 换弹");
      else if (type === "reloading") setRoundEvent("正在换弹，无法开火");
    });
    nextSocket.on("room:error", ({ message: errorMessage }: { message: string }) => setMessage(errorMessage));
    nextSocket.on("round:event", ({ message: eventMessage }: { message: string }) => {
      setRoundEvent(eventMessage);
      window.setTimeout(() => setRoundEvent((current) => current === eventMessage ? "" : current), 2600);
    });
    nextSocket.on("drone:scan-result", ({ targets, message: eventMessage }: { targets: DroneScanTarget[]; message: string }) => {
      setScanTargets(targets);
      setRoundEvent(eventMessage);
      window.setTimeout(() => setRoundEvent((current) => current === eventMessage ? "" : current), 2600);
    });
    nextSocket.on("disconnect", () => {
      setIsConnected(false);
      setPlayerId(null);
      setMessage("连接已中断，正在尝试重新连接...");
    });
    nextSocket.on("connect_error", () => {
      setIsConnected(false);
      setMessage("暂时无法连接联机服务，请检查后端是否运行");
    });
    return () => {
      nextSocket.emit("room:leave");
      nextSocket.disconnect();
    };
  }, [roomId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const localPlayer = useMemo(() => room?.players.find((player) => player.id === playerId) ?? null, [room, playerId]);
  const isHost = room?.hostId === playerId;
  const remainingSeconds = room?.endsAt ? Math.max(0, Math.ceil((new Date(room.endsAt).getTime() - now) / 1000)) : 0;
  const prepareSeconds = room?.preparingEndsAt ? Math.max(0, Math.ceil((new Date(room.preparingEndsAt).getTime() - now) / 1000)) : 0;
  const bombSeconds = room?.bomb?.explodesAt ? Math.max(0, Math.ceil((new Date(room.bomb.explodesAt).getTime() - now) / 1000)) : null;
  const nextRoundSeconds = room?.nextRoundAt ? Math.max(0, Math.ceil((room.nextRoundAt - now) / 1000)) : null;
  const defuseSecondsLeft = room?.bomb?.defusingUntil ? Math.max(0, Math.ceil((room.bomb.defusingUntil - now) / 1000)) : null;
  const reloadSecondsLeft = localPlayer?.reloadingUntil ? Math.max(0, (localPlayer.reloadingUntil - now) / 1000) : null;
  const alphaPlayers = room?.players.filter((player) => player.teamId === "alpha") ?? [];
  const bravoPlayers = room?.players.filter((player) => player.teamId === "bravo") ?? [];
  const teamScore = room?.teamScore ?? { alpha: 0, bravo: 0 };
  const alphaRole = alphaPlayers[0]?.role === "defender" ? "DEFEND" : "ATTACK";
  const bravoRole = bravoPlayers[0]?.role === "defender" ? "DEFEND" : "ATTACK";
  const activeScanTargets = scanTargets.filter((target) => new Date(target.expiresAt).getTime() > now);
  const roundClock = bombSeconds !== null ? formatCountdown(bombSeconds) : room?.status === "preparing" ? formatCountdown(prepareSeconds) : room?.status === "playing" ? formatCountdown(remainingSeconds) : "00:00";
  const matchOver = room?.status === "ended" && room.nextRoundAt === undefined;
  const localFpvDrone = useMemo(() => {
    if (!room?.fpvDrones || !playerId) return null;
    return room.fpvDrones.find((drone) => drone.ownerId === playerId && drone.state === "flying") ?? null;
  }, [room?.fpvDrones, playerId]);
  const resourceModelCount = runtimeModelAssetCount(resourcePack);
  const bombSite = map.config.bombSites?.find((site) => site.id === room?.bomb?.siteId) ?? null;
  const nearestSite = localPlayer && map.config.bombSites?.length
    ? [...map.config.bombSites].sort((a, b) => distance2d(localPlayer.position, a.center) - distance2d(localPlayer.position, b.center))[0]
    : null;
  const nearestSiteDistance = localPlayer && nearestSite ? distance2d(localPlayer.position, nearestSite.center) : null;
  const canUseDrone = isTacticalBomb ? localPlayer?.role === "attacker" : localPlayer?.role === "seeker";
  const localAlive = localPlayer ? alive(localPlayer) : false;
  const objectiveText = room?.status === "preparing"
    ? "准备阶段：检查出生点、路线和爆破点位置"
    : room?.status === "playing" && isTacticalBomb && localPlayer?.role === "attacker"
      ? localPlayer.hasBomb ? "携带炸弹进入 A/B 爆破点，按 E 安装炸弹" : "掩护炸弹携带者，清理防守方"
      : room?.status === "playing" && isTacticalBomb && localPlayer?.role === "defender"
        ? room.bomb?.plantedAt ? "靠近已安装炸弹，长按 E 拆除" : "守住 A/B 爆破点，阻止安装炸弹"
        : room?.status === "ended" && !matchOver
          ? "本回合结束，下一回合即将开始"
          : "等待房主开始游戏";

  const activateDrone = (ability: DroneAbility) => {
    if (!socket || !isConnected || room?.status !== "playing" || !canUseDrone || !localAlive) return;
    socket.emit("drone:activate", { ability });
  };
  const launchFpvDrone = () => {
    if (!socket || !isConnected || room?.status !== "playing" || !canUseDrone || !localAlive) return;
    if (localFpvDrone) {
      setRoundEvent("你已有一架飞行中的穿越机");
      return;
    }
    socket.emit("fpv:launch");
  };
  const moveFpvDrone = (droneId: string, position: Vec3, yaw: number) => {
    if (isConnected) socket?.emit("fpv:update", { droneId, position, yaw });
  };
  const detonateFpvDrone = () => {
    if (!socket || !isConnected || !localFpvDrone) return;
    socket.emit("fpv:detonate", { droneId: localFpvDrone.id });
  };
  const joinRoom = () => {
    if (!socket || !isConnected) return;
    const nextName = nameInput.trim() || "玩家";
    setPlayerName(nextName);
    playerNameRef.current = nextName;
    socket.emit("room:join", { roomId, name: nextName });
  };
  const startGame = () => socket?.emit("room:start");
  const restartMatch = () => socket?.emit("room:restart");
  const updatePosition = (position: Vec3, rotation: Vec3) => {
    if (isConnected) socket?.emit("player:update", { position, rotation });
  };
  const fireWeapon = () => {
    if (isConnected && isTacticalBomb && localAlive) socket?.emit("weapon:fire");
  };
  const reloadWeapon = () => {
    if (isConnected && isTacticalBomb && localAlive) socket?.emit("weapon:reload");
  };
  const useObjective = () => {
    if (!socket || !isConnected || !isTacticalBomb || room?.status !== "playing" || !localPlayer || !localAlive) return;
    if (localPlayer.role === "attacker" && localPlayer.hasBomb) {
      if (!nearestSite || nearestSiteDistance === null || nearestSiteDistance > nearestSite.radius) {
        setRoundEvent("需要站在 A/B 爆破点范围内才能安装炸弹");
        return;
      }
      socket.emit("bomb:plant", { siteId: nearestSite.id });
      return;
    }
    if (localPlayer.role === "defender" && room.bomb?.plantedAt) socket.emit("bomb:defuse");
  };
  const releaseObjective = () => {
    if (!socket || !isConnected || !isTacticalBomb || room?.status !== "playing") return;
    if (localPlayer?.role === "defender" && room.bomb?.plantedAt) socket.emit("bomb:defuse:cancel");
  };
  const copyInvite = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(inviteUrl);
      setCopiedInvite(true);
      window.setTimeout(() => setCopiedInvite(false), 1800);
    } catch {
      window.prompt("复制这条邀请链接发给队友", inviteUrl);
    }
  };

  return <div className="game-room-shell">
    <header className="game-room-header">
      <button className="icon-button" onClick={onExit} title="返回房间列表"><ArrowLeft size={19} /></button>
      <div><div className="panel-kicker">TACTICAL BOMB FPS</div><h2>{room?.name ?? `房间 ${roomId}`}</h2></div>
      <div className="game-room-code"><span>房间码</span><strong>{roomId}</strong><button className="icon-button" title="复制邀请链接" onClick={copyInvite}>{copiedInvite ? <CheckCircle2 size={16} /> : <Copy size={16} />}</button></div>
      <button className="secondary-button" onClick={onExit}><LogOut size={16} />退出</button>
    </header>

    {!room?.players.some((player) => player.id === playerId) ? <section className="join-panel">
      <Gamepad2 size={32} /><h3>加入战术爆破房间</h3><p>{message}</p><div className="join-form"><input value={nameInput} onChange={(event) => setNameInput(event.target.value)} onKeyDown={(event) => event.key === "Enter" && joinRoom()} placeholder="输入你的昵称" maxLength={16} /><button className="primary-button" onClick={joinRoom} disabled={!isConnected}>加入房间</button></div>
    </section> : <>
      <div className="game-room-statusbar">
        <span className="connection-row"><span className={`status-dot${isConnected ? " online" : ""}`} />{message}</span>
        <span><Users size={15} /> {room.players.length} / {map.config.rules.maxPlayers}</span>
        {room.status === "preparing" ? <span className="game-timer preparing"><Clock3 size={15} /> 准备 {formatCountdown(prepareSeconds)}</span> : null}
        {room.status === "playing" ? <span className="game-timer"><Clock3 size={15} /> {bombSeconds !== null ? `炸弹 ${formatCountdown(bombSeconds)}` : formatCountdown(remainingSeconds)}</span> : null}
      </div>
      <div className="game-room-layout">
        <section className="game-canvas-panel"><GameScene config={map.config} players={room.players} localPlayerId={playerId} onMove={updatePosition} onFire={fireWeapon} onUse={useObjective} onUseRelease={releaseObjective} onReload={reloadWeapon} onFpvLaunch={launchFpvDrone} onFpvMove={moveFpvDrone} onFpvDetonate={detonateFpvDrone} canMove={isConnected && room.status === "playing" && localAlive} modelUrl={map.modelUrl} resourcePack={resourcePack} scanTargets={activeScanTargets} bomb={room.bomb ?? null} droppedBomb={room.droppedBomb ?? null} fpvDrones={room.fpvDrones ?? []} localFpvDroneId={localFpvDrone?.id ?? null} positionCorrection={positionCorrection} onPositionCorrectionApplied={() => setPositionCorrection(null)} /><div className="fps-hud-top"><div className="team-pill seeker-team">ALPHA · {alphaRole} <strong>{alphaPlayers.filter(alive).length}/{alphaPlayers.length}</strong></div><div className="round-center"><span>{localFpvDrone ? "FPV DRONE · E 引爆" : bombSeconds !== null ? "BOMB PLANTED" : statusLabel(room.status)}</span><strong>{roundClock}</strong><small>{room.roundNumber ? `第 ${room.roundNumber} 回合 · ${bombSite?.name ?? map.name}` : bombSite?.name ?? map.name}</small></div><div className="team-pill hider-team">BRAVO · {bravoRole} <strong>{bravoPlayers.filter(alive).length}/{bravoPlayers.length}</strong></div></div>{room.teamScore ? <div className="round-score-bar"><span className={room.roundWinnerTeamId === "alpha" ? "leading" : ""}>ALPHA {teamScore.alpha}</span><Swords size={14} /><span>{room.roundsToWin ? `FT${room.roundsToWin}` : ""}</span><Swords size={14} /><span className={room.roundWinnerTeamId === "bravo" ? "leading" : ""}>{teamScore.bravo} BRAVO</span></div> : null}<div className="fps-hud-bottom"><div><span>HP</span><strong>{Math.max(0, localPlayer?.health ?? 100)}</strong></div><div><span>ARMOR</span><strong>{localPlayer?.armor ?? 0}</strong></div><div><span>AMMO</span><strong>{reloadSecondsLeft !== null && reloadSecondsLeft > 0 ? "RELOADING" : `${localPlayer?.ammo ?? 0}/${localPlayer?.reserveAmmo ?? 0}`}</strong></div><div><span>USE</span><strong>{localFpvDrone ? "DETONATE" : localPlayer?.hasBomb ? "BOMB" : room.bomb?.plantedAt && localPlayer?.role === "defender" ? "DEFUSE" : "E"}</strong></div></div>{reloadSecondsLeft !== null && reloadSecondsLeft > 0 ? <div className="action-progress-bar reload"><span>换弹中 {(reloadSecondsLeft / 2.2 * 100).toFixed(0)}%</span><div style={{ width: `${Math.max(0, Math.min(100, (1 - reloadSecondsLeft / 2.2) * 100))}%` }} /></div> : null}{defuseSecondsLeft !== null ? <div className="action-progress-bar defuse"><span>拆弹中 {defuseSecondsLeft.toFixed(1)}s</span><div style={{ width: `${Math.max(0, Math.min(100, (1 - defuseSecondsLeft / 5) * 100))}%` }} /></div> : null}{nextRoundSeconds !== null && room.status === "ended" ? <div className="round-interlude"><strong>下一回合 {nextRoundSeconds}s</strong><span>双方阵容将在新回合互换攻防</span></div> : null}{roundEvent ? <div className="round-event-toast"><Crosshair size={16} />{roundEvent}</div> : null}<div className="game-help">{objectiveText}</div></section>
        <aside className="game-side-panel">
          <div className="game-role-card"><span>你的队伍</span><strong className={`role-${localPlayer?.role ?? "spectator"}`}>{localPlayer?.teamId ? `${localPlayer.teamId.toUpperCase()} · ${roleLabel(localPlayer.role)}` : roleLabel(localPlayer?.role ?? "spectator")}</strong>{room.status === "waiting" ? <small>开始后自动分配 Alpha / Bravo，并每两局交换攻防。</small> : null}</div>
          {(room.status === "preparing" || room.status === "playing") ? <div className="game-objective-card"><div className="side-title"><Target size={16} />当前目标</div><strong>{localPlayer?.role === "attacker" ? "进攻爆破点" : localPlayer?.role === "defender" ? "防守并拆包" : "观战"}</strong><span>{objectiveText}</span>{nearestSiteDistance !== null && nearestSite ? <small>最近爆破点 {nearestSite.name} · {nearestSiteDistance.toFixed(1)} 米</small> : null}{!localAlive && room.status === "playing" ? <small className="danger-text">你已出局，等待回合结束</small> : null}</div> : null}
          <div className="game-loadout-card"><div className="side-title"><Shield size={16} />装备</div><div className="loadout-row"><span>主武器</span><strong>{localPlayer?.weaponId === "rifle" ? "训练步枪" : localPlayer?.weaponId ?? "待分配"}</strong></div><div className="loadout-row"><span>生命 / 护甲</span><strong>{localPlayer?.health ?? 100} / {localPlayer?.armor ?? 0}</strong></div><div className="loadout-row"><span>弹药</span><strong>{localPlayer?.ammo ?? 0} / {localPlayer?.reserveAmmo ?? 0}</strong></div><div className="loadout-row"><span>炸弹</span><strong>{localPlayer?.hasBomb ? "携带中" : room.bomb?.plantedAt ? "已安装" : "未携带"}</strong></div></div>
          <div className="game-loadout-card"><div className="side-title"><Rocket size={16} />无人机支援</div><div className="loadout-row"><span>侦察机</span><strong>{localPlayer?.droneLoadout?.recon ?? 0} 次</strong></div><button className="drone-action-button recon" disabled={room.status !== "playing" || !canUseDrone || !localAlive || (localPlayer?.droneLoadout?.recon ?? 0) <= 0} onClick={() => activateDrone("recon")}><Target size={15} />启动侦察机<span>8 秒标记附近目标</span></button><div className="loadout-row"><span>自爆穿越机</span><strong>{localPlayer?.droneLoadout?.fpv ?? 0} 次</strong></div>{localFpvDrone ? <button className="drone-action-button fpv active" onClick={detonateFpvDrone}><Rocket size={15} />引爆穿越机 (E)<span>第一人称飞行中 · 空格不可用 · 左键/E 引爆</span></button> : <button className="drone-action-button fpv" disabled={room.status !== "playing" || !canUseDrone || !localAlive || (localPlayer?.droneLoadout?.fpv ?? 0) <= 0} onClick={launchFpvDrone}><Rocket size={15} />释放自爆穿越机 (Q)<span>7 米范围伤害 · 可被击落 · 16 秒燃料</span></button>}{!canUseDrone ? <small className="drone-disabled-note">当前原型由进攻方使用无人机支援</small> : null}</div>
          {activeScanTargets.length > 0 ? <div className="game-resource-card drone-scan-card"><div className="side-title"><Target size={16} />侦察标记</div><strong>发现 {activeScanTargets.length} 名目标</strong>{activeScanTargets.map((target) => <span key={target.id}>{target.name} · 已在场景中标记</span>)}</div> : null}
          <div className="game-resource-card"><div className="side-title"><PackageCheck size={16} />游戏资源</div><strong>{resourcePack?.name ?? "默认几何资源"}</strong><span>{resourceModelCount > 0 ? `已接入 ${resourceModelCount} 个角色模型` : "当前使用默认角色回退"}</span></div>
          {room.status === "waiting" ? <div className="game-waiting"><Radio size={20} /><strong>等待开始</strong><span>当前已有 {room.players.length} 名玩家</span>{isHost ? <button className="primary-button" onClick={startGame} disabled={room.players.length < 2}><Play size={16} />{room.players.length < 2 ? "等待第二名玩家" : `开始 ${map.config.rules.prepareTime} 秒准备`}</button> : <small>等待房主开始游戏</small>}</div> : null}
          {room.status === "preparing" ? <div className="game-waiting preparing-card"><Clock3 size={20} /><strong>准备倒计时 {formatCountdown(prepareSeconds)}</strong><span>队伍已分配；倒计时结束后由服务端统一开启正式回合。</span></div> : null}
          {(room.status === "preparing" || room.status === "playing" || room.status === "ended") ? <div className="game-player-list"><div className="side-title"><Users size={16} />玩家状态</div>{room.players.map((player) => <div className="game-player-row" key={player.id}><span className={`player-dot role-${player.role}`} /><div><strong>{player.name}{player.id === playerId ? "（我）" : ""}</strong><small>{player.teamId ? `${player.teamId.toUpperCase()} · ` : ""}{alive(player) ? roleLabel(player.role) : "已出局"} · K/D {player.kills ?? 0}/{player.deaths ?? 0}</small></div></div>)}</div> : null}
          {room.status === "ended" ? <div className="game-result"><ShieldCheck size={22} /><strong>{room.matchWinnerTeamId ? `${room.matchWinnerTeamId.toUpperCase()} 获胜` : room.resultMessage ?? "本回合结束"}</strong><span>{resultLabel(room, localPlayer)}</span>{matchOver && isHost ? <button className="primary-button" onClick={restartMatch} disabled={room.players.length < 2}><Play size={16} />再开一场</button> : null}<button className="secondary-button" onClick={onExit}>返回房间列表</button></div> : null}
        </aside>
      </div>
      <div className="game-player-name">当前玩家：{playerName || localPlayer?.name}</div>
    </>}
  </div>;
}
