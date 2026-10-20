import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { addPlayer, beginGame, cancelPreparation, completeDefuse, completeReload, createRoom, finishRound, getMap, pickupDroppedBomb, plantBomb, prepareGame, reloadWeapon, removePlayer, startDefuse, startNextRound, updatePlayer } from "./store.ts";
import type { PlayerState } from "../../shared/types.ts";

function fixture() {
  const room = createRoom("Regression", "warehouse-fortress");
  for (let index = 0; index < 4; index += 1) {
    addPlayer(room.id, { id: randomUUID(), name: `Player ${index}`, role: "spectator", position: [0, 1.7, 0], rotation: [0, 0, 0], caught: false });
  }
  prepareGame(room.id);
  beginGame(room.id);
  const attackers = room.players.filter((player) => player.role === "attacker");
  const defenders = room.players.filter((player) => player.role === "defender");
  return { room, attackers, defenders };
}

function atTime<T>(timestamp: number, action: () => T): T {
  const original = Date.now;
  Date.now = () => timestamp;
  try { return action(); } finally { Date.now = original; }
}

function plantedFixture() {
  const state = fixture();
  const site = getMap(state.room.mapId)!.config.bombSites![0];
  const position: PlayerState["position"] = [site.center[0], 1.7, site.center[2]];
  updatePlayer(state.room.id, state.attackers[0].id, { position });
  assert.ok(plantBomb(state.room.id, state.attackers[0].id, site.id));
  for (const player of state.defenders) updatePlayer(state.room.id, player.id, { position });
  return state;
}

test("reload transfers rounds once and conserves total ammunition", () => {
  const { room, attackers } = fixture();
  const id = attackers[0].id;
  updatePlayer(room.id, id, { ammo: 5, reserveAmmo: 90 });
  const reload = reloadWeapon(room.id, id)!;
  assert.ok(reload);
  assert.equal(room.players.find((p) => p.id === id)!.reserveAmmo, 90);
  assert.equal(completeReload(room.id, id), undefined);
  atTime(reload.reloadUntil, () => assert.ok(completeReload(room.id, id)));
  const player = room.players.find((p) => p.id === id)!;
  assert.equal(player.ammo, 30);
  assert.equal(player.reserveAmmo, 65);
  assert.equal(completeReload(room.id, id), undefined);
});

test("reload uses the last reserve rounds without losing them", () => {
  const { room, attackers } = fixture();
  const id = attackers[0].id;
  updatePlayer(room.id, id, { ammo: 4, reserveAmmo: 7 });
  const reload = reloadWeapon(room.id, id)!;
  atTime(reload.reloadUntil, () => completeReload(room.id, id));
  assert.equal(room.players.find((p) => p.id === id)!.ammo, 11);
  assert.equal(room.players.find((p) => p.id === id)!.reserveAmmo, 0);
});

test("death prevents delayed reload completion", () => {
  const { room, attackers } = fixture();
  const id = attackers[0].id;
  updatePlayer(room.id, id, { ammo: 0 });
  const reload = reloadWeapon(room.id, id)!;
  updatePlayer(room.id, id, { health: 0 });
  atTime(reload.reloadUntil, () => assert.equal(completeReload(room.id, id), undefined));
  assert.equal(room.players.find((p) => p.id === id)!.ammo, 0);
});

test("next round clears reload state and restores equipment", () => {
  const { room, attackers } = fixture();
  const id = attackers[0].id;
  updatePlayer(room.id, id, { ammo: 0 });
  reloadWeapon(room.id, id);
  finishRound(room.id, "defender", "time-expired", "Round ended");
  assert.equal(completeReload(room.id, id), undefined);
  assert.ok(startNextRound(room.id));
  beginGame(room.id);
  const player = room.players.find((p) => p.id === id)!;
  assert.equal(player.reloadingUntil, undefined);
  assert.equal(player.ammo, 30);
  updatePlayer(room.id, id, { ammo: 29 });
  assert.ok(reloadWeapon(room.id, id), "previous round reload timer must not block this round");
});

test("leaving carrier drops a bomb that another attacker can pick up", () => {
  const { room, attackers } = fixture();
  const carrier = attackers[0];
  removePlayer(room.id, carrier.id);
  assert.deepEqual(room.droppedBomb?.position, carrier.position);
  assert.equal(room.bomb?.carrierId, undefined);
  updatePlayer(room.id, attackers[1].id, { position: [...carrier.position] });
  assert.ok(pickupDroppedBomb(room.id));
  assert.equal(room.bomb?.carrierId, attackers[1].id);
  assert.equal(room.droppedBomb, undefined);
});

test("another defender cannot take over an active defuse", () => {
  const { room, defenders } = plantedFixture();
  const started = startDefuse(room.id, defenders[0].id)!;
  assert.equal(startDefuse(room.id, defenders[1].id), undefined);
  assert.equal(room.bomb?.defuserId, defenders[0].id);
  atTime(started.defusingUntil - 1, () => assert.equal(completeDefuse(room.id), undefined));
  atTime(started.defusingUntil, () => assert.ok(completeDefuse(room.id)));
});

test("a departed defuser cannot complete a defuse", () => {
  const { room, defenders } = plantedFixture();
  const started = startDefuse(room.id, defenders[0].id)!;
  removePlayer(room.id, defenders[0].id);
  assert.equal(room.bomb?.defusingUntil, undefined);
  atTime(started.defusingUntil, () => assert.equal(completeDefuse(room.id), undefined));
  assert.ok(room.bomb?.plantedAt);
  assert.ok(startDefuse(room.id, defenders[1].id));
});

test("defuse validates life, range and explosion deadline at completion", () => {
  for (const scenario of ["dead", "distant", "expired"] as const) {
    const { room, defenders } = plantedFixture();
    const started = startDefuse(room.id, defenders[0].id)!;
    if (scenario === "dead") updatePlayer(room.id, defenders[0].id, { health: 0 });
    if (scenario === "distant") updatePlayer(room.id, defenders[0].id, { position: [40, 1.7, 35] });
    if (scenario === "expired") room.bomb!.explodesAt = new Date(started.defusingUntil).toISOString();
    atTime(started.defusingUntil, () => assert.equal(completeDefuse(room.id), undefined, scenario));
    assert.ok(room.bomb?.plantedAt);
    assert.equal(room.bomb?.defusingUntil, undefined);
  }
});

test("an ended room can return to waiting after players leave", () => {
  const { room } = fixture();
  finishRound(room.id, "attacker", "defenders-eliminated", "Done");
  assert.ok(cancelPreparation(room.id));
  assert.equal(room.status, "waiting");
  assert.equal(room.nextRoundAt, undefined);
  assert.equal(room.bomb, undefined);
  assert.equal(room.score, undefined);
});
