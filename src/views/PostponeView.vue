<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import dayjs from "dayjs";
import { ElMessage, ElMessageBox } from "element-plus";
import { useScheduleStore } from "../stores/schedule";
import type { PostponeRevision, PostponeStatus, Scene } from "../types";

const store = useScheduleStore();

const form = reactive({ fromDay: "", toDay: "" });
const running = ref(false);

const editable = computed(() => store.role === "制片" || store.role === "导演");

const defaultFrom = computed(() => store.scheduledDays[0] ?? dayjs().format("YYYY-MM-DD"));

function ensureDefaults() {
  if (!form.fromDay) form.fromDay = defaultFrom.value;
  if (!form.toDay) form.toDay = dayjs(form.fromDay).add(1, "day").format("YYYY-MM-DD");
}
ensureDefaults();

function sceneById(id: string): Scene | undefined {
  return store.scenes.find((item) => item.id === id);
}

function statusType(status: PostponeStatus): string {
  switch (status) {
    case "已完成": return "success";
    case "已回退": return "info";
    case "整批退回": return "danger";
    case "已失效": return "warning";
  }
}

async function runPostpone() {
  if (!editable.value) return;
  if (!form.fromDay || !form.toDay) {
    ElMessage.warning("请选择顺延的起止日期");
    return;
  }
  if (form.fromDay === form.toDay) {
    ElMessage.warning("顺延日期不能与原拍摄日相同");
    return;
  }
  running.value = true;
  const result = store.postpone(form.fromDay, form.toDay);
  running.value = false;
  if (result.ok) {
    ElMessage.success(result.revision.note);
  } else {
    ElMessage.error(result.revision.note);
  }
}

async function rollback(item: PostponeRevision) {
  try {
    await ElMessageBox.confirm(`回退将恢复 ${item.fromDay} 顺延前的全部场次与资源占用，确认回退？`, "回退顺延", { type: "warning" });
  } catch {
    return;
  }
  store.rollbackPostpone(item.id);
  ElMessage.info("已回退到顺延前快照");
}

function retry(item: PostponeRevision) {
  const result = store.retryPostpone(item.id);
  if (result.ok) {
    ElMessage.success(result.revision?.note ?? "续排完成");
  } else {
    ElMessage.error(result.revision?.note ?? "续排失败");
  }
}

function retryScene(scene: Scene) {
  if (!scene.postponeBatchId) return;
  const result = store.retryPostpone(scene.postponeBatchId);
  if (result.ok) {
    ElMessage.success(result.revision?.note ?? "续排完成");
  } else {
    ElMessage.error(result.revision?.note ?? "续排失败");
  }
}

async function changeSceneTime(scene: Scene) {
  try {
    const { value } = await ElMessageBox.prompt(`调整 ${scene.code} 的拍摄日（格式 YYYY-MM-DD）`, "改期", {
      inputValue: scene.day,
      inputPattern: /^\d{4}-\d{2}-\d{2}$/,
      inputErrorMessage: "请输入正确的日期格式"
    });
    const day = value as string;
    const start = await ElMessageBox.prompt(`调整 ${scene.code} 的开始时间（HH:mm）`, "改期", {
      inputValue: scene.start,
      inputPattern: /^\d{2}:\d{2}$/,
      inputErrorMessage: "请输入正确的时间格式"
    });
    const end = await ElMessageBox.prompt(`调整 ${scene.code} 的结束时间（HH:mm）`, "改期", {
      inputValue: scene.end,
      inputPattern: /^\d{2}:\d{2}$/,
      inputErrorMessage: "请输入正确的时间格式"
    });
    store.updateSceneTime(scene.id, day, start.value as string, end.value as string);
    ElMessage.success("时段已更新，相关顺延结果已失效重算");
  } catch {
    /* 用户取消 */
  }
}

function setCapacity(locationId: string, event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value)) store.updateLocationCapacity(locationId, value);
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article class="metric"><span>待排场次</span><strong>{{ store.pendingScenes.length }}</strong></article>
      <article class="metric"><span>顺延批次</span><strong>{{ store.postpones.length }}</strong></article>
      <article class="metric"><span>已落地</span><strong>{{ store.postpones.reduce((n, r) => n + r.result.landed.length, 0) }}</strong></article>
      <article class="metric"><span>候补</span><strong>{{ store.postpones.reduce((n, r) => n + r.result.waitlisted.length, 0) }}</strong></article>
    </div>

    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><div><h2>天气顺延</h2><small class="muted">天气停摆后把未拍完的场次顺延到后续拍摄日，一次顺延是可回退的改版</small></div></div>
        <div class="postpone-form">
          <label class="field"><span>停摆拍摄日</span>
            <select v-model="form.fromDay">
              <option v-for="day in store.scheduledDays" :key="day" :value="day">{{ day }}（{{ store.scenes.filter(s => s.day === day).length }} 场）</option>
            </select>
          </label>
          <label class="field"><span>顺延到</span><input v-model="form.toDay" type="date" /></label>
          <div class="actions wide"><button class="primary" :disabled="running || !editable" @click="runPostpone">{{ running ? "顺延中…" : "执行顺延" }}</button></div>
        </div>
        <p class="muted postpone-hint">顺延会重新占用演员、场地、器材；同一天同一资源不重叠，换场留出 30 分钟转场间隔；场地容量排满后先候补再拒绝。已开拍的场次原样保留，必拍场次排不进整批退回。</p>
      </section>

      <section class="panel">
        <div class="panel-head"><div><h2>场地容量</h2><small class="muted">调整每日可排场次，已确认的顺延结果会失效重算</small></div></div>
        <div class="capacity-list">
          <div v-for="loc in store.locations" :key="loc.id" class="capacity-row">
            <span>{{ loc.name }}</span>
            <label class="field inline"><span>每日容量</span>
              <input type="number" min="1" max="20" :value="loc.dailyCapacity" :disabled="!editable" @change="setCapacity(loc.id, $event)" />
            </label>
          </div>
        </div>
      </section>
    </div>

    <section class="panel">
      <div class="panel-head"><div><h2>待排区</h2><small class="muted">顺延未落地的场次，已开拍的不在此列；卡住的资源逐项写明</small></div><span class="status">{{ store.pendingScenes.length }} 场待排</span></div>
      <el-empty v-if="!store.pendingScenes.length" description="待排区为空" />
      <article v-for="scene in store.pendingScenes" :key="scene.id" class="pending-scene">
        <div class="pending-main">
          <b>{{ scene.code }}</b>
          <div><b>{{ scene.title }}</b><small>{{ scene.originalDay ?? scene.day }} · {{ scene.start }}–{{ scene.end }} · {{ store.locationName(scene.locationId) }}</small></div>
          <span v-if="scene.mustShoot" class="tag must">必拍</span>
          <span v-if="scene.waitlisted" class="tag wait">候补</span>
        </div>
        <ul class="blocked-list">
          <li v-for="(item, idx) in scene.blockedBy" :key="idx">{{ item }}</li>
        </ul>
        <div class="actions">
          <button class="secondary" :disabled="!editable" @click="retryScene(scene)">续排</button>
          <button class="secondary" :disabled="!editable" @click="changeSceneTime(scene)">改期</button>
        </div>
      </article>
    </section>

    <section class="panel">
      <div class="panel-head"><div><h2>顺延记录</h2><small class="muted">每次顺延保留快照，可回退到顺延前；失效或整批退回的批次可续排</small></div></div>
      <el-empty v-if="!store.postpones.length" description="暂无顺延记录" />
      <article v-for="item in store.postpones" :key="item.id" class="revision">
        <div class="revision-head">
          <b>{{ item.fromDay }} → {{ item.toDay }}</b>
          <el-tag :type="statusType(item.status)" size="small">{{ item.status }}</el-tag>
          <small class="muted">{{ dayjs(item.createdAt).format("MM-DD HH:mm") }}</small>
        </div>
        <p class="revision-note">{{ item.note }}</p>
        <div class="revision-result">
          <span class="chip landed">落地 {{ item.result.landed.length }}</span>
          <span class="chip wait">候补 {{ item.result.waitlisted.length }}</span>
          <span class="chip rejected">待排 {{ item.result.rejected.length }}</span>
        </div>
        <div class="revision-scenes">
          <span v-for="id in item.sceneIds" :key="id" class="scene-chip">{{ sceneById(id)?.code ?? id }}</span>
        </div>
        <div class="actions">
          <button v-if="item.status === '已完成'" class="secondary" :disabled="!editable" @click="rollback(item)">回退</button>
          <button v-if="item.status === '已失效' || item.status === '整批退回'" class="primary" :disabled="!editable" @click="retry(item)">续排</button>
        </div>
      </article>
    </section>
  </section>
</template>
