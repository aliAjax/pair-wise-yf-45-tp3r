<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import dayjs from "dayjs";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useScheduleStore } from "../stores/schedule";
import type { Location, Scene, SceneStatus } from "../types";

const store = useScheduleStore();
const saving = ref(false);
const dragging = ref<number | null>(null);
const notice = ref("");
const form = reactive({ code: "", title: "", day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [] as string[], equipmentIds: [] as string[], mustShoot: false });
const postponeForm = reactive({ fromDay: "", toDay: "" });
const schema = toTypedSchema(z.object({
  code: z.string().min(2, "请输入场次编号"),
  title: z.string().min(2, "请输入场次名称"),
  day: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  locationId: z.string().min(1)
}));
const { errors, validate } = useForm({ validationSchema: schema });
const editable = computed(() => store.role === "制片" || store.role === "导演");
const currentStatus = (status: string) => status as SceneStatus;

const availableDays = computed(() => {
  const days = new Set<string>();
  for (const scene of store.scenes) if (store.isMovable(scene)) days.add(scene.day);
  return [...days].sort();
});
const pendingScenes = computed(() => store.sortedScenes.filter((scene) => scene.status === "待排" || scene.status === "候补"));
const hasPending = computed(() => pendingScenes.value.some((scene) => store.isMovable(scene)) || !!store.lastFailedPostpone);
const placedEntries = computed(() => store.lastPlan?.entries.filter((entry) => entry.kind === "已排入") ?? []);
const waitlistedEntries = computed(() => store.lastPlan?.entries.filter((entry) => entry.kind === "候补") ?? []);
const pendingEntries = computed(() => store.lastPlan?.entries.filter((entry) => entry.kind === "待排") ?? []);

onMounted(() => {
  store.loadDraft();
  postponeForm.fromDay = availableDays.value[0] ?? dayjs().format("YYYY-MM-DD");
  postponeForm.toDay = dayjs(postponeForm.fromDay).add(1, "day").format("YYYY-MM-DD");
});

function hours(minutes: number) {
  return Number((minutes / 60).toFixed(1));
}

function movableCount(day: string) {
  return store.scenes.filter((scene) => scene.day === day && store.isMovable(scene)).length;
}

function pickFromDay() {
  postponeForm.toDay = dayjs(postponeForm.fromDay).add(1, "day").format("YYYY-MM-DD");
}

function usageOf(locationId: string) {
  return store.locationUsage(postponeForm.toDay, locationId);
}

function waitingCount(locationId: string) {
  return store.scenes.filter((scene) => scene.status === "候补" && scene.day === postponeForm.toDay && scene.locationId === locationId).length;
}

function usageLabel(location: Location) {
  const waiting = waitingCount(location.id);
  return `目标日已排 ${hours(usageOf(location.id))}h / ${hours(location.capacityMinutes)}h${waiting ? ` · ${waiting} 场候补` : ""}`;
}

function usagePercent(location: Location) {
  return Math.min(100, Math.round((usageOf(location.id) / location.capacityMinutes) * 100));
}

function usageOver(location: Location) {
  return usageOf(location.id) > location.capacityMinutes;
}

function runPostpone() {
  notice.value = store.postpone(postponeForm.fromDay, postponeForm.toDay).message;
}

function runResume() {
  notice.value = store.resumePending().message;
}

function runRecompute() {
  notice.value = store.recompute().message;
}

function rollbackPostpone() {
  if (!store.lastPostponeVersionId) return;
  store.restore(store.lastPostponeVersionId);
  store.clearPostponeVersion();
  notice.value = "已回退到顺延前版本，原占用已恢复";
}

function applyCapacity(locationId: string, event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (value > 0) store.setCapacity(locationId, Math.round(value * 60));
}

function applyGap(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (value >= 0) store.setTransferGap(value);
}

const canEditSlot = (scene: Scene) => editable.value && !scene.locked && !store.isStarted(scene);

function updateSlot(id: string, field: "day" | "start" | "end", event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (value) store.updateSceneSlot(id, { [field]: value });
}

async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  saving.value = true;
  store.addScene({ code: form.code, title: form.title, day: form.day, start: form.start, end: form.end, locationId: form.locationId, talentIds: [...form.talentIds], equipmentIds: [...form.equipmentIds], mustShoot: form.mustShoot });
  Object.assign(form, { code: "", title: "", day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [], equipmentIds: [], mustShoot: false });
  setTimeout(() => { saving.value = false; }, 240);
}

function drop(index: number) {
  if (dragging.value !== null && editable.value) store.moveScene(dragging.value, index);
  dragging.value = null;
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article class="metric"><span>通告场次</span><strong>{{ store.scenes.length }}</strong></article>
      <article class="metric"><span>待处理冲突</span><strong>{{ store.conflicts.length }}</strong></article>
      <article class="metric"><span>未落地</span><strong>{{ pendingScenes.length }}</strong></article>
      <article class="metric"><span>已确认</span><strong>{{ store.scenes.filter((item: Scene) => item.status === '已确认').length }}</strong></article>
      <article class="metric"><span>版本快照</span><strong>{{ store.versions.length }}</strong></article>
    </div>
    <div v-if="store.planStale" class="draft-banner">
      <span>场地容量或场次时段已变化，已确认的编排结果失效，需要重算。</span>
      <div class="actions"><button class="primary" :disabled="!editable" @click="runRecompute">立即重算</button></div>
    </div>
    <div v-if="store.lastFailedPostpone" class="error-banner">
      <span>上次顺延（{{ store.lastFailedPostpone.fromDay }} → {{ store.lastFailedPostpone.toDay }}）因必拍场次排不进已整批退回，原通告保留。资源恢复后可点「续排未落地场次」。</span>
    </div>
    <div v-if="store.draft" class="draft-banner">
      <span>发现 {{ dayjs(store.draft.savedAt).format("MM-DD HH:mm") }} 的离线草稿，共 {{ store.draft.scenes.length }} 个场次。</span>
      <div class="actions"><button class="secondary" @click="store.syncDraft">同步到正式通告</button></div>
    </div>
    <section class="panel">
      <div class="panel-head">
        <div><h2>天气顺延 · 可回退改版</h2><small class="muted">停摆日未开拍的场次整体顺延，系统重新占用演员、场地与器材；必拍场次排不进则整批退回</small></div>
      </div>
      <div class="postpone-grid">
        <label class="field"><span>停摆日</span>
          <select v-model="postponeForm.fromDay" @change="pickFromDay">
            <option v-for="day in availableDays" :key="day" :value="day">{{ day }}（{{ movableCount(day) }} 场可顺延）</option>
          </select>
        </label>
        <label class="field"><span>顺延至</span><input v-model="postponeForm.toDay" type="date" /></label>
        <label class="field"><span>转场间隔（分钟）</span><input type="number" min="0" step="5" :value="store.transferGap" :disabled="!editable" @change="applyGap" /></label>
        <div class="actions postpone-actions">
          <button class="primary" :disabled="!editable" @click="runPostpone">生成顺延改版</button>
          <button class="secondary" :disabled="!editable || !hasPending" @click="runResume">续排未落地场次</button>
          <button v-if="store.lastPostponeVersionId" class="danger" :disabled="!editable" @click="rollbackPostpone">回退本次顺延</button>
        </div>
      </div>
      <div class="capacity-grid">
        <div v-for="location in store.locations" :key="location.id" class="capacity-item">
          <div class="capacity-head"><b>{{ location.name }}</b><span class="muted">{{ usageLabel(location) }}</span></div>
          <div class="usage-bar"><i :style="{ width: usagePercent(location) + '%' }" :class="{ over: usageOver(location) }"></i></div>
          <label class="capacity-edit">每日容量（小时）
            <input type="number" min="1" max="24" step="0.5" :value="hours(location.capacityMinutes)" :disabled="!editable" @change="applyCapacity(location.id, $event)" />
          </label>
        </div>
      </div>
      <p v-if="notice" class="notice">{{ notice }}</p>
      <div v-if="store.lastPlan" class="plan-result">
        <div class="plan-head"><b>{{ store.lastPlan.title }}</b><small class="muted">{{ dayjs(store.lastPlan.time).format("MM-DD HH:mm:ss") }}</small></div>
        <div v-if="placedEntries.length" class="plan-group ok">已排入 {{ placedEntries.length }} 场：{{ placedEntries.map((entry) => entry.code).join("、") }}</div>
        <div v-for="entry in waitlistedEntries" :key="entry.sceneId" class="plan-group wait">候补 · {{ entry.code }} {{ entry.title }} — {{ entry.reasons.join("；") }}</div>
        <div v-for="entry in pendingEntries" :key="entry.sceneId" class="plan-group pending">待排 · {{ entry.code }} {{ entry.title }} — 卡住：{{ entry.reasons.join("；") }}</div>
      </div>
    </section>
    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>新增场次</h2><button class="secondary" @click="store.saveDraft">保存离线草稿</button></div>
        <form class="form-grid" @submit.prevent="submit">
          <label class="field"><span>场次编号</span><input v-model="form.code" placeholder="C-018" /><small>{{ errors.code }}</small></label>
          <label class="field"><span>场次名称</span><input v-model="form.title" placeholder="例如：雨夜追踪" /><small>{{ errors.title }}</small></label>
          <label class="field"><span>拍摄日</span><input v-model="form.day" type="date" /></label>
          <label class="field"><span>场地</span><select v-model="form.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label class="field"><span>开始</span><input v-model="form.start" type="time" /></label>
          <label class="field"><span>结束</span><input v-model="form.end" type="time" /></label>
          <label class="field wide"><span>演员档期</span><select v-model="form.talentIds" multiple><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option></select></label>
          <label class="field wide"><span>器材借用</span><select v-model="form.equipmentIds" multiple><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label class="checkbox-field wide"><input v-model="form.mustShoot" type="checkbox" /><span>必拍场次（顺延排不进时整批退回）</span></label>
          <div class="actions wide"><button class="primary" :disabled="saving || !editable">保存为草稿</button><RouterLink class="secondary" to="/conflicts">检查冲突</RouterLink></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>通告顺序</h2><small class="muted">按拍摄日排序，拖拽调整顺序；改时段会使已确认结果失效</small></div><button class="primary" :disabled="!editable" @click="store.snapshot()">保存版本</button></div>
        <div class="scene-list">
          <article v-for="(scene,index) in store.sortedScenes" :key="scene.id" class="scene" :class="{ locked: scene.locked, dragging: dragging === index }" draggable="true" @dragstart="dragging=index" @dragover.prevent @drop="drop(index)">
            <b>{{ index + 1 }}</b>
            <div class="scene-code">{{ scene.code }}<span v-if="scene.mustShoot" class="must-badge">必拍</span></div>
            <div class="scene-title"><b>{{ scene.title }}</b><small>{{ scene.day }} {{ scene.start }}–{{ scene.end }} · {{ store.locationName(scene.locationId) }}</small></div>
            <span class="status" :class="scene.status">{{ scene.status }}</span>
            <div class="actions">
              <button class="secondary" :disabled="!editable || scene.locked || scene.status === '待排' || scene.status === '候补' || scene.status === '已完成'" @click="store.updateStatus(scene.id, currentStatus(scene.status === '草稿' ? '已确认' : scene.status === '已确认' ? '拍摄中' : scene.status === '拍摄中' ? '已完成' : '已完成'))">推进</button>
              <button class="secondary" :disabled="!editable" @click="store.toggleLock(scene.id)">{{ scene.locked ? "解锁" : "锁定" }}</button>
              <button class="secondary" :disabled="!editable || store.isStarted(scene)" @click="store.toggleMustShoot(scene.id)">{{ scene.mustShoot ? "取消必拍" : "标必拍" }}</button>
            </div>
            <div class="scene-meta wide">
              <small>演员：{{ store.talentNames(scene.talentIds).join("、") || "待定" }} · 器材：{{ store.equipmentNames(scene.equipmentIds).join("、") || "无" }}</small>
              <small v-if="scene.blockedReason" class="blocked">卡住：{{ scene.blockedReason }}</small>
              <div v-if="canEditSlot(scene)" class="slot-editor">
                <input type="date" :value="scene.day" @change="updateSlot(scene.id, 'day', $event)" />
                <input type="time" :value="scene.start" @change="updateSlot(scene.id, 'start', $event)" />
                <input type="time" :value="scene.end" @change="updateSlot(scene.id, 'end', $event)" />
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
    <section class="panel">
      <div class="panel-head"><div><h2>待排区</h2><small class="muted">排不进的场次留在这里并标明卡住的资源；已开拍场次照原样保留</small></div><span class="status">{{ pendingScenes.length }} 场未落地</span></div>
      <el-empty v-if="!pendingScenes.length" description="待排区是空的" />
      <article v-for="scene in pendingScenes" :key="scene.id" class="pending-row">
        <span class="status" :class="scene.status">{{ scene.status }}</span>
        <div>
          <b>{{ scene.code }} {{ scene.title }}</b>
          <small class="muted">　{{ scene.day }} {{ scene.start }}–{{ scene.end }} · {{ store.locationName(scene.locationId) }}</small>
          <span v-if="scene.blockedReason" class="blocked">{{ scene.blockedReason }}</span>
        </div>
        <button class="secondary" :disabled="!editable" @click="runResume">续排</button>
      </article>
    </section>
  </section>
</template>
