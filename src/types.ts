export type Role = "制片" | "导演" | "演员统筹" | "场记";
export type SceneStatus = "草稿" | "已确认" | "拍摄中" | "已完成";
export type ConflictType = "演员档期" | "场地占用" | "器材借用" | "转场时间";
export type PostponeStatus = "已完成" | "已回退" | "整批退回" | "已失效";

export interface Talent {
  id: string;
  name: string;
  role: string;
}

export interface Location {
  id: string;
  name: string;
  /** 场地每天可排的确认场次容量 */
  dailyCapacity: number;
}

export interface Equipment {
  id: string;
  name: string;
}

export interface Scene {
  id: string;
  code: string;
  title: string;
  day: string;
  start: string;
  end: string;
  talentIds: string[];
  locationId: string;
  equipmentIds: string[];
  status: SceneStatus;
  locked: boolean;
  /** 必拍场次：顺延排不进时整批退回 */
  mustShoot: boolean;
  /** 候补：场地容量排满后先候补，不占确认容量 */
  waitlisted: boolean;
  /** 在待排区：顺延未落地，blockedBy 写明卡住的资源 */
  postponed: boolean;
  /** 卡住的资源项，如 演员档期：林川、场地占用：老码头 */
  blockedBy: string[];
  /** 所属顺延批次 id */
  postponeBatchId?: string;
  /** 顺延前的拍摄日，用于失效后重算 */
  originalDay?: string;
}

export interface Conflict {
  id: string;
  type: ConflictType;
  sceneIds: string[];
  message: string;
  severity: "高" | "中";
}

export interface HistoryEntry {
  id: string;
  action: string;
  detail: string;
  time: string;
}

export interface Version {
  id: string;
  name: string;
  time: string;
  scenes: Scene[];
}

export interface OfflineDraft {
  scenes: Scene[];
  savedAt: string;
}

export interface PostponeRevision {
  id: string;
  /** 天气停摆的原拍摄日 */
  fromDay: string;
  /** 顺延到的拍摄日 */
  toDay: string;
  createdAt: string;
  status: PostponeStatus;
  /** 参与本次顺延的场次 id（已开拍的不在内） */
  sceneIds: string[];
  /** 顺延前的全量快照，用于回退 */
  snapshot: Scene[];
  result: {
    /** 已落地 */
    landed: string[];
    /** 候补 */
    waitlisted: string[];
    /** 待排（整批退回时为空） */
    rejected: string[];
  };
  note: string;
}
