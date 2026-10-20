import type { DroneMission, DroneSdkStatus } from "../../shared/types.ts";

export type DroneMissionDraft = Omit<DroneMission, "id" | "createdAt">;

/**
 * Web 浏览器不直接控制无人机。真实项目中，这个适配器应连接 Android 地面站、
 * DJI Mobile SDK、MAVSDK 或厂商云端服务；游戏平台本身只依赖这一层的统一协议。
 */
export interface DroneSdkAdapter {
  getStatus(): DroneSdkStatus;
  prepareMission(draft: DroneMissionDraft): DroneMissionDraft;
}

class SimulatedDroneSdkBridge implements DroneSdkAdapter {
  getStatus(): DroneSdkStatus {
    return {
      connected: false,
      mode: "simulated-bridge",
      provider: "本地模拟无人机 SDK 桥接层",
      message: "当前未连接真机；可先登记采集任务并导入建模结果。接入真机时替换此适配器即可。",
    };
  }

  prepareMission(draft: DroneMissionDraft): DroneMissionDraft {
    return {
      ...draft,
      provider: draft.provider || "本地模拟无人机 SDK 桥接层",
    };
  }
}

export const droneSdkAdapter: DroneSdkAdapter = new SimulatedDroneSdkBridge();
