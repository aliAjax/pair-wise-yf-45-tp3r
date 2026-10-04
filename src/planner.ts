import type { Location, Placement, Scene } from "./types";

export const DEFAULT_TRANSFER_GAP = 30;
/** 每个场地每天的候补名额，排满后先候补，候补也满了才拒绝 */
export const WAITLIST_LIMIT = 2;

export interface PlanContext {
  locations: Location[];
  transferGap: number;
  waitlistLimit: number;
  talentName: (id: string) => string;
  equipmentName: (id: string) => string;
  locationName: (id: string) => string;
}

export function minutesOf(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function durationOf(scene: Pick<Scene, "start" | "end">): number {
  return Math.max(0, minutesOf(scene.end) - minutesOf(scene.start));
}

export function timeOverlap(a: Pick<Scene, "start" | "end">, b: Pick<Scene, "start" | "end">): boolean {
  return minutesOf(a.start) < minutesOf(b.end) && minutesOf(b.start) < minutesOf(a.end);
}

/** 两个不重叠时段之间的间隔（分钟，与先后顺序无关） */
export function gapBetween(a: Pick<Scene, "start" | "end">, b: Pick<Scene, "start" | "end">): number {
  if (minutesOf(a.start) >= minutesOf(b.end)) return minutesOf(a.start) - minutesOf(b.end);
  return minutesOf(b.start) - minutesOf(a.end);
}

export function sharedIds(a: string[], b: string[]): string[] {
  return a.filter((value) => b.includes(value));
}

export function isStarted(scene: Scene): boolean {
  return scene.status === "拍摄中" || scene.status === "已完成";
}

/** 已开拍与锁定的场次照原样保留，编排引擎只处理可移动的场次 */
export function isMovable(scene: Scene): boolean {
  return !scene.locked && !isStarted(scene);
}

function capacityKey(locationId: string, day: string): string {
  return `${locationId}__${day}`;
}

export interface CapacityTracker {
  used: Map<string, number>;
  waitlisted: Map<string, number>;
}

/** 统计场地每日容量占用：待排区不占容量，候补占候补名额 */
export function buildTracker(scenes: Scene[]): CapacityTracker {
  const used = new Map<string, number>();
  const waitlisted = new Map<string, number>();
  for (const scene of scenes) {
    if (scene.status === "待排") continue;
    const key = capacityKey(scene.locationId, scene.day);
    if (scene.status === "候补") waitlisted.set(key, (waitlisted.get(key) ?? 0) + 1);
    else used.set(key, (used.get(key) ?? 0) + durationOf(scene));
  }
  return { used, waitlisted };
}

/** 同一天同一资源不能重叠；换场（共享演员/器材且不同场地）要留出转场间隔 */
export function blockingReasons(scene: Scene, others: Scene[], ctx: PlanContext): string[] {
  const reasons: string[] = [];
  for (const other of others) {
    if (other.id === scene.id || other.day !== scene.day || other.status === "待排") continue;
    if (timeOverlap(scene, other)) {
      const talents = sharedIds(scene.talentIds, other.talentIds);
      if (talents.length) reasons.push(`演员 ${talents.map(ctx.talentName).join("、")} 与 ${other.code} 时段重叠`);
      if (scene.locationId === other.locationId) reasons.push(`场地 ${ctx.locationName(scene.locationId)} 与 ${other.code} 时段重叠`);
      const gear = sharedIds(scene.equipmentIds, other.equipmentIds);
      if (gear.length) reasons.push(`器材 ${gear.map(ctx.equipmentName).join("、")} 与 ${other.code} 时段重叠`);
      if (scene.locationId !== other.locationId) reasons.push(`与 ${other.code} 分处 ${ctx.locationName(other.locationId)}，时段重叠无法转场`);
    } else if (scene.locationId !== other.locationId) {
      const moves = sharedIds(scene.talentIds, other.talentIds).length + sharedIds(scene.equipmentIds, other.equipmentIds).length;
      if (moves > 0) {
        const gap = gapBetween(scene, other);
        if (gap < ctx.transferGap) reasons.push(`与 ${other.code} 换场间隔仅 ${gap} 分钟，不足 ${ctx.transferGap} 分钟`);
      }
    }
  }
  return reasons;
}

/**
 * 纯函数排程：候选场次（必拍优先、再按拍摄日与时段）逐个试排。
 * 资源冲突 → 待排并写明卡住的资源；容量满 → 先候补，候补满 → 待排。
 */
export function planPlacements(candidates: Scene[], fixed: Scene[], ctx: PlanContext): Placement[] {
  const ordered = [...candidates].sort((a, b) => {
    if (a.mustShoot !== b.mustShoot) return a.mustShoot ? -1 : 1;
    const bySlot = `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`);
    return bySlot !== 0 ? bySlot : a.code.localeCompare(b.code);
  });
  const tracker = buildTracker(fixed);
  const occupied: Scene[] = fixed.filter((scene) => scene.status !== "待排");
  const placements: Placement[] = [];
  for (const scene of ordered) {
    const base = { sceneId: scene.id, code: scene.code, title: scene.title, day: scene.day };
    const reasons = blockingReasons(scene, occupied, ctx);
    if (reasons.length) {
      placements.push({ ...base, kind: "待排", reasons });
      continue;
    }
    const location = ctx.locations.find((item) => item.id === scene.locationId);
    const capacity = location ? location.capacityMinutes : Number.POSITIVE_INFINITY;
    const key = capacityKey(scene.locationId, scene.day);
    const used = tracker.used.get(key) ?? 0;
    if (used + durationOf(scene) > capacity) {
      const waited = tracker.waitlisted.get(key) ?? 0;
      if (waited < ctx.waitlistLimit) {
        tracker.waitlisted.set(key, waited + 1);
        occupied.push(scene);
        placements.push({ ...base, kind: "候补", reasons: [`${ctx.locationName(scene.locationId)} 当日容量已排满，列入候补第 ${waited + 1} 位`] });
      } else {
        placements.push({ ...base, kind: "待排", reasons: [`${ctx.locationName(scene.locationId)} 当日容量已排满，候补名额（${ctx.waitlistLimit}）也已满`] });
      }
      continue;
    }
    tracker.used.set(key, used + durationOf(scene));
    occupied.push(scene);
    placements.push({ ...base, kind: "已排入", reasons: [] });
  }
  return placements;
}
