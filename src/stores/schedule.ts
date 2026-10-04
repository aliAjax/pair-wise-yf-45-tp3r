import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import type { Conflict, Equipment, HistoryEntry, Location, OfflineDraft, PostponeRevision, Role, Scene, SceneStatus, Talent, Version } from "../types";

const STORAGE_KEY = "pair-wise-yf-45/schedule-v1";
const DRAFT_KEY = "pair-wise-yf-45/offline-draft";
const TRANSFER_GAP_MINUTES = 30;

const talents: Talent[] = [
  { id: "t1", name: "林川", role: "男主" },
  { id: "t2", name: "周禾", role: "女主" },
  { id: "t3", name: "顾言", role: "配角" },
  { id: "t4", name: "孙宁", role: "群演领队" }
];

const locations: Location[] = [
  { id: "l1", name: "老码头", dailyCapacity: 2 },
  { id: "l2", name: "玻璃厂房", dailyCapacity: 1 },
  { id: "l3", name: "南站候车厅", dailyCapacity: 3 }
];

const equipment: Equipment[] = [
  { id: "e1", name: "ARRI A机" },
  { id: "e2", name: "移动伸缩炮" },
  { id: "e3", name: "LED灯组" },
  { id: "e4", name: "跟拍车" }
];

const seedScenes: Scene[] = [
  { id: "s1", code: "A-012", title: "码头交接", day: "2026-10-08", start: "08:00", end: "11:30", talentIds: ["t1", "t3"], locationId: "l1", equipmentIds: ["e1", "e3"], status: "已确认", locked: false, mustShoot: true, waitlisted: false, postponed: false, blockedBy: [] },
  { id: "s2", code: "A-013", title: "厂房追逐", day: "2026-10-08", start: "14:00", end: "16:00", talentIds: ["t2"], locationId: "l2", equipmentIds: ["e2"], status: "草稿", locked: false, mustShoot: false, waitlisted: false, postponed: false, blockedBy: [] },
  { id: "s3", code: "B-021", title: "候车厅告别", day: "2026-10-10", start: "15:00", end: "18:30", talentIds: ["t2", "t3"], locationId: "l3", equipmentIds: ["e1"], status: "草稿", locked: false, mustShoot: false, waitlisted: false, postponed: false, blockedBy: [] },
  { id: "s4", code: "C-001", title: "夜景补拍", day: "2026-10-08", start: "16:30", end: "18:30", talentIds: ["t1"], locationId: "l2", equipmentIds: ["e3"], status: "草稿", locked: false, mustShoot: false, waitlisted: false, postponed: false, blockedBy: [] },
  { id: "s5", code: "D-002", title: "雨夜追踪", day: "2026-10-08", start: "17:00", end: "19:00", talentIds: ["t2"], locationId: "l2", equipmentIds: ["e2"], status: "草稿", locked: false, mustShoot: false, waitlisted: false, postponed: false, blockedBy: [] }
];

function readScenes(): Scene[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.scenes)) return parsed.scenes as Scene[];
    }
  } catch {
    /* fall through to seed */
  }
  return clone(seedScenes);
}

function readHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw).history as HistoryEntry[] : [];
  } catch {
    return [];
  }
}

function readVersions(): Version[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw).versions as Version[] : [];
  } catch {
    return [];
  }
}

function readPostpones(): PostponeRevision[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw).postpones as PostponeRevision[] : [];
  } catch {
    return [];
  }
}

function minutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function overlaps(a: Scene, b: Scene) {
  return a.day === b.day && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);
}

function shared(a: string[], b: string[]) {
  return a.some((value) => b.includes(value));
}

/**
 * 深拷贝快照。scenes/versions 等都是 Vue 响应式代理，
 * structuredClone 在部分环境（V8）无法克隆 Proxy，统一用 JSON 快照。
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export const useScheduleStore = defineStore("schedule", () => {
  const scenes = ref<Scene[]>(readScenes());
  const history = ref<HistoryEntry[]>(readHistory());
  const versions = ref<Version[]>(readVersions());
  const postpones = ref<PostponeRevision[]>(readPostpones());
  const role = ref<Role>("制片");
  const exemptions = ref<string[]>([]);
  const online = ref(navigator.onLine);
  const draft = ref<OfflineDraft | null>(null);

  const talentNames = (ids: string[]) => ids.map((id) => talents.find((item) => item.id === id)?.name ?? id);
  const locationName = (id: string) => locations.find((item) => item.id === id)?.name ?? id;
  const equipmentNames = (ids: string[]) => ids.map((id) => equipment.find((item) => item.id === id)?.name ?? id);

  const conflicts = computed<Conflict[]>(() => {
    const result: Conflict[] = [];
    for (let i = 0; i < scenes.value.length; i += 1) {
      for (let j = i + 1; j < scenes.value.length; j += 1) {
        const a = scenes.value[i];
        const b = scenes.value[j];
        if (!overlaps(a, b)) continue;
        const id = `${a.id}:${b.id}`;
        if (exemptions.value.includes(id)) continue;
        if (shared(a.talentIds, b.talentIds)) result.push({ id: `${id}:talent`, type: "演员档期", sceneIds: [a.id, b.id], message: `${talentNames(a.talentIds.filter((item) => b.talentIds.includes(item))).join("、")} 在两场戏中档期重叠`, severity: "高" });
        if (a.locationId === b.locationId) result.push({ id: `${id}:location`, type: "场地占用", sceneIds: [a.id, b.id], message: `${locationName(a.locationId)} 被同时占用`, severity: "高" });
        if (shared(a.equipmentIds, b.equipmentIds)) result.push({ id: `${id}:equipment`, type: "器材借用", sceneIds: [a.id, b.id], message: `${equipmentNames(a.equipmentIds.filter((item) => b.equipmentIds.includes(item))).join("、")} 发生借用重叠`, severity: "中" });
        if (a.locationId !== b.locationId && minutes(b.start) - minutes(a.end) < TRANSFER_GAP_MINUTES) result.push({ id: `${id}:transfer`, type: "转场时间", sceneIds: [a.id, b.id], message: "两个场地之间转场时间不足30分钟", severity: "中" });
      }
    }
    return result;
  });

  const sortedScenes = computed(() => [...scenes.value].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`)));

  /** 待排区：顺延未落地的场次 */
  const pendingScenes = computed(() => scenes.value.filter((scene) => scene.postponed));

  /** 有场次安排的拍摄日（去重排序） */
  const scheduledDays = computed(() => [...new Set(scenes.value.map((scene) => scene.day))].sort());

  function log(action: string, detail: string) {
    history.value.unshift({ id: crypto.randomUUID(), action, detail, time: new Date().toISOString() });
    history.value = history.value.slice(0, 80);
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ scenes: scenes.value, history: history.value, versions: versions.value, postpones: postpones.value }));
  }

  watch([scenes, history, versions, postpones], persist, { deep: true });

  function addScene(input: Omit<Scene, "id" | "status" | "locked" | "mustShoot" | "waitlisted" | "postponed" | "blockedBy"> & { mustShoot?: boolean }) {
    scenes.value.push({ ...input, id: crypto.randomUUID(), status: "草稿", locked: false, mustShoot: input.mustShoot ?? false, waitlisted: false, postponed: false, blockedBy: [] });
    log("新增场次", `${input.code} ${input.title}`);
  }

  function updateStatus(id: string, status: SceneStatus) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene || scene.locked) return;
    scene.status = status;
    log("流转状态", `${scene.code} → ${status}`);
  }

  function toggleLock(id: string) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return;
    scene.locked = !scene.locked;
    log(scene.locked ? "锁定场次" : "解锁场次", scene.code);
  }

  function toggleMustShoot(id: string) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return;
    scene.mustShoot = !scene.mustShoot;
    log(scene.mustShoot ? "标记必拍" : "取消必拍", scene.code);
  }

  function moveScene(from: number, to: number) {
    if (from === to || to < 0 || to >= scenes.value.length) return;
    const [item] = scenes.value.splice(from, 1);
    scenes.value.splice(to, 0, item);
    log("调整顺序", `${item.code} 移至第 ${to + 1} 位`);
  }

  function snapshot(name = `版本 ${versions.value.length + 1}`) {
    versions.value.unshift({ id: crypto.randomUUID(), name, time: new Date().toISOString(), scenes: clone(scenes.value) });
    versions.value = versions.value.slice(0, 12);
    log("保存版本", name);
  }

  function restore(id: string) {
    const version = versions.value.find((item) => item.id === id);
    if (!version) return;
    scenes.value = clone(version.scenes);
    log("恢复版本", version.name);
  }

  function saveDraft() {
    draft.value = { scenes: clone(scenes.value), savedAt: new Date().toISOString() };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft.value));
    log("保存离线草稿", dayjs(draft.value.savedAt).format("MM-DD HH:mm"));
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      draft.value = raw ? JSON.parse(raw) as OfflineDraft : null;
    } catch {
      draft.value = null;
    }
  }

  function syncDraft() {
    if (!draft.value) return;
    scenes.value = clone(draft.value.scenes);
    log("同步离线草稿", `同步 ${draft.value.scenes.length} 个场次`);
    draft.value = null;
    localStorage.removeItem(DRAFT_KEY);
  }

  function exempt(id: string) {
    exemptions.value.push(id);
    log("豁免冲突", id);
  }

  function setOnline(value: boolean) {
    online.value = value;
  }

  /**
   * 尝试把一场戏排到 toDay。
   * 返回 landed / waitlisted / rejected 及卡住的资源项。
   * 场地容量：确认容量排满 → 候补；候补也满 → 拒绝。
   */
  function placeScene(scene: Scene, toDay: string): { status: "landed" | "waitlisted" | "rejected"; blockedBy: string[] } {
    const blockedBy: string[] = [];
    const dayScenes = scenes.value.filter((item) => item.day === toDay && item.id !== scene.id);

    for (const other of dayScenes) {
      // 两场都排在 toDay，只需比较时段是否重叠
      const timeOverlap = minutes(scene.start) < minutes(other.end) && minutes(other.start) < minutes(scene.end);
      if (timeOverlap) {
        // 同一资源在同一时段重叠 → 卡住
        if (shared(scene.talentIds, other.talentIds)) {
          const names = talentNames(scene.talentIds.filter((id) => other.talentIds.includes(id))).join("、");
          blockedBy.push(`演员档期：${names}`);
        }
        if (scene.locationId === other.locationId) {
          blockedBy.push(`场地占用：${locationName(scene.locationId)}`);
        }
        if (shared(scene.equipmentIds, other.equipmentIds)) {
          const names = equipmentNames(scene.equipmentIds.filter((id) => other.equipmentIds.includes(id))).join("、");
          blockedBy.push(`器材借用：${names}`);
        }
      }
      // 换场留出转场间隔：相邻两场在不同场地且时段不重叠时，间隔不足 30 分钟则卡住
      if (!timeOverlap && scene.locationId !== other.locationId) {
        const sStart = minutes(scene.start);
        const sEnd = minutes(scene.end);
        const oStart = minutes(other.start);
        const oEnd = minutes(other.end);
        let gap: number | null = null;
        if (sStart >= oEnd) gap = sStart - oEnd;
        else if (oStart >= sEnd) gap = oStart - sEnd;
        if (gap !== null && gap < TRANSFER_GAP_MINUTES) {
          blockedBy.push(`转场间隔：与 ${other.code} 仅隔 ${gap} 分钟`);
        }
      }
    }

    if (blockedBy.length) {
      return { status: "rejected", blockedBy: [...new Set(blockedBy)] };
    }

    const location = locations.find((item) => item.id === scene.locationId);
    const capacity = location?.dailyCapacity ?? 2;
    const confirmedAtLoc = dayScenes.filter((item) => item.locationId === scene.locationId && !item.waitlisted).length;
    const waitlistedAtLoc = dayScenes.filter((item) => item.locationId === scene.locationId && item.waitlisted).length;
    if (confirmedAtLoc >= capacity) {
      if (waitlistedAtLoc >= capacity) {
        return { status: "rejected", blockedBy: [`场地容量：${locationName(scene.locationId)} 当日已排满 ${capacity} 场确认 + ${capacity} 场候补`] };
      }
      return { status: "waitlisted", blockedBy: [] };
    }
    return { status: "landed", blockedBy: [] };
  }

  /** 把场次标记为待排（保留原拍摄日，等待续排） */
  function markPending(scene: Scene, batchId: string) {
    scene.postponed = true;
    scene.waitlisted = false;
    scene.blockedBy = [];
    scene.postponeBatchId = batchId;
    if (!scene.originalDay) scene.originalDay = scene.day;
  }

  /**
   * 天气顺延：一次可回退的改版。
   * 1. 拍快照；2. 把 fromDay 未开拍的场次按必拍优先排到 toDay；
   * 3. 必拍场次排不进 → 整批退回，恢复原占用；4. 否则落地/候补，排不进的进待排区。
   */
  function postpone(fromDay: string, toDay: string): { ok: boolean; revision: PostponeRevision } {
    const snapshot = clone(scenes.value);
    const batchId = crypto.randomUUID();

    const candidates = scenes.value.filter((scene) => scene.day === fromDay && (scene.status === "草稿" || scene.status === "已确认"));
    for (const scene of candidates) markPending(scene, batchId);

    const ordered = [...candidates].sort((a, b) => Number(b.mustShoot) - Number(a.mustShoot) || a.start.localeCompare(b.start));
    const landed: string[] = [];
    const waitlisted: string[] = [];
    const rejected: string[] = [];

    for (const scene of ordered) {
      const outcome = placeScene(scene, toDay);
      if (outcome.status === "landed") {
        scene.day = toDay;
        scene.postponed = false;
        scene.waitlisted = false;
        scene.blockedBy = [];
        landed.push(scene.id);
      } else if (outcome.status === "waitlisted") {
        scene.day = toDay;
        scene.postponed = false;
        scene.waitlisted = true;
        scene.blockedBy = [];
        waitlisted.push(scene.id);
      } else {
        scene.blockedBy = outcome.blockedBy;
        rejected.push(scene.id);
      }
    }

    const mustFailed = ordered.find((scene) => scene.mustShoot && rejected.includes(scene.id));
    if (mustFailed) {
      // 整批退回：原占用和版本还在
      scenes.value = snapshot;
      const revision: PostponeRevision = {
        id: batchId,
        fromDay,
        toDay,
        createdAt: new Date().toISOString(),
        status: "整批退回",
        sceneIds: candidates.map((scene) => scene.id),
        snapshot,
        result: { landed: [], waitlisted: [], rejected },
        note: `必拍场次 ${mustFailed.code} ${mustFailed.title} 无法落地（${mustFailed.blockedBy.join("；")}），整批退回，原通告保留`
      };
      postpones.value.unshift(revision);
      log("顺延整批退回", revision.note);
      return { ok: false, revision };
    }

    const revision: PostponeRevision = {
      id: batchId,
      fromDay,
      toDay,
      createdAt: new Date().toISOString(),
      status: "已完成",
      sceneIds: candidates.map((scene) => scene.id),
      snapshot,
      result: { landed, waitlisted, rejected },
      note: `顺延 ${fromDay} → ${toDay}：落地 ${landed.length} 场，候补 ${waitlisted.length} 场，待排 ${rejected.length} 场`
    };
    postpones.value.unshift(revision);
    log("顺延完成", revision.note);
    return { ok: true, revision };
  }

  /** 回退顺延：恢复到顺延前的全量快照 */
  function rollbackPostpone(id: string) {
    const revision = postpones.value.find((item) => item.id === id);
    if (!revision || revision.status !== "已完成") return;
    scenes.value = clone(revision.snapshot);
    revision.status = "已回退";
    revision.note = `${revision.note}（已回退，恢复 ${dayjs(revision.createdAt).format("MM-DD HH:mm")} 快照）`;
    log("回退顺延", `${revision.fromDay} → ${revision.toDay}`);
  }

  /**
   * 续排：只续排没落地的场次，已落地的不动。
   * 整批退回的批次重新标记后再排；已失效的批次重算待排场次。
   */
  function retryPostpone(id: string): { ok: boolean; revision: PostponeRevision | null } {
    const revision = postpones.value.find((item) => item.id === id);
    if (!revision) return { ok: false, revision: null };

    // 只续排没落地的场次：已在 toDay 落地/候补的不动
    const pending = scenes.value.filter((scene) =>
      revision.sceneIds.includes(scene.id) &&
      !(scene.day === revision.toDay && !scene.postponed)
    );
    for (const scene of pending) markPending(scene, revision.id);

    const ordered = [...pending].sort((a, b) => Number(b.mustShoot) - Number(a.mustShoot) || a.start.localeCompare(b.start));
    const landed: string[] = [];
    const waitlisted: string[] = [];
    const rejected: string[] = [];

    for (const scene of ordered) {
      const outcome = placeScene(scene, revision.toDay);
      if (outcome.status === "landed") {
        scene.day = revision.toDay;
        scene.postponed = false;
        scene.waitlisted = false;
        scene.blockedBy = [];
        landed.push(scene.id);
      } else if (outcome.status === "waitlisted") {
        scene.day = revision.toDay;
        scene.postponed = false;
        scene.waitlisted = true;
        scene.blockedBy = [];
        waitlisted.push(scene.id);
      } else {
        scene.blockedBy = outcome.blockedBy;
        rejected.push(scene.id);
      }
    }

    const mustFailed = ordered.find((scene) => scene.mustShoot && rejected.includes(scene.id));
    if (mustFailed) {
      scenes.value = clone(revision.snapshot);
      revision.status = "整批退回";
      revision.result = { landed: [], waitlisted: [], rejected };
      revision.note = `续排仍无法落地必拍场次 ${mustFailed.code}（${mustFailed.blockedBy.join("；")}），整批退回`;
      log("续排整批退回", revision.note);
      return { ok: false, revision };
    }

    // 累计已落地/候补 + 本次新落地/候补
    const settled = scenes.value.filter((scene) => revision.sceneIds.includes(scene.id) && scene.day === revision.toDay && !scene.postponed);
    revision.result = {
      landed: settled.filter((scene) => !scene.waitlisted).map((scene) => scene.id),
      waitlisted: settled.filter((scene) => scene.waitlisted).map((scene) => scene.id),
      rejected
    };
    revision.status = "已完成";
    revision.note = `续排 ${revision.fromDay} → ${revision.toDay}：累计落地 ${revision.result.landed.length} 场，候补 ${revision.result.waitlisted.length} 场，待排 ${rejected.length} 场`;
    log("续排完成", revision.note);
    return { ok: true, revision };
  }

  /** 把批次内已落地/候补的场次退回待排区（失效重算用） */
  function revertBatchToPending(revision: PostponeRevision) {
    for (const sceneId of [...revision.result.landed, ...revision.result.waitlisted]) {
      const scene = scenes.value.find((item) => item.id === sceneId);
      if (!scene) continue;
      scene.postponed = true;
      scene.waitlisted = false;
      scene.blockedBy = [];
      scene.day = scene.originalDay ?? scene.day;
    }
  }

  /** 场地容量或场次时段一变，已确认的结果失效重算 */
  function invalidateByLocation(locationId: string) {
    const affected = postpones.value.filter((revision) =>
      revision.status === "已完成" &&
      [...revision.result.landed, ...revision.result.waitlisted].some((sceneId) => scenes.value.find((item) => item.id === sceneId)?.locationId === locationId)
    );
    for (const revision of affected) {
      revertBatchToPending(revision);
      revision.status = "已失效";
      revision.note = `${revision.note}（因场地容量调整失效，待重算）`;
      log("顺延失效", `${revision.fromDay} → ${revision.toDay}，场地 ${locationName(locationId)} 容量变更`);
    }
  }

  function invalidateByScene(sceneId: string) {
    const affected = postpones.value.filter((revision) =>
      revision.status === "已完成" &&
      [...revision.result.landed, ...revision.result.waitlisted].includes(sceneId)
    );
    for (const revision of affected) {
      revertBatchToPending(revision);
      revision.status = "已失效";
      revision.note = `${revision.note}（因场次时段调整失效，待重算）`;
      log("顺延失效", `${revision.fromDay} → ${revision.toDay}，场次 ${scenes.value.find((item) => item.id === sceneId)?.code ?? sceneId} 时段变更`);
    }
  }

  function updateLocationCapacity(locationId: string, capacity: number) {
    const location = locations.find((item) => item.id === locationId);
    if (!location) return;
    location.dailyCapacity = Math.max(1, Math.min(20, Math.round(capacity)));
    log("调整场地容量", `${location.name} 每日 ${location.dailyCapacity} 场`);
    invalidateByLocation(locationId);
  }

  function updateSceneTime(id: string, day: string, start: string, end: string) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return;
    const changed = scene.day !== day || scene.start !== start || scene.end !== end;
    scene.day = day;
    scene.start = start;
    scene.end = end;
    log("调整场次时段", `${scene.code} → ${day} ${start}-${end}`);
    if (changed) invalidateByScene(id);
  }

  return {
    scenes, sortedScenes, pendingScenes, scheduledDays, conflicts, history, versions, postpones,
    role, exemptions, online, draft, talents, locations, equipment,
    talentNames, equipmentNames, locationName,
    addScene, updateStatus, toggleLock, toggleMustShoot, moveScene,
    snapshot, restore, saveDraft, loadDraft, syncDraft, exempt, setOnline,
    postpone, rollbackPostpone, retryPostpone,
    updateLocationCapacity, updateSceneTime
  };
});
