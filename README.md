# Drone Hide Platform

## Temporary shared test URL

The local development server can be shared with classmates on different networks through a Cloudflare Quick Tunnel. It is a temporary HTTPS address: it works only while the server and the tunnel process are running on the host computer.

1. Start the project with `npm run dev`.
2. Start the tunnel with `cloudflared tunnel --url http://localhost:5180`.
3. Share the displayed `https://...trycloudflare.com` URL. Everyone opens that URL, then creates or joins a room with its room code.

No participant needs the same VPN or Wi-Fi. This is a classroom test setup, not a production deployment. The URL changes after the tunnel stops; do not expose personal or real flight data through it.

基于无人机实景三维地图的 Web 联机捉迷藏管理平台。

## 当前功能

- React + Vite 前端
- Express + Socket.IO 后端
- 前后端共享 TypeScript 类型
- 内置校园测试场景，不依赖真实 `.glb` 地图
- `.glb` 地图导入、预览与来源记录
- 地图出生点、区域、边界和游戏规则配置
- 地图配置 JSON 持久化
- 无人机 SDK 采集任务登记、状态跟踪和地图关联
- 导入的 GLB 地图在游戏场景中加载，失败时自动回退到测试场景
- 资源包清单识别和内置基础资源回退，不依赖外部角色模型
- 创建房间、房间码加入、房主开始游戏
- 服务端控制的等待、准备倒计时、正式游戏、结算状态机
- 寻找者/躲藏者分配、移动同步、抓捕和结算
- 寻找者每局 1 次侦察机扫描和 1 次自爆穿越机范围抓捕原型

## 启动

```bash
npm install
npm run dev
```

打开 `http://localhost:5180`。

后端健康接口：`http://localhost:3001/api/health`

提交或合并代码前执行完整检查：

```bash
npm run check
```

`npm run check` 会依次检查服务端、前端 TypeScript，并构建前端产物。开发环境当前使用模拟无人机 SDK 桥接层，能够登记采集任务和记录建模成果，但不会直接控制真机。

## 无人机玩法原型

正式游戏开始后，寻找者可以在右侧“无人机原型”面板使用两项能力：

- 侦察机：每局 1 次，扫描寻找者附近 36 米范围，标记目标 8 秒。
- 自爆穿越机：每局 1 次，以寻找者当前位置为中心进行 7 米范围抓捕判定。

两项能力由服务端判定并通过 Socket.IO 同步。资源组后续只需在游戏资源包中提供对应模型或特效资源，不需要改动房间规则。当前没有对应模型时，功能仍使用界面和基础标记运行。

## 团队协作

详细的安装、通信协议、任务范围、资源包格式和 U 盘交付规范见 [TEAM_HANDOFF.md](TEAM_HANDOFF.md)。

独立完成路线：先使用内置测试场景完成联机演示，再在“无人机任务”页面登记航拍任务，最后在“地图管理”上传 `.glb`、记录来源许可证、关联模型已生成的采集任务并保存游戏区域配置。资源组或地图组成果属于可插拔增强，不是本项目运行前提。
