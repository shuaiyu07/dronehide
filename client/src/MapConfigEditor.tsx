import { Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import type { MapConfig, SpawnPoint, Vec3, ZoneConfig } from "../../shared/types.ts";

type Props = {
  config: MapConfig;
  onSave: (config: MapConfig) => Promise<void>;
  onCancel: () => void;
};

function numberValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function vectorFields(label: string, value: Vec3, onChange: (next: Vec3) => void) {
  return (
    <div className="vector-fields">
      <span>{label}</span>
      {(["x", "y", "z"] as const).map((axis, index) => (
        <label key={axis}>
          {axis.toUpperCase()}
          <input type="number" step="0.1" value={value[index]} onChange={(event) => {
            const next = [...value] as Vec3;
            next[index] = numberValue(event.target.value);
            onChange(next);
          }} />
        </label>
      ))}
    </div>
  );
}

function cloneConfig(config: MapConfig): MapConfig {
  return structuredClone(config);
}

export default function MapConfigEditor({ config, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState(() => cloneConfig(config));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const updateSpawn = (id: string, patch: Partial<SpawnPoint>) => {
    setDraft((current) => ({
      ...current,
      spawnPoints: current.spawnPoints.map((point) => point.id === id ? { ...point, ...patch } : point),
    }));
  };

  const updateZone = (id: string, patch: Partial<ZoneConfig>) => {
    setDraft((current) => ({
      ...current,
      zones: current.zones.map((zone) => zone.id === id ? { ...zone, ...patch } : zone),
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave(draft);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存配置失败");
    } finally {
      setSaving(false);
    }
  };

  const addSpawnPoint = (role: SpawnPoint["role"]) => {
    const index = draft.spawnPoints.length + 1;
    const point: SpawnPoint = {
      id: `${role}-start-${index}`,
      role,
      position: [0, 1.7, 0],
      rotation: [0, 0, 0],
    };
    setDraft((current) => ({ ...current, spawnPoints: [...current.spawnPoints, point] }));
  };

  const addZone = () => {
    const index = draft.zones.length + 1;
    const zone: ZoneConfig = { id: `zone-${index}`, name: `新区域 ${index}`, center: [0, 0, 0], radius: 5, kind: "hide" };
    setDraft((current) => ({ ...current, zones: [...current.zones, zone] }));
  };

  const tactical = draft.gameMode === "tactical-bomb";
  const roleOptions: Array<{ value: SpawnPoint["role"]; label: string }> = tactical
    ? [{ value: "attacker", label: "进攻方" }, { value: "defender", label: "防守方" }]
    : [{ value: "seeker", label: "寻找者" }, { value: "hider", label: "躲藏者" }];

  return (
    <section className="workspace-panel config-editor form-panel">
      <div className="form-heading">
        <div><div className="panel-kicker">MAP CONFIGURATION</div><h3>编辑地图与游戏规则</h3></div>
        <span className="form-hint">保存后写入服务端 JSON，重启不会丢失</span>
      </div>

      <div className="editor-section">
        <div className="editor-section-heading"><div><strong>游戏规则</strong><span>决定房间和抓捕判定的基础参数</span></div></div>
        <div className="form-grid compact-grid">
          <label>准备时间（秒）<input type="number" min="5" max="600" value={draft.rules.prepareTime} onChange={(event) => setDraft({ ...draft, rules: { ...draft.rules, prepareTime: numberValue(event.target.value) } })} /></label>
          <label>游戏时长（秒）<input type="number" min="30" max="3600" value={draft.rules.gameTime} onChange={(event) => setDraft({ ...draft, rules: { ...draft.rules, gameTime: numberValue(event.target.value) } })} /></label>
          <label>抓捕距离（米）<input type="number" min="0.5" max="20" step="0.1" value={draft.rules.catchDistance} onChange={(event) => setDraft({ ...draft, rules: { ...draft.rules, catchDistance: numberValue(event.target.value) } })} /></label>
          <label>最大玩家数<input type="number" min="2" max="32" value={draft.rules.maxPlayers} onChange={(event) => setDraft({ ...draft, rules: { ...draft.rules, maxPlayers: numberValue(event.target.value) } })} /></label>
          {tactical ? <><label>胜利所需回合<input type="number" min="1" max="15" value={draft.rules.roundsToWin ?? 1} onChange={(event) => setDraft({ ...draft, rules: { ...draft.rules, roundsToWin: numberValue(event.target.value) } })} /></label><label>炸弹倒计时（秒）<input type="number" min="10" max="180" value={draft.rules.bombTime ?? 40} onChange={(event) => setDraft({ ...draft, rules: { ...draft.rules, bombTime: numberValue(event.target.value) } })} /></label></> : null}
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-heading"><div><strong>地图边界</strong><span>玩家移动会被服务端限制在这个长方体范围内</span></div></div>
        <div className="vector-grid">
          {vectorFields("最小坐标", draft.bounds.min, (min) => setDraft({ ...draft, bounds: { ...draft.bounds, min } }))}
          {vectorFields("最大坐标", draft.bounds.max, (max) => setDraft({ ...draft, bounds: { ...draft.bounds, max } }))}
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-heading"><div><strong>出生点</strong><span>至少保留一个{tactical ? "进攻方" : "寻找者"}和一个{tactical ? "防守方" : "躲藏者"}出生点</span></div><div className="editor-actions">{roleOptions.map((option) => <button className="secondary-button" type="button" key={option.value} onClick={() => addSpawnPoint(option.value)}><Plus size={15} />{option.label}出生点</button>)}</div></div>
        <div className="editor-list">
          {draft.spawnPoints.map((point) => <div className="editor-row" key={point.id}>
            <div className="editor-row-head"><strong>{roleOptions.find((option) => option.value === point.role)?.label ?? point.role}</strong><button className="icon-button" type="button" title="删除出生点" disabled={draft.spawnPoints.length <= 2} onClick={() => setDraft({ ...draft, spawnPoints: draft.spawnPoints.filter((item) => item.id !== point.id) })}><Trash2 size={15} /></button></div>
            <div className="form-grid compact-grid">
              <label>出生点 ID<input value={point.id} onChange={(event) => updateSpawn(point.id, { id: event.target.value })} /></label>
              <label>角色<select value={point.role} onChange={(event) => updateSpawn(point.id, { role: event.target.value as SpawnPoint["role"] })}>{roleOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
              {vectorFields("位置", point.position, (position) => updateSpawn(point.id, { position }))}
              {vectorFields("旋转", point.rotation, (rotation) => updateSpawn(point.id, { rotation }))}
            </div>
          </div>)}
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-heading"><div><strong>游戏区域</strong><span>躲藏区、禁区和安全区会显示在三维预览与游戏场景中</span></div><button className="secondary-button" type="button" onClick={addZone}><Plus size={15} />新增区域</button></div>
        <div className="editor-list">
          {draft.zones.map((zone) => <div className="editor-row" key={zone.id}>
            <div className="editor-row-head"><strong>{zone.name}</strong><button className="icon-button" type="button" title="删除区域" onClick={() => setDraft({ ...draft, zones: draft.zones.filter((item) => item.id !== zone.id) })}><Trash2 size={15} /></button></div>
            <div className="form-grid compact-grid">
              <label>区域 ID<input value={zone.id} onChange={(event) => updateZone(zone.id, { id: event.target.value })} /></label>
              <label>名称<input value={zone.name} onChange={(event) => updateZone(zone.id, { name: event.target.value })} /></label>
              <label>类型<select value={zone.kind} onChange={(event) => updateZone(zone.id, { kind: event.target.value as ZoneConfig["kind"] })}><option value="hide">躲藏区</option><option value="forbidden">禁区</option><option value="safe">安全区</option></select></label>
              <label>半径（米）<input type="number" min="0.1" step="0.1" value={zone.radius} onChange={(event) => updateZone(zone.id, { radius: numberValue(event.target.value) })} /></label>
              {vectorFields("中心点", zone.center, (center) => updateZone(zone.id, { center }))}
            </div>
          </div>)}
          {draft.zones.length === 0 ? <div className="editor-empty">还没有配置游戏区域，可以新增躲藏区或禁区。</div> : null}
        </div>
      </div>

      {error ? <div className="editor-error">{error}</div> : null}
      <div className="form-actions"><span>配置完成后，新的房间会使用这些出生点、边界和规则。</span><div className="editor-actions"><button className="secondary-button" type="button" onClick={onCancel}>取消</button><button className="primary-button" type="button" disabled={saving} onClick={handleSave}><Save size={16} />{saving ? "保存中..." : "保存配置"}</button></div></div>
    </section>
  );
}
