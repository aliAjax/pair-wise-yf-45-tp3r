import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import type { Conflict, Equipment, FailedPostpone, HistoryEntry, Location, OfflineDraft, Placement, PlanOutcome, Role, Scene, SceneStatus, Talent, Version } from "../types";
import { DEFAULT_TRANSFER_GAP, WAITLIST_LIMIT, durationOf, gapBetween, isMovable, isStarted, planPlacements, sharedIds, timeOverlap, type PlanContext } from "../planner";

const STORAGE_KEY = "pair-wise-yf-45/schedule-v1";
const DRAFT_KEY = "pair-wise-yf-45/offline-draft";

const talents: Talent[] = [
  { id: "t1", name: "林川", role: "男主" },
  { id: "t2", name: "周禾", role: "女主" },
  { id: "t3", name: "顾言", role: "配角" },
  { id: "t4", name: "孙宁", role: "群演领队" }
];

const seedLocations: Location[] = [
  { id: "l1", name: "老码头", capacityMinutes: 480 },
  { id: "l2", name: "玻璃厂房", capacityMinutes: 420 },
  { id: "l3", name: "南站候车厅", capacityMinutes: 360 }
];

const equipment: Equipment[] = [
  { id: "e1", name: "ARRI A机" },
  { id: "e2", name: "移动伸缩炮" },
  { id: "e3", name: "LED灯组" },
  { id: "e4", name: "跟拍车" }
];

const seedScenes: Scene[] = [
  { id: "s1", code: "A-012", title: "码头交接", day: "2026-10-08", start: "08:00", end: "11:30", talentIds: ["t1", "t3"], locationId: "l1", equipmentIds: ["e1", "e3"], status: "已确认", locked: false, mustShoot: true, blockedReason: null },
  { id: "s2", code: "A-013", title: "厂房追逐", day: "2026-10-08", start: "10:30", end: "13:00", talentIds: ["t1", "t2"], locationId: "l1", equipmentIds: ["e2", "e4"], status: "草稿", locked: false, mustShoot: false, blockedReason: null },
  { id: "s3", code: "B-021", title: "候车厅告别", day: "2026-10-09", start: "15:00", end: "18:30", talentIds: ["t2", "t3"], locationId: "l3", equipmentIds: ["e1"], status: "草稿", locked: false, mustShoot: false, blockedReason: null }
];

function normalizeScene(raw: any): Scene {
  const scene = { ...raw } as Scene;
  scene.mustShoot = raw?.mustShoot ?? false;
  scene.blockedReason = raw?.blockedReason ?? null;
  scene.talentIds = Array.isArray(raw?.talentIds) ? raw.talentIds : [];
  scene.equipmentIds = Array.isArray(raw?.equipmentIds) ? raw.equipmentIds : [];
  scene.locked = raw?.locked ?? false;
  return scene;
}

/** 响应式 Proxy 不能 structuredClone，统一用 JSON 深拷贝（场次均为纯数据） */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readBlob(): any {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readScenes(): Scene[] {
  const blob = readBlob();
  return Array.isArray(blob?.scenes) ? blob.scenes.map(normalizeScene) : clone(seedScenes);
}

function readHistory(): HistoryEntry[] {
  const blob = readBlob();
  return Array.isArray(blob?.history) ? blob.history : [];
}

function readVersions(): Version[] {
  const blob = readBlob();
  return Array.isArray(blob?.versions) ? blob.versions : [];
}

function readLocations(): Location[] {
  const blob = readBlob();
  if (Array.isArray(blob?.locations) && blob.locations.length) {
    return blob.locations.map((item: any) => ({ id: item.id, name: item.name, capacityMinutes: Number(item.capacityMinutes) || 480 }));
  }
  return clone(seedLocations);
}

function readTransferGap(): number {
  const blob = readBlob();
  const value = Number(blob?.transferGap);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TRANSFER_GAP;
}

function readPlanSignature(): string | null {
  const blob = readBlob();
  return typeof blob?.planSignature === "string" ? blob.planSignature : null;
}

function readFailedPostpone(): FailedPostpone | null {
  const blob = readBlob();
  return blob?.failedPostpone && Array.isArray(blob.failedPostpone.sceneIds) ? blob.failedPostpone : null;
}

export const useScheduleStore = defineStore("schedule", () => {
  const scenes = ref<Scene[]>(readScenes());
  const history = ref<HistoryEntry[]>(readHistory());
  const versions = ref<Version[]>(readVersions());
  const locations = ref<Location[]>(readLocations());
  const transferGap = ref<number>(readTransferGap());
  const planSignature = ref<string | null>(readPlanSignature());
  const lastFailedPostpone = ref<FailedPostpone | null>(readFailedPostpone());
  const lastPlan = ref<{ title: string; time: string; entries: Placement[] } | null>(null);
  const lastPostponeVersionId = ref<string | null>(null);
  const role = ref<Role>("制片");
  const exemptions = ref<string[]>([]);
  const online = ref(navigator.onLine);
  const draft = ref<OfflineDraft | null>(null);

  const talentNames = (ids: string[]) => ids.map((id) => talents.find((item) => item.id === id)?.name ?? id);
  const locationName = (id: string) => locations.value.find((item) => item.id === id)?.name ?? id;
  const equipmentNames = (ids: string[]) => ids.map((id) => equipment.find((item) => item.id === id)?.name ?? id);

  const conflicts = computed<Conflict[]>(() => {
    const result: Conflict[] = [];
    const active = scenes.value.filter((scene) => scene.status !== "待排");
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const a = active[i];
        const b = active[j];
        if (a.day !== b.day) continue;
        const id = `${a.id}:${b.id}`;
        if (exemptions.value.includes(id)) continue;
        if (timeOverlap(a, b)) {
          const sharedTalents = sharedIds(a.talentIds, b.talentIds);
          if (sharedTalents.length) result.push({ id: `${id}:talent`, type: "演员档期", sceneIds: [a.id, b.id], message: `${talentNames(sharedTalents).join("、")} 在两场戏中档期重叠`, severity: "高" });
          if (a.locationId === b.locationId) result.push({ id: `${id}:location`, type: "场地占用", sceneIds: [a.id, b.id], message: `${locationName(a.locationId)} 被同时占用`, severity: "高" });
          const sharedGear = sharedIds(a.equipmentIds, b.equipmentIds);
          if (sharedGear.length) result.push({ id: `${id}:equipment`, type: "器材借用", sceneIds: [a.id, b.id], message: `${equipmentNames(sharedGear).join("、")} 发生借用重叠`, severity: "中" });
          if (a.locationId !== b.locationId) result.push({ id: `${id}:transfer`, type: "转场时间", sceneIds: [a.id, b.id], message: `两场戏分处 ${locationName(a.locationId)} 与 ${locationName(b.locationId)} 且时段重叠，无法转场`, severity: "中" });
        } else if (a.locationId !== b.locationId && (sharedIds(a.talentIds, b.talentIds).length > 0 || sharedIds(a.equipmentIds, b.equipmentIds).length > 0)) {
          const gap = gapBetween(a, b);
          if (gap < transferGap.value) result.push({ id: `${id}:transfer`, type: "转场时间", sceneIds: [a.id, b.id], message: `换场间隔仅 ${gap} 分钟，不足 ${transferGap.value} 分钟`, severity: "中" });
        }
      }
    }
    return result;
  });

  const sortedScenes = computed(() => [...scenes.value].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`)));

  /** 场地容量或场次时段（草稿除外）的签名，用于判断已确认结果是否失效 */
  function currentSignature(): string {
    const slots = scenes.value
      .filter((scene) => scene.status !== "草稿")
      .map((scene) => `${scene.id}@${scene.day} ${scene.start}-${scene.end}#${scene.locationId}`)
      .sort();
    const capacities = locations.value.map((location) => `${location.id}:${location.capacityMinutes}`).sort();
    return JSON.stringify({ capacities, gap: transferGap.value, slots });
  }

  const planStale = computed(() => planSignature.value !== null && planSignature.value !== currentSignature());

  function log(action: string, detail: string) {
    history.value.unshift({ id: crypto.randomUUID(), action, detail, time: new Date().toISOString() });
    history.value = history.value.slice(0, 80);
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      scenes: scenes.value,
      history: history.value,
      versions: versions.value,
      locations: locations.value,
      transferGap: transferGap.value,
      planSignature: planSignature.value,
      failedPostpone: lastFailedPostpone.value
    }));
  }

  watch([scenes, history, versions, locations, transferGap, planSignature, lastFailedPostpone], persist, { deep: true });

  function planContext(): PlanContext {
    return {
      locations: locations.value,
      transferGap: transferGap.value,
      waitlistLimit: WAITLIST_LIMIT,
      talentName: (id) => talents.find((item) => item.id === id)?.name ?? id,
      equipmentName: (id) => equipment.find((item) => item.id === id)?.name ?? id,
      locationName
    };
  }

  function summarize(entries: Placement[]) {
    return {
      placed: entries.filter((entry) => entry.kind === "已排入").length,
      waitlisted: entries.filter((entry) => entry.kind === "候补").length,
      pending: entries.filter((entry) => entry.kind === "待排").length
    };
  }

  function commitPlacements(entries: Placement[]) {
    for (const entry of entries) {
      const scene = scenes.value.find((item) => item.id === entry.sceneId);
      if (!scene) continue;
      if (entry.kind === "已排入") {
        scene.status = "已确认";
        scene.blockedReason = null;
      } else {
        scene.status = entry.kind === "候补" ? "候补" : "待排";
        scene.blockedReason = entry.reasons.join("；");
      }
    }
  }

  function addScene(input: Omit<Scene, "id" | "status" | "locked" | "blockedReason">) {
    scenes.value.push({ ...input, id: crypto.randomUUID(), status: "草稿", locked: false, blockedReason: null });
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
    if (!scene || isStarted(scene)) return;
    scene.mustShoot = !scene.mustShoot;
    log(scene.mustShoot ? "标记必拍" : "取消必拍", scene.code);
  }

  /** 调整场次时段：已确认结果随之失效，需要重算 */
  function updateSceneSlot(id: string, patch: Partial<Pick<Scene, "day" | "start" | "end">>) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene || scene.locked || isStarted(scene)) return;
    Object.assign(scene, patch);
    log("调整时段", `${scene.code} → ${scene.day} ${scene.start}–${scene.end}`);
  }

  /** 调整场地每日容量：已确认结果随之失效，需要重算 */
  function setCapacity(locationId: string, minutes: number) {
    const location = locations.value.find((item) => item.id === locationId);
    if (!location || !Number.isFinite(minutes) || minutes <= 0) return;
    location.capacityMinutes = Math.round(minutes);
    log("调整场地容量", `${location.name} 每日 ${location.capacityMinutes / 60} 小时`);
  }

  function setTransferGap(minutes: number) {
    if (!Number.isFinite(minutes) || minutes < 0) return;
    transferGap.value = Math.round(minutes);
    log("调整转场间隔", `${transferGap.value} 分钟`);
  }

  function locationUsage(day: string, locationId: string) {
    return scenes.value
      .filter((scene) => scene.day === day && scene.locationId === locationId && scene.status !== "待排" && scene.status !== "候补")
      .reduce((sum, scene) => sum + durationOf(scene), 0);
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
    return versions.value[0].id;
  }

  function restore(id: string) {
    const version = versions.value.find((item) => item.id === id);
    if (!version) return;
    scenes.value = version.scenes.map(normalizeScene);
    planSignature.value = currentSignature();
    log("恢复版本", version.name);
  }

  /**
   * 天气顺延：把停摆日未开拍、未锁定的场次整体换到目标日，重新占用演员、场地与器材。
   * 先试算后提交：必拍场次排不进就整批退回，原占用与版本保持不变；
   * 成功则先存「顺延前备份」版本（可回退），再落地新占用。
   */
  function postpone(fromDay: string, toDay: string): PlanOutcome {
    if (!fromDay || !toDay) return { ok: false, rolledBack: false, message: "请选择停摆日与顺延目标日", entries: [] };
    if (fromDay === toDay) return { ok: false, rolledBack: false, message: "目标日与停摆日相同，无需顺延", entries: [] };
    const candidates = scenes.value.filter((scene) => scene.day === fromDay && isMovable(scene));
    if (!candidates.length) return { ok: false, rolledBack: false, message: `${fromDay} 没有可顺延的场次（已开拍与锁定场次保持原样）`, entries: [] };
    const fixed = scenes.value.filter((scene) => !candidates.some((item) => item.id === scene.id));
    const trial = clone(candidates).map((scene) => ({ ...scene, day: toDay }));
    const entries = planPlacements(trial, fixed, planContext());
    const failedMust = entries.filter((entry) => entry.kind !== "已排入" && candidates.find((item) => item.id === entry.sceneId)?.mustShoot);
    if (failedMust.length) {
      const codes = failedMust.map((entry) => entry.code).join("、");
      lastFailedPostpone.value = { fromDay, toDay, sceneIds: candidates.map((item) => item.id), time: new Date().toISOString() };
      lastPlan.value = { title: `顺延 ${fromDay} → ${toDay}（已整批退回）`, time: new Date().toISOString(), entries };
      log("顺延整批退回", `${fromDay} → ${toDay}：必拍场次 ${codes} 排不进，原通告与版本保留`);
      return { ok: false, rolledBack: true, message: `必拍场次 ${codes} 排不进，整批退回，原通告保持不变`, entries };
    }
    const versionId = snapshot(`顺延前备份 ${fromDay}→${toDay}`);
    for (const candidate of candidates) candidate.day = toDay;
    commitPlacements(entries);
    planSignature.value = currentSignature();
    lastFailedPostpone.value = null;
    lastPostponeVersionId.value = versionId;
    const stats = summarize(entries);
    lastPlan.value = { title: `顺延 ${fromDay} → ${toDay}`, time: new Date().toISOString(), entries };
    log("天气顺延", `${fromDay} → ${toDay}：排入 ${stats.placed} 场、候补 ${stats.waitlisted} 场、待排 ${stats.pending} 场`);
    return { ok: true, rolledBack: false, message: `顺延完成：排入 ${stats.placed} 场、候补 ${stats.waitlisted} 场、待排 ${stats.pending} 场`, entries, versionId };
  }

  /** 恢复后续排：只处理没落地的场次（待排/候补，以及整批退回后仍留在原通告里的那批） */
  function resumePending(): PlanOutcome {
    const failed = lastFailedPostpone.value;
    const pending = scenes.value.filter((scene) => (scene.status === "待排" || scene.status === "候补") && isMovable(scene));
    const rolledBack = failed
      ? scenes.value.filter((scene) => failed.sceneIds.includes(scene.id) && isMovable(scene) && scene.status !== "待排" && scene.status !== "候补")
      : [];
    const candidates = [...pending, ...rolledBack];
    if (!candidates.length) return { ok: false, rolledBack: false, message: "待排区是空的，没有需要续排的场次", entries: [] };
    const fixed = scenes.value.filter((scene) => !candidates.some((item) => item.id === scene.id));
    const trial = clone(candidates);
    for (const scene of trial) {
      if (failed && failed.sceneIds.includes(scene.id) && scene.status !== "待排" && scene.status !== "候补") scene.day = failed.toDay;
    }
    const entries = planPlacements(trial, fixed, planContext());
    const failedMust = entries.filter((entry) => entry.kind !== "已排入" && candidates.find((item) => item.id === entry.sceneId)?.mustShoot);
    if (failedMust.length) {
      const codes = failedMust.map((entry) => entry.code).join("、");
      lastPlan.value = { title: "续排未落地场次（已整批退回）", time: new Date().toISOString(), entries };
      log("续排整批退回", `必拍场次 ${codes} 仍排不进，原通告保持不变`);
      return { ok: false, rolledBack: true, message: `必拍场次 ${codes} 仍排不进，整批退回，原通告保持不变`, entries };
    }
    snapshot("续排前备份");
    for (const scene of trial) {
      const target = scenes.value.find((item) => item.id === scene.id);
      if (target) target.day = scene.day;
    }
    commitPlacements(entries);
    planSignature.value = currentSignature();
    if (failed) {
      const allLanded = failed.sceneIds.every((id) => {
        const entry = entries.find((item) => item.sceneId === id);
        if (entry) return entry.kind === "已排入";
        const scene = scenes.value.find((item) => item.id === id);
        return scene ? isStarted(scene) : true;
      });
      if (allLanded) lastFailedPostpone.value = null;
    }
    const stats = summarize(entries);
    lastPlan.value = { title: "续排未落地场次", time: new Date().toISOString(), entries };
    log("续排未落地", `排入 ${stats.placed} 场、候补 ${stats.waitlisted} 场、待排 ${stats.pending} 场`);
    return { ok: true, rolledBack: false, message: `续排完成：排入 ${stats.placed} 场、候补 ${stats.waitlisted} 场、待排 ${stats.pending} 场`, entries };
  }

  /** 失效重算：容量或场次时段变化后，重新校验所有已确认/候补/待排场次 */
  function recompute(): PlanOutcome {
    const candidates = scenes.value.filter((scene) => isMovable(scene) && scene.status !== "草稿");
    if (!candidates.length) return { ok: false, rolledBack: false, message: "没有需要重算的已确认场次", entries: [] };
    const fixed = scenes.value.filter((scene) => !candidates.some((item) => item.id === scene.id));
    const entries = planPlacements(clone(candidates), fixed, planContext());
    snapshot("重算前备份");
    commitPlacements(entries);
    planSignature.value = currentSignature();
    const stats = summarize(entries);
    const mustPending = entries.filter((entry) => entry.kind === "待排" && candidates.find((item) => item.id === entry.sceneId)?.mustShoot);
    const warning = mustPending.length ? `，必拍场次 ${mustPending.map((entry) => entry.code).join("、")} 排不进，请调整容量或时段` : "";
    lastPlan.value = { title: "失效重算", time: new Date().toISOString(), entries };
    log("失效重算", `重算 ${entries.length} 场：排入 ${stats.placed} 场、候补 ${stats.waitlisted} 场、待排 ${stats.pending} 场${warning}`);
    return { ok: true, rolledBack: false, message: `重算完成：排入 ${stats.placed} 场、候补 ${stats.waitlisted} 场、待排 ${stats.pending} 场${warning}`, entries };
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
    scenes.value = draft.value.scenes.map(normalizeScene);
    planSignature.value = currentSignature();
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

  function clearPostponeVersion() {
    lastPostponeVersionId.value = null;
  }

  return { scenes, sortedScenes, conflicts, history, versions, locations, transferGap, planStale, lastPlan, lastFailedPostpone, lastPostponeVersionId, role, exemptions, online, draft, talents, equipment, talentNames, equipmentNames, locationName, locationUsage, isMovable, isStarted, addScene, updateStatus, toggleLock, toggleMustShoot, updateSceneSlot, setCapacity, setTransferGap, moveScene, snapshot, restore, postpone, resumePending, recompute, saveDraft, loadDraft, syncDraft, exempt, setOnline, clearPostponeVersion };
});
