export type Role = "制片" | "导演" | "演员统筹" | "场记";
export type SceneStatus = "草稿" | "待排" | "候补" | "已确认" | "拍摄中" | "已完成";
export type ConflictType = "演员档期" | "场地占用" | "器材借用" | "转场时间";
export type PlacementKind = "已排入" | "候补" | "待排";

export interface Talent {
  id: string;
  name: string;
  role: string;
}

export interface Location {
  id: string;
  name: string;
  /** 场地每天的拍摄容量（分钟），排满后先候补再拒绝 */
  capacityMinutes: number;
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
  /** 必拍场次：排不进时整批退回 */
  mustShoot: boolean;
  /** 待排/候补时写明卡住哪项资源 */
  blockedReason: string | null;
}

export interface Placement {
  sceneId: string;
  code: string;
  title: string;
  day: string;
  kind: PlacementKind;
  reasons: string[];
}

export interface PlanOutcome {
  ok: boolean;
  /** 必拍场次排不进时已整批退回，原占用与版本保持不变 */
  rolledBack: boolean;
  message: string;
  entries: Placement[];
  versionId?: string;
}

export interface FailedPostpone {
  fromDay: string;
  toDay: string;
  sceneIds: string[];
  time: string;
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
