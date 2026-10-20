# Drone Hide 资源接入规范

平台保留两个稳定的资源接入口：地图包和游戏资源包。

原则是“来源格式可以扩展，浏览器运行格式保持稳定”：OBJ、FBX、PLY、LAS、PNG、WAV 等原始资源可以登记在 `sourceFormats` 或资源项的 `sourceFormat` 中；网页当前直接加载的三维场景统一使用 `GLB / glTF`，其他格式先由资源制作流程转换后再接入。

## 地图包

地图管理页的“导入地图包”需要上传：

- `manifest.json`
- manifest 中 `scene.path` 指定的场景文件
- 可选的 `collision.path` 碰撞文件
- 可选的 `thumbnail.path` 缩略图

示例：

```json
{
  "kind": "map",
  "schemaVersion": "1.0",
  "id": "harbour-square",
  "name": "港口广场",
  "version": "1.0.0",
  "author": "地图组",
  "license": "CC0 1.0 Universal",
  "description": "用于联机捉迷藏的港口广场三维地图",
  "sourceUrl": "https://example.com/source",
  "sourceFormats": ["drone-photogrammetry", "obj", "ply"],
  "runtimeFormat": "glb",
  "scene": { "path": "scene.glb", "format": "glb" },
  "collision": { "path": "collision.glb", "format": "glb" },
  "thumbnail": { "path": "thumbnail.png", "format": "png" },
  "provenanceType": "drone-sdk",
  "missionId": "mission-example"
}
```

`config` 可以放在清单中，用于预置出生点、区域、边界和规则；不填写时平台使用默认配置，之后可以在地图管理页编辑。

## 游戏资源包

游戏资源页的“导入资源包”需要上传：

- `manifest.json`
- `assets` 数组中 `path` 指定的资源文件

示例：

```json
{
  "kind": "game-resources",
  "schemaVersion": "1.0",
  "id": "classroom-cs-style-pack",
  "name": "课堂演示角色包",
  "version": "1.0.0",
  "author": "资源组",
  "license": "CC BY 4.0",
  "description": "可替换寻找者、躲藏者和界面音效的演示资源包",
  "sourceFormats": ["fbx", "wav", "png"],
  "runtimeFormats": ["glb", "audio", "image"],
  "assets": [
    {
      "id": "seeker-model",
      "label": "寻找者角色",
      "kind": "character",
      "path": "seeker.glb",
      "format": "glb",
      "sourceFormat": "fbx",
      "tags": ["player", "seeker"],
      "fallback": false
    },
    {
      "id": "round-start-sound",
      "label": "回合开始音效",
      "kind": "sound",
      "path": "round-start.ogg",
      "format": "audio",
      "sourceFormat": "wav",
      "fallback": false
    },
    {
      "id": "recon-drone",
      "label": "侦察机",
      "kind": "prop",
      "path": "recon-drone.glb",
      "format": "glb",
      "sourceFormat": "fbx",
      "tags": ["drone", "recon", "uav"],
      "fallback": false
    },
    {
      "id": "fpv-suicide-drone",
      "label": "自爆穿越机",
      "kind": "prop",
      "path": "fpv-suicide-drone.glb",
      "format": "glb",
      "sourceFormat": "blend",
      "tags": ["drone", "fpv", "suicide"],
      "fallback": false
    }
  ]
}
```

当前网页运行时优先识别 `glb / gltf` 模型、图片和音频；无法直接加载的资源仍会被正确登记，并继续使用内置回退资源。后续可以增加格式转换器，而不需要修改房间、同步、角色分配和结算逻辑。

资源项使用 `drone + recon` 或 `drone + fpv` 标签即可被资源组和平台识别为无人机资源。当前无人机玩法的规则身份由房间服务端维护，模型、音效和特效属于可替换表现层。

## 校验规则

- `id` 只能使用字母、数字、点、下划线和短横线。
- `schemaVersion` 当前必须是 `1.0`。
- 地图和资源包必须填写作者、版本、说明和许可证。
- 文件路径只按文件名匹配，不能通过路径穿越写入上传目录外部。
- 不允许资源包上传或执行任意 JavaScript。
- 地图包来源为无人机 SDK 时，必须关联状态为“模型已生成”的采集任务。
