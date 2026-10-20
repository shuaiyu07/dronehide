# 团队开发交接手册

## 1. 先读这份说明

项目名称：基于三维地图的 Web 联机躲猫猫游戏平台。

项目目标不是控制无人机，而是把无人机 SDK 或开源三维建模成果导出的 `.glb` 地图，导入 Web 平台并配置为可联机游玩的躲猫猫地图。

```text
无人机 SDK / 航拍建模 / 开源模型
              -> GLB 三维地图
              -> Web 平台导入和配置
              -> 多人联机躲猫猫
```

组长负责：后端、Socket.IO、房间状态、角色分配、位置同步、抓捕判定、地图配置保存、最终合并。

队员负责：在自己的电脑上完成分配的模块。当前项目以组长独立可运行版本为基线；如果队员继续开发，优先使用 Gitee 分支提交，U 盘只用于传递大体积 GLB 和资源包。

## 2. 组长会给你的东西

你会从组长的 U 盘得到以下文件：

```text
DroneHidePlatform-TeamStarter.zip   项目基础工程
TEAM_HANDOFF.md                     本手册
```

解压 `DroneHidePlatform-TeamStarter.zip` 到自己电脑的非系统盘，例如：

```text
D:\DroneHidePlatform
```

每个人路径可以不同，代码中不能写死 `D:\DroneHidePlatform`、组长电脑 IP 或个人用户名。

基础工程不包含 `node_modules` 和 `client/dist`，这是正常的。请不要向组长索要或提交这两个目录。

## 3. 每个人电脑需要安装的软件

1. Node.js LTS，建议 20 或 22 版本。
2. Visual Studio Code 或其他代码编辑器。
3. Chrome 或 Edge 浏览器。

检查 Node.js 是否安装成功：

```powershell
node -v
npm -v
```

首次进入项目根目录后执行：

```powershell
npm install
npm run dev
```

浏览器访问：

```text
http://localhost:5180
```

后端健康检查地址：

```text
http://localhost:3001/api/health
```

停止服务：在启动命令的 PowerShell 中按 `Ctrl + C`。

提交给组长前必须执行：

```powershell
npm run typecheck
npm run build
```

## 4. 当前系统已经完成什么

基础工程已经实现：

- React + Vite 前端管理平台。
- Express 后端接口。
- Socket.IO 联机房间。
- Three.js 程序化校园测试场景。
- `.glb` 地图上传和预览。
- 地图来源、许可证、署名记录。
- 地图出生点、区域、边界和游戏规则配置。
- 地图配置 JSON 持久化。
- 创建房间、房间码加入、房主权限。
- 寻找者和躲藏者自动分配。
- 玩家移动同步、地图边界限制、抓捕和结算。

因此，不要重新创建 React、Express、Three.js 或 Socket.IO 项目，也不要重新写一套房间系统。你的工作是在现有基础上补全自己的模块。

## 5. 项目目录说明

```text
DroneHidePlatform/
├── client/                         React 前端
│   └── src/
│       ├── App.tsx                 管理端和联机大厅
│       ├── GameRoom.tsx            房间、HUD、结算页面
│       ├── GameScene.tsx           游戏三维场景和移动
│       ├── TestScene.tsx           地图管理页三维预览
│       ├── MapConfigEditor.tsx     出生点、区域、边界配置
│       ├── api.ts                  HTTP 接口调用
│       └── styles.css              现有全局样式
├── server/                         Express + Socket.IO 后端
│   ├── src/
│   │   ├── index.ts                HTTP 接口和 Socket.IO 事件
│   │   ├── store.ts                地图、房间、玩家状态
│   │   └── droneSdkAdapter.ts      SDK 来源适配预留
│   ├── data/                       保存后的地图配置
│   └── uploads/
│       ├── maps/                   上传的 GLB 地图
│       └── plugins/                资源包目录
├── shared/
│   ├── types.ts                    前后端共用的数据类型
│   └── demoMap.ts                  校园测试地图配置
├── package.json                    启动脚本
└── TEAM_HANDOFF.md                 本手册
```

## 6. 必须遵守的协作规则

1. 不要提交 `node_modules`、`client/dist`、`.git`、`.env` 或临时文件。
2. 不要修改 `server/src/index.ts`、`server/src/store.ts`、`shared/types.ts`、`package.json`，除非组长明确同意。
3. 不要删除现有功能来换成自己的实现。
4. 不要把个人电脑绝对路径写进代码。
5. 不要把 `http://localhost:3001` 写死在前端业务代码；前端应调用 `/api/...`。
6. 新增样式请创建自己的 CSS 文件并在对应组件中 `import`，不要整段覆盖 `styles.css`。
7. 新增第三方 npm 包前先告诉组长；没有必要不要安装新包。
8. 不要修改既有 Socket.IO 事件名称和字段名称。
9. 遇到问题先记录在 `README.md`，不要为了让页面看起来正常而删除错误处理。

## 7. 前后端通信约定

### 7.1 HTTP / REST

前端通过 Vite 代理调用相对地址，例如：

```ts
fetch("/api/maps")
```

不要写：

```ts
fetch("http://localhost:3001/api/maps")
```

HTTP 使用 JSON；上传地图使用 `multipart/form-data`。现有接口如下：

| 方法 | 地址 | 用途 | 请求主体 |
| --- | --- | --- | --- |
| GET | `/api/health` | 检查后端 | 无 |
| GET | `/api/maps` | 获取地图列表 | 无 |
| GET | `/api/maps/:mapId` | 获取一张地图 | 无 |
| POST | `/api/maps/import` | 上传 GLB 地图 | FormData |
| PUT | `/api/maps/:mapId/config` | 保存地图配置 | `{ "config": MapConfig }` |
| GET | `/api/rooms` | 获取房间列表 | 无 |
| GET | `/api/rooms/:roomId` | 按房间码查询 | 无 |
| POST | `/api/rooms` | 创建房间 | `{ "name": string, "mapId": string }` |
| GET | `/api/drone/sdk-status` | 查看 SDK 适配状态 | 无 |
| GET | `/api/drone/missions` | 获取采集任务 | 无 |
| POST | `/api/drone/missions` | 创建采集任务记录 | JSON |
| PUT | `/api/drone/missions/:missionId/status` | 更新采集任务阶段 | `{ "status": "planned" | "captured" | "model-ready" }` |

地图导入需要使用现有字段：

```text
model             .glb 文件
name              地图名称
description       地图说明
provenanceType    open-source 或 drone-sdk
sourceUrl         来源链接，可选
license           开源地图必填
attribution       作者或团队，可选
missionId         无人机采集任务 ID，可选
```

### 7.2 Socket.IO 实时事件

项目使用 Socket.IO，不需要也不允许自行创建 TCP、UDP、原生 WebSocket 服务。

客户端连接方式已经写好：

```ts
const socket = io();
```

客户端发送事件：

```ts
socket.emit("room:join", { roomId, name });
socket.emit("room:leave");
socket.emit("room:start");
socket.emit("player:update", {
  position: [x, y, z],
  rotation: [x, y, z],
});
```

客户端接收事件：

```ts
socket.on("room:state", (room) => { /* 最新房间状态 */ });
socket.on("room:error", ({ message }) => { /* 用户可见错误 */ });
```

规则：

- `room:state` 是房间真实状态，以它为准。
- 前端不能自行判定抓捕、胜负或房主身份。
- 前端可以预测自己的移动画面，但后端是最终位置和抓捕结果的裁判。
- 有新事件需求时，写进 README，先由组长设计再实现。

### 7.3 当前开发阶段的网络方式

每个人在自己的电脑上运行自己的一套本地服务：

```text
浏览器 -> localhost:5180 -> Vite 代理 -> localhost:3001
```

当前阶段不要求多台电脑通过校园网联机。双人联机测试可以在同一台电脑打开两个浏览器窗口完成。跨电脑局域网联机需要修改 Vite 代理、CORS 和服务器地址，最后由组长统一处理。

## 8. 共享数据类型

坐标统一使用三元数组：

```ts
type Vec3 = [number, number, number];
```

含义：

```text
x：左右
y：上下高度
z：前后
```

玩家状态重要字段：

```ts
{
  id: string,
  name: string,
  role: "seeker" | "hider" | "spectator",
  position: [x, y, z],
  rotation: [x, y, z],
  caught: boolean
}
```

房间状态只能是：

```text
waiting -> playing -> ended
```

地图配置包含：

```text
出生点、游戏区域、地图边界、准备时间、游戏时长、抓捕距离、最大人数
```

如果你觉得需要修改这些数据类型，请先说明原因并交给组长处理。

## 9. 队员 A：三维地图和玩家控制

### 工作内容

- 改善 `.glb` 地图加载、缩放、居中和落地。
- 改善 Three.js 场景、相机、光照和性能。
- 保持 WASD / 方向键移动可用。
- 显示玩家、出生点、躲藏区、禁区和安全区。
- 在地图加载失败时显示可理解提示并回退到默认校园场景。
- 为真实地图提供坐标、边界和出生点建议。

### 可修改文件

```text
client/src/GameScene.tsx
client/src/TestScene.tsx
client/src/scene.css                  可新建
client/src/components/                可新建
```

### 不能做的事

- 不要改 Socket.IO 事件。
- 不要重写后端位置同步。
- 不要改变 `onMove(position)` 的调用方式。
- 不要为了真实地图删除默认程序化场景。

### 交付

```text
member-A-scene.zip
├── client/src/                       修改或新增的源文件
├── maps/                             可选：测试 GLB 地图
├── MAP_NOTES.md                      坐标、边界、出生点建议
├── README.md
├── TEST.md
└── screenshots/
```

## 10. 队员 B：管理端和联机大厅

### 工作内容

- 改善地图列表、地图导入、地图配置入口。
- 改善创建房间、房间码加入和等待页面。
- 完善用户可见错误信息。
- 检查桌面端和手机端布局。

### 可修改文件

```text
client/src/App.tsx
client/src/api.ts
client/src/management.css             可新建
client/src/components/                可新建
```

### 不能做的事

- 不要写死地图或房间数据。
- 不要改后端路由或共享类型。
- 不要把 HTTP 请求改成硬编码 IP 或端口。
- 不要覆盖队员 D 的 `GameRoom.tsx`。

### 最少测试

```text
查看地图、导入 GLB、保存地图配置、创建房间、房间码加入、错误房间码、满员、游戏开始后加入。
```

### 交付

```text
member-B-management.zip
├── client/src/
├── README.md
├── TEST.md
└── screenshots/
```

## 11. 队员 C：游戏资源和资源包

### 工作内容

- 准备寻找者和躲藏者角色资源。
- 准备出生点、躲藏区、禁区标记资源。
- 准备抓捕、游戏结束特效资源。
- 准备至少一个简单道具资源。
- 整理资源来源、作者和许可证。
- 保证外部资源不在时，主项目仍然使用默认胶囊玩家和基础标记运行。

当前平台还没有自动插件上传和加载功能。资源组当前的职责是交付**规范资源包**，由组长后续接入加载逻辑；请不要制作可执行 JavaScript 插件，也不要修改后端游戏规则。

### 资源包格式

```text
campus-basic-pack/
├── manifest.json
├── assets/
│   ├── seeker.glb
│   ├── hider.glb
│   ├── seeker-marker.glb
│   ├── hider-marker.glb
│   ├── hide-zone-marker.glb
│   ├── forbidden-zone-marker.glb
│   ├── catch-effect.glb
│   ├── game-end-effect.glb
│   └── prop.glb
├── LICENSE.txt
└── README.md
```

`manifest.json` 模板：

```json
{
  "id": "campus-basic-pack",
  "name": "校园基础资源包",
  "version": "1.0.0",
  "author": "资源组",
  "license": "自制资源或明确第三方许可证",
  "sourceUrl": "",
  "assets": {
    "seekerModel": "assets/seeker.glb",
    "hiderModel": "assets/hider.glb",
    "seekerMarker": "assets/seeker-marker.glb",
    "hiderMarker": "assets/hider-marker.glb",
    "hideZoneMarker": "assets/hide-zone-marker.glb",
    "forbiddenZoneMarker": "assets/forbidden-zone-marker.glb",
    "catchEffect": "assets/catch-effect.glb",
    "gameEndEffect": "assets/game-end-effect.glb",
    "prop": "assets/prop.glb"
  }
}
```

`LICENSE.txt` 中每个第三方资源必须写：资源名称、来源链接、作者、许可证、是否允许修改、是否允许课堂展示。

资源最终由组长放入：

```text
server/uploads/plugins/campus-basic-pack/
```

未来在浏览器中访问资源的 URL 为：

```text
/uploads/plugins/campus-basic-pack/assets/seeker.glb
```

### 交付

```text
member-C-resource-pack.zip
├── campus-basic-pack/
├── README.md
├── TEST.md
└── screenshots/
```

## 12. 队员 D：HUD、测试和答辩材料

### 工作内容

- 改善计时器、角色状态、玩家列表。
- 增加被抓、胜利、失败、退出提示。
- 编写双窗口联机测试和异常测试。
- 编写启动说明、项目架构说明、答辩演示脚本。

### 可修改文件

```text
client/src/GameRoom.tsx
client/src/hud.css                    可新建
docs/                                 可新建
```

### 测试必须覆盖

```text
创建房间、两人加入、房主开始、角色分配、移动同步、抓捕、时间结束、错误房间码、单人开始、满员、玩家退出、房主退出、后端不可用、地图加载失败、无资源包回退。
```

### 文档至少包含

```text
TEST_REPORT.md     测试记录
START_GUIDE.md     给老师或同学的启动步骤
DEMO_SCRIPT.md     答辩演示说什么、点什么
ARCHITECTURE.md    前后端和数据流程图
GAME_FLOW.md       创建房间到结算的流程
```

### 交付

```text
member-D-hud-test-docs.zip
├── client/src/
├── docs/
├── README.md
├── TEST.md
└── screenshots/
```

## 13. 大体积资源交付规范

如果仍有成员参与，在自己的分支测试通过后提交代码；只有 GLB、贴图和资源包等大文件才使用 U 盘交给组长。不要把整个项目覆盖到组长目录。

每个压缩包必须带：

```text
README.md      修改内容、运行方法、已知问题、需要组长注意的合并点
TEST.md        测试环境、测试步骤、测试结果
screenshots/   至少两张效果或测试截图
```

组长合并顺序：

```text
1. 复制 U 盘压缩包到 team-submissions/
2. 解压到独立子目录，不直接覆盖源码
3. 阅读 README 和 TEST
4. 逐个文件人工合并
5. 每合并一人的模块运行 npm run typecheck 和 npm run build
6. 运行 npm run dev，完成双窗口联机测试
```

## 14. 常见问题

### 页面显示“后端还没有启动”

确认项目根目录中执行了：

```powershell
npm run dev
```

### `npm install` 失败

确认 Node.js 已安装，网络可访问 npm 镜像；把错误文字截图发给组长。

### 端口被占用

先关闭其他运行中的本项目 PowerShell 窗口，再重新执行 `npm run dev`。

### GLB 不显示

检查文件是否真的是 `.glb`、浏览器控制台是否有错误、模型是否过大、是否缩放过小或过大。保留错误截图和模型来源。

### 不知道该不该改某个文件

先看本手册中“可修改文件”。不在范围内时，先问组长。

## 15. 同时开发：Git 远程协作（推荐）

U 盘用于备份、传递大尺寸地图和模型；日常代码协作使用 GitHub 或 Gitee。Git 不会让一个人操作时其他人无法操作：每个人在自己的电脑和自己的分支中开发，提交并推送后再由组长合并。

### 15.1 组长只需做一次

1. 在 GitHub 或 Gitee 新建一个私有仓库，仓库名建议为 `drone-hide-platform`。
2. 新仓库不要勾选“初始化 README / .gitignore / License”，因为本项目已有这些文件。
3. 复制仓库 HTTPS 地址，例如 `https://gitee.com/你的账号/drone-hide-platform.git`。
4. 在项目根目录执行：

```powershell
git remote add origin <仓库HTTPS地址>
git push -u origin main
```

5. 把队员添加为仓库成员，至少给予可推送分支的权限。

### 15.2 每位队员首次操作

```powershell
git clone <仓库HTTPS地址>
cd drone-hide-platform
npm install
```

创建自己的分支。A：

```powershell
git switch -c feature/scene
```

B：

```powershell
git switch -c feature/management
```

C：

```powershell
git switch -c feature/resources
```

D：

```powershell
git switch -c feature/hud-test
```

### 15.3 每次开始开发

```powershell
git switch <自己的分支>
git pull origin main
```

如出现冲突，不要随意删除内容，截图并交给组长。

### 15.4 每次提交

```powershell
npm run typecheck
npm run build
git status
git add <自己修改的文件>
git commit -m "feat: 简短说明本次修改"
git push -u origin <自己的分支>
```

队员只推送自己的分支，不能直接向 `main` 推送。完成一个小功能后，把分支名、提交号和测试截图发给组长。组长审核后把分支合并进 `main`。

### 15.5 大文件和资源

普通源代码和文档可直接通过 Git 提交。单个 GLB 模型超过 50 MB 时不要直接推送，使用 U 盘交给组长，并在仓库提交 `manifest.json`、许可证、资源清单和预览截图。组长决定是否启用 Git LFS。

## 16. 2026-10-19 启动器修复与上传安全加固

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