---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'c8785096-298a-4970-95ab-1a3dc004ecd1'
  PropagateID: 'c8785096-298a-4970-95ab-1a3dc004ecd1'
  ReservedCode1: '0ae15943-12fd-4d2f-b258-e572b0722c72'
  ReservedCode2: '0ae15943-12fd-4d2f-b258-e572b0722c72'
---

# Drone Hide 当前开发交接说明

更新时间：2026-10-13

2026-10-15 补充：代码已新增仓储要塞、多回合、炸弹掉落拾取、可飞行 FPV 和换弹/拆弹延迟，下面部分“未完成事项”已过时。请先阅读 `DEVELOPMENT_UPDATE_2026-10-15.md`，其中记录最新修复、回归测试和剩余限制，再以源码为准。

这份文档以当前工作区源码为准，优先级高于仍保留的旧版 `TEAM_HANDOFF.md`。旧版文档主要描述“躲猫猫”阶段；当前项目已经转向“类似 CSGO 的网页战术爆破原型”，但仍保留旧模式的兼容代码。

## 1. 先看结论

项目没有从头搭建，也没有删除原有工程。当前已经有一个可运行的网页联机战术爆破原型：

- 前端：`http://localhost:5180/`
- 后端健康检查：`http://localhost:3001/api/health`
- 当前检查结果：前端 HTTP 200，后端 HTTP 200。
- `npm run typecheck` 已通过。
- `npm run check` 此前已通过；Windows 某些环境可能因为 Vite 临时目录权限报 `EPERM`，需要在获得权限后重试，不要删除依赖目录。
- 当前仓库分支名为 `master`，但仓库还没有任何 commit；大量成果是工作区现有改动，不能 reset、clean、checkout 覆盖或删除。
- 实际项目根目录是 `D:\DroneHidePlatform`，不是 `D:\web游戏平台`。

## 2. 当前产品方向

老师希望项目做成类似 CSGO 的网页版多人游戏。当前采用的实现目标是：

1. 多人房间和实时位置同步。
2. 进攻方 / 防守方战术爆破模式。
3. 枪械、护甲、弹药、炸弹、投掷物和无人机的可扩展资源接口。
4. 地图资源和游戏资源各保留一个导入入口。
5. 地图和资源可以由资源组后续提供，平台通过清单识别；浏览器运行时优先使用 GLB/glTF、图片、音频等网页友好格式。
6. 不使用官方 CS:GO/Dust2 资产。地图必须是项目自有、明确开源许可证或获得授权的资源。

当前仍是课堂项目原型，不是完整商业级 CSGO：没有完整物理碰撞、买枪系统、完整多回合计分、反作弊、持久化账号和固定公网部署。

## 3. 已完成的功能

### 3.1 原有平台基础

- React + Vite 前端。
- Express + Socket.IO 后端。
- Three.js 三维场景。
- 地图列表、GLB 地图上传、地图预览和来源/许可证记录。
- 地图配置保存：出生点、区域、边界、游戏规则。
- 创建房间、房间码加入、房主开始、房间状态同步。
- 原有躲猫猫模式仍保留，旧校园程序化测试地图仍可用。
- 无人机 SDK 当前是模拟桥接层，只登记采集任务和建模成果，不直接控制真机。

### 3.2 战术爆破模式（多回合已实现）

已在 `shared/types.ts`、`server/src/store.ts`、`server/src/index.ts`、`client/src/GameRoom.tsx` 和 `client/src/GameScene.tsx` 中接入：

- `GameMode` 增加 `tactical-bomb`。
- 角色增加 `attacker` 和 `defender`。
- 地图可配置进攻方 / 防守方出生点。
- 地图可配置 A/B 爆破点及半径。
- 玩家状态增加生命值、护甲、当前弹匣、备用弹药、武器 ID、击杀数、死亡数、是否持有炸弹。
- 房间状态增加回合号、比分（attackerWins/defenderWins）、炸弹状态、掉落炸弹、killfeed。
- 进攻方、防守方自动分配和出生。
- 基础开火与服务端命中判定（弹道/墙壁遮挡/伤害计算，护甲吸收 40%）。
- 换弹（服务端定时器 2.2 秒回填）。
- 进攻方在爆破点安装炸弹（40 秒倒计时）。
- 防守方拆除炸弹（长按 E 5 秒，移动/死亡/松开中断）。
- 炸弹倒计时和爆炸判定。
- **多回合系统（2026-10-13 完成）**：BO5（roundsToWin=3），回合结束 → 6 秒回合间隔 → 下一回合自动开始，每 2 回合攻防互换；赛点判定用 `room.nextRoundAt === undefined` 表示全场结束；比分栏、回合间隔倒计时、killfeed（近 6 条）已在 UI 展示。
- **炸弹掉落与拾取（2026-10-13 完成）**：携带者死亡炸弹掉落，其他进攻方走近 2.2 米自动拾取。
- 基础友军识别 / 角色判定逻辑已经放在服务端，不以浏览器自行判定结果为准。
- E 键执行安装/拆弹目标操作，R 键换弹，鼠标左键开火。
- 爆破点在三维场景中有标记；已安装炸弹（闪烁红灯）/掉落炸弹（旋转光环）有独立模型。
- 死亡的战术玩家会隐藏。

### 3.3 无人机玩法（FPV 第一人称飞行已实现）

- 侦察机：消耗进攻方的 recon 次数（每回合 2 次），服务端产生防守方短时侦察目标（8 秒标记）。
- 自爆穿越机（2026-10-13 完成 FPV 第一人称）：
  - Q 键释放（每回合 1 次），WASD+Shift升/Ctrl降飞行（速度 14，升降 8，最低 0.6 米），
  - E 键/左键引爆（7 米范围伤害，伤害 120），
  - 起飞保护 5.4 秒（armedAt，防落地即炸），燃料 16 秒自动回收，
  - 可被敌方枪械击落（射击 miss 时自动尝试命中敌方穿越机），
  - 客户端检测穿越机消失生成爆炸扩散球特效（0.8 秒，半径 7）。
- 无人机数量在玩家 loadout 中维护，每回合重置。
- 无人机模型、特效属于可替换表现资源；核心规则由服务端维护。

### 3.4 当前可用地图

主推两张战术地图：

1. **仓储要塞 warehouse-fortress（2026-10-13 新增，当前默认）**：纯程序化生成，零磁盘占用。
   - 定义在 `shared/warehouseMap.ts`（约 50 个 AABB 障碍：仓库货架阵、中央集装箱迷宫、双层高箱、两条地下管道、瞭望塔）。
   - 碰撞几何与视觉几何完全同源：同一个 Box 列表既在服务端做 hitscan/移动碰撞，也在客户端生成 Three.js 网格，天然防穿墙。
   - BO5（roundsToWin=3），准备 15 秒，炸弹 40 秒。
   - App.tsx 默认选中优先级：procedural tactical-bomb configured > 其他 configured。
2. 港口广场 GLB：

```text
D:\DroneHidePlatform\uploads\maps\harbour-square-payload-v1.0.0.glb
```

大小约 2.4 MB。地图登记在 `server/data/maps.json`，ID 为 `map-30820c43`，运行模式为 `tactical-bomb`。来源信息记录为 3DAssets.dev 的 CC0 资源，代码中没有使用官方 CS:GO/Dust2 资产。

两张图配置均包含：进攻方/防守方出生点、A/B 爆破点、地图边界、预备时间、游戏时间、炸弹引爆时间、人数上限。

### 3.5 地图和游戏资源扩展口

主要文档是 `PACKAGE_FORMATS.md`。

地图资源入口：

- `POST /api/maps/import`：上传单个 GLB。
- `POST /api/maps/import-package`：上传 `manifest.json` 和地图包文件。
- `POST /api/maps/local`：登记项目已有的本地地图文件。
- `POST /api/maps/remote`：登记 HTTPS 远程 GLB，不下载到本机。
- `PUT /api/maps/:mapId/config`：保存地图配置。

游戏资源入口：

- `GET /api/resource-packs`：列出资源包。
- `POST /api/resource-packs/import`：上传资源包清单和资源文件。

资源包当前只允许清单和静态资源，不允许上传或执行任意 JavaScript。格式设计允许资源组登记 FBX、OBJ、PLY、WAV 等来源格式，但浏览器运行时优先使用 GLB/glTF、image、audio、json。

当前已有示例资源包：

```text
D:\DroneHidePlatform\server\uploads\plugins\classroom-fps-demo-pack\
```

其中有两个简化自制 GLB 角色模型，另外有步枪、护甲、烟雾/闪光、侦察机、自爆穿越机等资源槽，资源槽暂时使用内置回退表现。另有 `default-basic-pack` 回退包。

## 4. 重要源码位置

```text
shared/types.ts              前后端共享类型、战术字段、资源包清单类型
client/src/App.tsx          地图管理、房间入口、港口地图预设
client/src/GameRoom.tsx     房间 UI、HUD、战术事件发送、无人机按钮
client/src/GameScene.tsx    Three.js 场景、移动、视角、开火输入、爆破点标记
client/src/MapConfigEditor.tsx 地图模式、出生点和战术规则编辑
client/src/api.ts           前端 HTTP API 封装
client/src/styles.css       全局界面样式
server/src/store.ts         地图、资源包、房间、玩家和战斗状态
server/src/index.ts         Express 路由、Socket.IO 事件、定时器和胜负结算
server/data/maps.json       地图配置持久化文件
uploads/maps/               项目本地地图资源
server/uploads/plugins/     已导入的游戏资源包
PACKAGE_FORMATS.md          地图包和资源包格式说明
REMOTE_MAP_GUIDE.md         远程地图/CDN登记说明
SHARED_TEST_GUIDE.md        Quick Tunnel 临时跨网络测试说明
```

## 5. 当前 Socket.IO 关键事件

客户端 → 服务端：

```text
room:join / room:leave / room:start
player:update
weapon:fire / weapon:reload
bomb:plant / bomb:defuse / bomb:defuse:cancel
drone:activate                 （战术模式下仅支持 recon，fpv 需用 fpv:launch）
fpv:launch / fpv:update / fpv:detonate
```

服务端 → 客户端：

```text
room:state                     （真实房间状态广播）
room:error                     （用户可见错误）
round:event                    （回合事件：bomb-planted/bomb-defused/defuse-start/defuse-cancelled/kill/reload/drone-fpv/drone-destroyed/round-end/round-start/bomb-picked-up 等）
combat:feedback                （仅发给开火者本人：hit/blocked/empty/reloading，hit 带目标名，blocked 带墙距）
drone:scan-result              （侦察机扫描结果）
```

注意：所有 socket 事件均无 ack 回调，服务端通过广播确认。服务端通过 `room:state` 广播真实房间状态，通过 `room:error` 返回用户可见错误。后续修改战斗规则时，优先保持事件名和字段兼容，不要在前端单独伪造胜负。

## 6. 启动和验证

在项目根目录执行：

```powershell
cd D:\DroneHidePlatform
npm install
npm run dev
```

打开：

```text
http://localhost:5180/
```

验证：

```powershell
npm run typecheck
npm run check
```

如果提示端口占用，先检查是否已有本项目服务在运行；不要直接杀掉不明进程。前端 5180、后端 3001 可能已经被前一轮开发服务占用。

本地双人测试方式：打开两个浏览器窗口，分别进入同一个房间，准备并开始游戏。当前最需要人工验证：角色分配、移动、开火、换弹、炸弹安装、拆除、引爆、无人机次数消耗和死亡后的状态同步。

## 7. 当前未完成事项，按优先级

### P0：可玩性验证（大部分已完成，2026-10-13 端到端测试 19/19 通过）

已验证通过（socket 级自动化测试 ` .temp/socket-e2e-test.mjs`，19/19）：

- 建房/加入/开始/角色分配/准备阶段/正式回合。
- 射击命中反馈与伤害计算（护甲吸收）。
- 炸弹安装、拆弹开始/完成、回合结算、比分。
- 多回合流转（每 2 回合攻防互换）、killfeed。
- FPV 发射/上报/起飞保护/引爆/击杀。

仍需人工验证：

1. 双浏览器窗口实际手感：移动、跳跃、开火反馈、第一人称视角。
2. 港口 GLB 地图与仓储要塞的出生点/A 点可玩性对比。

### P1：补齐战术规则

1. 死亡观战视角（当前死亡后只能看 HUD）。
2. 基础武器/护甲/投掷物差异（烟雾/闪光资源槽已有）。
3. 买枪/经济系统（CSGO 核心，当前每回合重置装备）。
4. 回合内时间结束的判定细节（炸弹已安装时时间应归零后转入爆炸倒计时）。

### P1：资源管线联调

1. 让资源组按 `PACKAGE_FORMATS.md` 提供一个真实资源包。
2. 联调至少一个角色、一个武器、一个无人机 GLB 和一个音效/特效。
3. 验证资源缺失时仍能使用内置回退，不让游戏启动失败。
4. 继续记录每个资源的作者、来源、许可证和允许课堂展示/修改情况。

### P2：固定公网访问

当前没有固定公网域名，也没有完成 Cloudflare 账号、域名、部署平台或持久化存储配置。当前只能：

- 本机 `localhost`：只有本机能访问。
- Cloudflare Quick Tunnel：可跨网络临时访问，但每次重启地址可能变化，而且电脑和项目服务必须一直运行。

真正固定网址需要域名、DNS/Cloudflare 配置和持续运行的部署环境。部署前还要解决：房间内存状态、上传文件持久化、静态地图/资源存储和 Socket.IO 长连接。不要向用户承诺一个尚未创建的域名。

## 8. 接下来 agent 的推荐动作

先不要重构工程，也不要重新下载官方 Dust2。P0 自动化测试已通过（`.temp/socket-e2e-test.mjs` 19/19），多回合/炸弹掉落/killfeed/FPV 穿越机均已完成，建议按以下顺序：

1. 阅读本文件、`PACKAGE_FORMATS.md`、`server/src/index.ts`、`server/src/store.ts`、`client/src/GameRoom.tsx`、`client/src/GameScene.tsx`。
2. 启动或确认现有 5180/3001 服务，用两个浏览器窗口人工验证手感：移动、跳跃、开火反馈、第一人称视角，以及仓储要塞/港口 GLB 两张图的出生点和 A 点可玩性对比。
3. 改动服务端规则后可运行 `node .temp/socket-e2e-test.mjs` 做回归（覆盖回合/炸弹/拆弹/FPV/击杀全流程，应 19/19 通过）。
4. 人工验证通过后再做 P1 战术规则：死亡观战视角、买枪/经济系统、投掷物差异、回合时间结束判定细节，每次修改后运行 `npm run typecheck` 和 `npm run check`。
5. 再接入资源组的 manifest 和静态资源。
6. 最后再做公网固定部署，不要在本地玩法尚未稳定时先处理域名。

## 9. 保护性约束

- 不要从头搭建。
- 不要清空、重置、删除项目文件或清理磁盘。
- 不要执行 `git reset --hard`、`git clean -fd` 或用新项目覆盖当前目录。
- 保留已有躲猫猫兼容能力，除非用户明确要求删除。
- 不要使用官方 CS:GO/Dust2 的地图、模型、贴图、音效或拆包资源。
- 不要把本机绝对路径写入运行时代码；上面的绝对路径只用于开发说明。
- 不要提交 `node_modules`、`client/dist`、`.env` 或临时缓存。
- 改动前先查看 `git status`，不要覆盖用户已有改动。
- 大型地图优先采用明确许可证的远程 URL/CDN 或项目已有本地资源，避免无必要地增加本机内存和仓库体积。

## 10. 可直接复制给下一个 agent 的任务提示

```text
你接手的是 D:\DroneHidePlatform 的 Drone Hide 项目。请先完整阅读 NEXT_AGENT_HANDOFF.md 和 PACKAGE_FORMATS.md，再查看 git status。不要从头搭建，不要 reset、clean、删除文件，也不要覆盖现有工作区改动。项目已经有 React/Vite + Express/Socket.IO + Three.js 联机原型，当前重点是 tactical-bomb 战术爆破模式，不是重新做一套躲猫猫。

先确认 http://localhost:5180/ 和 http://localhost:3001/api/health 是否正常。当前主推地图是程序化生成的仓储要塞 warehouse-fortress（shared/warehouseMap.ts，App 默认选中），备用港口 GLB 地图在 uploads/maps/harbour-square-payload-v1.0.0.glb，配置都在 server/data/maps.json；不要使用官方 CS:GO/Dust2 资产。服务端自动化测试已 19/19 通过，改动规则后可用 node .temp/socket-e2e-test.mjs 回归。下一步优先：两个浏览器窗口人工验证手感（创建/加入房间、角色分配、移动、开火、换弹、安装炸弹、拆弹、引爆、无人机），发现问题先修，每次修改后运行 npm run typecheck 和 npm run check。之后按 P1 顺序做死亡观战、买枪经济系统、投掷物差异，再与资源组联调 manifest。固定公网域名尚未配置，不要假装已经部署。
```

> AI生成

## 11. 2026-10-19 启动器修复与上传安全加固

本节记录 2026-10-19 完成并验收的后续工作；如与上文旧状态描述冲突，以本节与当前源码、当次测试结果为准。

### 启动器与记录

- `D:\web游戏平台\start-drone-hide.cmd` 和 `start-drone-hide.ps1` 已修复并完成受控启动验证：Node.js 门槛对齐 Vite 7（`^20.19.0 || >=22.12.0`）；启动时处理 `PORT` 环境变量；后端健康检查要求 JSON 中 `ok=true` 且 `service="drone-hide-platform-server"`；修正了 `.cmd` 日志路径。前端复用端口时只能确认 HTTP 服务可响应，不能可靠识别是否为 Vite。
- 本轮相关记录在 `D:\web游戏平台`：`DroneHide_启动与资源接口_静态核对报告_20261019.md`、`DroneHide_启动器受控验证记录_20261019.md`、`DroneHide_git基线_20261019.txt`。

### 上传安全合同

- 服务端上传合同位于 `server/src/uploadSecurity.ts`，按扩展名、MIME 和分档大小上限校验：`.glb`、`.gltf`、`.bin`、`.json`、`.png`、`.jpg`、`.jpeg`、`.webp`、`.avif`、`.mp3`、`.wav`、`.ogg`、`.m4a`、`.md`。
- 单文件地图、地图包的 scene/collision、资源包中的 GLB 均校验文件头前四字节为 `glTF`。包内文件名要求 ASCII 安全字符，按大小写不敏感去重；目录路径和路径穿越会在规范化/改名之前拒绝。
- 上传合同错误映射为 HTTP 400，超过大小上限映射为 HTTP 413。两个 `/uploads` 静态目录均设置 `X-Content-Type-Options: nosniff`。远程地图只按 URL pathname 的 `.glb` 后缀判断，不检查 query/hash 中的字符串，也不验证远程响应真实内容或 CORS。
- SVG、HTML、HTM 是故意排除项（SVG 可内嵌脚本）；贴图使用 PNG/JPEG/WebP/AVIF。当前白名单保留 AVIF。
- 两份资源接入规范已同步上传白名单小节：`D:\web游戏平台\地图资源接口_接入规范_v0.1.md` 与 `D:\web游戏平台\人物道具资源接口_接入规范_v0.1.md`。资源组按规范提交即可；GLB 需为有效二进制模型。

### 测试与后续事项

- 测试基线由 15/15 更新为 22/22，新增 `server/src/uploadSecurity.test.ts`。根目录 `package.json` 的 `test` 已包含该测试；`check` 覆盖服务端和客户端类型检查及客户端构建。开工先运行 `npm test`，当前基线为 22/22。
- 尚未实现、留作可选后续功能：阶段 4 武器/道具运行时加载、碰撞盒编辑/预览 UI、远程资源真实内容与 CORS 的运行时验证（需具体 CDN URL）。
- 仓库约 49 项历史未提交变更属于项目所有者的工作区快照，本轮没有清理或覆盖；交接文档更新后状态项数可能变化，后续一律以实际 `git status` 为准，由项目所有者自行提交快照。
- 后续如需新增白名单文件类型，先说明扩展名、MIME、大小限制和风险，再实现并补测试。不要借此扩展上传执行能力；本轮范围不包含 `client/src`。

## 12. 2026-10-20 第一人称视角误触修复

- `client/src/GameScene.tsx` 将鼠标左键入口统一为 canvas `pointerdown`：第一人称 pointer lock 已存在时执行开枪或 FPV 引爆；pointer lock 已释放时只请求重新锁定，不会把同一次左键误当作开枪。
- 移除了独立的 canvas `click -> requestPointerLock` 路径，避免 click 与 pointerdown 竞争。监听 `pointerlockchange` 时区分首次未锁定与浏览器释放，释放后显示“第一人称视角已释放”提示；监听 `pointerlockerror` 及请求 Promise 拒绝时显示锁定失败提示。
- 未增加计时退出逻辑；回合倒计时不会主动退出视角。组件清理时仍由 `exitPointerLock()` 释放资源，ESC/浏览器焦点变化导致的原生 pointer lock 释放会保留为可见提示。
- 本轮只改前端视角访问层与本交接记录，不改 `server/`、`shared/` 或游戏规则逻辑。验证要求：`npm run check` 全绿、`npm test` 22/22；人工双浏览器验证覆盖连续左键、WASD+左键、静置 2 分钟、Alt+Tab、ESC，以及退出后快速连点锁定冷却。
