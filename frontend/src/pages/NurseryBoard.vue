<script setup lang="ts">
/**
 * 苗圃组模块：/nurseries 苗圃台账与回播对账
 * - 台账：苗圃编号、培育批次、可供移出量（回播按覆盖长度扣减）
 * - 对账：按苗圃编号 + 样带编号两边核对，对不上的先挂起，等苗圃组核定后只重跑本侧
 * 复用 <StatBadge>、<FilterBar>、<EmptyPanel>。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, RefreshRight } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import { useNurseryStore } from '@/stores/nurseryStore'
import { CORAL_FORMS } from '@/types/coralRecord'
import type { CoralForm } from '@/types/coralRecord'
import { NURSERY_BATCH_STATUSES } from '@/types/nursery'
import type { NurseryBatch } from '@/types/nursery'
import { OUTPLANT_STATUSES } from '@/types/outplant'
import { initDatabase } from '@/utils/db'

const nurseryStore = useNurseryStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const retryingId = ref<string | null>(null)
const retryingAll = ref(false)
const form = reactive({
  nurseryNo: '',
  batchNo: '',
  species: '',
  form: '枝状' as CoralForm,
  availableCm: 1000,
  keeper: '',
  startedAt: new Date().toISOString().slice(0, 10),
  remark: ''
})

const batchRows = computed(() => nurseryStore.filteredNurseryRows)
const ledgerRows = computed(() => nurseryStore.filteredOutplantRows)

function openCreate(): void {
  editingId.value = null
  form.nurseryNo = ''
  form.batchNo = ''
  form.species = ''
  form.form = '枝状'
  form.availableCm = 1000
  form.keeper = ''
  form.startedAt = new Date().toISOString().slice(0, 10)
  form.remark = ''
  dialogVisible.value = true
}

function openEdit(batch: NurseryBatch): void {
  editingId.value = batch.id
  form.nurseryNo = batch.nurseryNo
  form.batchNo = batch.batchNo
  form.species = batch.species
  form.form = batch.form
  form.availableCm = batch.availableCm
  form.keeper = batch.keeper
  form.startedAt = batch.startedAt
  form.remark = batch.remark
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.nurseryNo.trim()) {
    ElMessage.warning('请填写苗圃编号')
    return
  }
  if (!form.batchNo.trim()) {
    ElMessage.warning('请填写培育批次号')
    return
  }
  if (!form.species.trim()) {
    ElMessage.warning('请填写培育物种 / 属名')
    return
  }
  if (!Number.isFinite(form.availableCm) || form.availableCm < 0) {
    ElMessage.warning('可供移出量应为非负数字（cm）')
    return
  }
  const duplicate = nurseryStore.findDuplicateBatch(form.nurseryNo, form.batchNo, editingId.value ?? undefined)
  if (duplicate) {
    ElMessage.warning(`苗圃编号 + 批次号已存在（${duplicate.nurseryNo}｜${duplicate.batchNo}），请勿重复建档`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      nurseryNo: form.nurseryNo.trim(),
      batchNo: form.batchNo.trim(),
      species: form.species.trim(),
      form: form.form,
      availableCm: form.availableCm,
      keeper: form.keeper.trim(),
      startedAt: form.startedAt,
      remark: form.remark.trim()
    }
    if (editingId.value) {
      await nurseryStore.updateNursery(editingId.value, payload)
      ElMessage.success('批次台账已更新')
    } else {
      await nurseryStore.createNursery(payload)
      ElMessage.success('已登记苗圃批次与可供移出量')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeBatch(batch: NurseryBatch): Promise<void> {
  const linked = nurseryStore.outplants.filter(
    (record) => record.nurseryNo === batch.nurseryNo && record.batchNo === batch.batchNo
  )
  try {
    await ElMessageBox.confirm(
      `删除批次「${batch.nurseryNo}｜${batch.batchNo}」？${linked.length > 0 ? `该批次有 ${linked.length} 条回播对账记录，仍会保留在台账中（不影响外业）。` : ''}`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await nurseryStore.removeNursery(batch.id)
  ElMessage.success('批次已删除')
}

async function retryOne(id: string): Promise<void> {
  retryingId.value = id
  try {
    const updated = await nurseryStore.retryOutplant(id)
    if (updated.status === '已扣减') {
      ElMessage.success(`核定通过，已扣减可供移出量 ${updated.deductedCm} cm`)
    } else {
      ElMessage.warning(`仍未通过：${updated.issue || '请核对苗圃编号 / 批号 / 存量'}`)
    }
  } finally {
    retryingId.value = null
  }
}

async function retryAll(): Promise<void> {
  if (nurseryStore.suspendedCount === 0) {
    ElMessage.info('当前没有挂起记录')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将只重跑苗圃侧扣减（外业不重放），当前挂起 ${nurseryStore.suspendedCount} 条 / ${nurseryStore.suspendedCoverCm} cm。继续？`,
      '批量核定重跑',
      { type: 'warning', confirmButtonText: '重跑本侧', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  retryingAll.value = true
  try {
    const result = await nurseryStore.retryAllSuspended()
    if (result.stillSuspended === 0) ElMessage.success(`全部 ${result.resolved} 条挂起已核定扣减`)
    else ElMessage.warning(`已扣减 ${result.resolved} 条，仍有 ${result.stillSuspended} 条对不上，请继续核定`)
  } finally {
    retryingAll.value = false
  }
}

function tagType(status: string): 'success' | 'warning' {
  return status === '已扣减' ? 'success' : 'warning'
}

function availablePercent(row: { batch: NurseryBatch; deductedCm: number }): number {
  const initial = row.batch.availableCm + row.deductedCm
  if (initial <= 0) return 0
  return Math.min(100, (row.batch.availableCm / initial) * 100)
}

onMounted(() => {
  void initDatabase()
  nurseryStore.start()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">苗圃台账与回播对账</h2>
        <p class="gb-hint">
          苗圃组维护苗圃编号、培育批次与可供移出量；外业回播按覆盖长度扣减。两边按苗圃编号 + 样带编号对账，对不上的先挂起，核定后只重跑苗圃侧，外业照旧。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="RefreshRight" :loading="retryingAll" @click="retryAll">重跑全部挂起（本侧）</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">登记培育批次</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="培育批次" :value="nurseryStore.nurseries.length" suffix="批" icon="Files" />
      <StatBadge label="可供移出量合计" :value="nurseryStore.totalAvailableCm" suffix="cm" tone="success" icon="Odometer" />
      <StatBadge label="回播对账记录" :value="nurseryStore.outplants.length" suffix="条" tone="info" icon="DataLine" />
      <StatBadge
        label="挂起待核定"
        :value="nurseryStore.suspendedCount"
        suffix="条"
        :tone="nurseryStore.suspendedCount > 0 ? 'warning' : 'success'"
        icon="WarningFilled"
      />
      <StatBadge label="挂起覆盖长度" :value="nurseryStore.suspendedCoverCm" suffix="cm" tone="warning" icon="TrendCharts" />
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>培育批次台账（可供移出量）</h3>
        <FilterBar
          :model-value="{
            keyword: nurseryStore.nurseryFilter.keyword,
            statuses: nurseryStore.nurseryFilter.statuses
          }"
          :selects="[
            {
              key: 'statuses',
              label: '存量',
              options: NURSERY_BATCH_STATUSES.map((status) => ({ label: status, value: status }))
            }
          ]"
          keyword-placeholder="搜索苗圃编号 / 批次号 / 物种 / 负责人"
          @change="(model) => nurseryStore.patchNurseryFilter({ keyword: String(model.keyword ?? ''), statuses: (model.statuses as typeof NURSERY_BATCH_STATUSES) ?? [] })"
          @reset="nurseryStore.resetNurseryFilter()"
        />
      </div>

      <EmptyPanel
        v-if="batchRows.length === 0"
        title="还没有培育批次"
        description="登记苗圃编号、培育批次与可供移出量，外业回播珊瑚带批号后即按覆盖长度从对应批次扣减。"
        action-text="登记培育批次"
        @action="openCreate"
      />

      <el-table v-else :data="batchRows" border stripe class="gb-table-compact">
        <el-table-column label="苗圃编号" width="110">
          <template #default="{ row }"><span class="gb-mono">{{ row.batch.nurseryNo }}</span></template>
        </el-table-column>
        <el-table-column label="培育批次" width="130">
          <template #default="{ row }"><span class="gb-mono">{{ row.batch.batchNo }}</span></template>
        </el-table-column>
        <el-table-column prop="batch.species" label="物种 / 属名" min-width="130" />
        <el-table-column prop="batch.form" label="形态" width="90" />
        <el-table-column label="可供移出量" min-width="200">
          <template #default="{ row }">
            <span class="gb-mono" :class="{ 'gb-danger': row.exhausted }">{{ row.batch.availableCm }} cm</span>
            <el-progress :percentage="availablePercent(row)" :stroke-width="6" :show-text="false" />
            <span class="gb-hint gb-mono">已回播扣减 {{ row.deductedCm }} cm · 挂起 {{ row.suspendedCm }} cm</span>
          </template>
        </el-table-column>
        <el-table-column prop="batch.keeper" label="负责人" width="100" />
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.exhausted ? 'info' : 'success'" size="small">{{ row.exhausted ? '已扣完' : '有存量' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row.batch)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeBatch(row.batch)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>回播对账台账（苗圃编号 × 样带编号）</h3>
        <FilterBar
          :model-value="{
            keyword: nurseryStore.outplantFilter.keyword,
            statuses: nurseryStore.outplantFilter.statuses
          }"
          :selects="[
            {
              key: 'statuses',
              label: '状态',
              options: OUTPLANT_STATUSES.map((status) => ({ label: status, value: status }))
            }
          ]"
          keyword-placeholder="搜索苗圃编号 / 批号 / 样带编号 / 挂起原因"
          @change="(model) => nurseryStore.patchOutplantFilter({ keyword: String(model.keyword ?? ''), statuses: (model.statuses as typeof OUTPLANT_STATUSES) ?? [] })"
          @reset="nurseryStore.resetOutplantFilter()"
        />
      </div>

      <EmptyPanel
        v-if="ledgerRows.length === 0"
        title="暂无回播对账记录"
        description="外业在珊瑚计数页录入带批号的回播珊瑚后，这里会出现按覆盖长度扣减的对账记录。"
        compact
      />

      <el-table v-else :data="ledgerRows" border stripe class="gb-table-compact">
        <el-table-column label="苗圃编号" width="100">
          <template #default="{ row }"><span class="gb-mono">{{ row.record.nurseryNo }}</span></template>
        </el-table-column>
        <el-table-column label="批次号" width="120">
          <template #default="{ row }"><span class="gb-mono">{{ row.record.batchNo || '—' }}</span></template>
        </el-table-column>
        <el-table-column label="样带编号" width="100">
          <template #default="{ row }"><span class="gb-mono">{{ row.beltNoResolved }}</span></template>
        </el-table-column>
        <el-table-column label="回播覆盖" width="110" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.record.coverCm }} cm</span></template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="tagType(row.record.status)" size="small">{{ row.record.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="挂起原因 / 扣减" min-width="180">
          <template #default="{ row }">
            <span v-if="row.record.status === '挂起'" class="gb-danger">{{ row.record.issue }}</span>
            <span v-else class="gb-mono">已扣减 {{ row.record.deductedCm }} cm</span>
          </template>
        </el-table-column>
        <el-table-column label="经办人 / 日期" min-width="150">
          <template #default="{ row }">
            <div class="gb-mono">{{ row.surveyDateResolved }}</div>
            <div class="gb-hint">{{ row.record.observer || '未填写' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="核定操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.record.status === '挂起'"
              size="small"
              type="primary"
              :loading="retryingId === row.record.id"
              :icon="RefreshRight"
              @click="retryOne(row.record.id)"
            >
              核定重跑
            </el-button>
            <span v-else class="gb-hint">外业照旧</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

:deep(.el-progress) {
  margin: 2px 0;
}
</style>
