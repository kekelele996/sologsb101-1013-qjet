<script setup lang="ts">
/**
 * 模块 7：/nurseries 苗圃台账与回播对账
 * 苗圃组维护苗圃编号、培育批次与可供移出量；两边按苗圃编号 + 样带编号 + 批号对账。
 * 对不上的台账先挂起（pending）等核定；可供移出量不足为 failed，可只重跑本侧扣减；
 * 苗圃侧扣减 / 重跑不影响外业珊瑚记录与覆盖率（外业照旧）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, RefreshRight, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useNurseryStore } from '@/stores/nurseryStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { OUTPLANT_STATUS_LABEL, OUTPLANT_STATUSES } from '@/types/nursery'
import type { Nursery, NurseryBatchInput, OutplantStatus } from '@/types/nursery'
import type { OutplantLedger } from '@/types/outplant'
import { initDatabase } from '@/utils/db'

const nurseryStore = useNurseryStore()
const surveyStore = useSurveyStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const statusFilter = ref<OutplantStatus | ''>('')
const rerunning = ref(false)
const reconcileVisible = ref(false)
const reconcileTarget = ref<OutplantLedger | null>(null)
const reconcileForm = reactive({ nurseryId: '', batchNo: '' })

const form = reactive({
  no: '',
  name: '',
  location: '',
  keeper: '',
  remark: '',
  batches: [] as NurseryBatchInput[]
})

/** 苗圃批次台账行 */
const batchRows = computed(() => nurseryStore.batchRows)

/** 状态过滤后的台账 */
const filteredLedgers = computed(() =>
  statusFilter.value === ''
    ? nurseryStore.ledgerViews
    : nurseryStore.ledgerViews.filter((view) => view.status === statusFilter.value)
)

const stats = computed(() => {
  const totalAvailable = nurseryStore.nurseries.reduce(
    (sum, nursery) => sum + nursery.batches.reduce((sub, batch) => sub + batch.availableCm, 0),
    0
  )
  const pending = nurseryStore.ledgerStatusCounts.pending
  const failed = nurseryStore.ledgerStatusCounts.failed
  const confirmed = nurseryStore.ledgerStatusCounts.confirmed
  return { nurseryCount: nurseryStore.nurseries.length, totalAvailable, pending, failed, confirmed }
})

const statusTagType = (status: OutplantStatus): 'warning' | 'success' | 'danger' => {
  if (status === 'confirmed') return 'success'
  if (status === 'failed') return 'danger'
  return 'warning'
}

function addBatchRow(): void {
  form.batches.push({ batchNo: '', availableCm: 2000 })
}

function removeBatchRow(index: number): void {
  if (form.batches.length === 1) {
    ElMessage.warning('至少保留一个培育批次')
    return
  }
  form.batches.splice(index, 1)
}

function openCreate(): void {
  editingId.value = null
  form.no = `N-${String(nurseryStore.nurseries.length + 1).padStart(2, '0')}`
  form.name = ''
  form.location = ''
  form.keeper = ''
  form.remark = ''
  form.batches = [{ batchNo: '', availableCm: 2000 }]
  dialogVisible.value = true
}

function openEdit(nursery: Nursery): void {
  editingId.value = nursery.id
  form.no = nursery.no
  form.name = nursery.name
  form.location = nursery.location
  form.keeper = nursery.keeper
  form.remark = nursery.remark
  form.batches = nursery.batches.map((batch) => ({
    batchNo: batch.batchNo,
    availableCm: batch.initialAvailableCm
  }))
  dialogVisible.value = true
}

function validateForm(): string[] {
  const errors: string[] = []
  if (!form.no.trim()) errors.push('请填写苗圃编号')
  if (!form.name.trim()) errors.push('请填写苗圃名称')
  const seen = new Set<string>()
  form.batches.forEach((batch, index) => {
    const batchNo = batch.batchNo.trim()
    if (!batchNo) errors.push(`第 ${index + 1} 行批次号未填`)
    else if (seen.has(batchNo)) errors.push(`批次号 ${batchNo} 重复`)
    else seen.add(batchNo)
    if (!Number.isFinite(batch.availableCm) || batch.availableCm < 0) {
      errors.push(`批次 ${batchNo || index + 1} 的可供移出量应为非负数字`)
    }
  })
  const duplicated = nurseryStore.nurseries.some(
    (nursery) => nursery.no === form.no.trim() && nursery.id !== editingId.value
  )
  if (duplicated) errors.push(`苗圃编号 ${form.no.trim()} 已存在`)
  return errors
}

async function submitForm(): Promise<void> {
  const errors = validateForm()
  if (errors.length > 0) {
    ElMessage.warning(errors[0])
    return
  }
  submitting.value = true
  try {
    const batches: Nursery['batches'] = form.batches.map((batch) => ({
      batchNo: batch.batchNo.trim(),
      initialAvailableCm: batch.availableCm,
      availableCm: batch.availableCm
    }))
    const payload = {
      no: form.no.trim(),
      name: form.name.trim(),
      location: form.location.trim(),
      keeper: form.keeper.trim(),
      remark: form.remark.trim(),
      batches
    }
    if (editingId.value) {
      // 编辑时保留既有批次的可供移出量（由 confirmed 台账扣减得出），新批次才用录入值
      const existing = nurseryStore.nurseryById(editingId.value)
      const merged = nurseryStore.mergeBatches(existing?.batches ?? [], form.batches)
      await nurseryStore.updateNursery(editingId.value, { ...payload, batches: merged })
      ElMessage.success('苗圃已更新，已重跑本侧回播扣减')
      await nurseryStore.settleAll()
    } else {
      await nurseryStore.createNursery(payload)
      ElMessage.success('苗圃与批次已建立，可供移出量可用于回播对账')
      await nurseryStore.settleAll()
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeNursery(nursery: Nursery): Promise<void> {
  const ledgerCount = nurseryStore.ledgers.filter((ledger) => ledger.nurseryId === nursery.id).length
  try {
    await ElMessageBox.confirm(
      `删除苗圃「${nursery.no} ${nursery.name}」将同时删除其 ${ledgerCount} 条回播对账台账（外业珊瑚记录保留并转为挂起）。确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await nurseryStore.removeNursery(nursery.id)
  await nurseryStore.settleAll()
  ElMessage.success('苗圃及其台账已删除')
}

/** 重跑本侧扣减（失败 / 挂起台账核定后调用）；外业数据不动 */
async function rerunSettlement(): Promise<void> {
  rerunning.value = true
  try {
    const result = await nurseryStore.settleAll()
    ElMessage.success(
      `本侧重跑完成：已对账 ${result.confirmed} 条、挂起 ${result.pending} 条、扣减失败 ${result.failed} 条`
    )
  } finally {
    rerunning.value = false
  }
}

function openReconcile(ledger: OutplantLedger): void {
  reconcileTarget.value = ledger
  reconcileForm.nurseryId = ledger.nurseryId
  reconcileForm.batchNo = ledger.batchNo
  reconcileVisible.value = true
}

const reconcileBatchOptions = computed(() => {
  const nursery = nurseryStore.nurseryById(reconcileForm.nurseryId)
  return (nursery?.batches ?? []).map((batch) => ({
    value: batch.batchNo,
    label: `${batch.batchNo}（可供 ${batch.availableCm} cm）`
  }))
})

async function submitReconcile(): Promise<void> {
  if (!reconcileTarget.value) return
  if (!reconcileForm.nurseryId) {
    ElMessage.warning('请选择苗圃编号')
    return
  }
  if (!reconcileForm.batchNo.trim()) {
    ElMessage.warning('请填写或选择培育批次号')
    return
  }
  try {
    await nurseryStore.reconcileLedger(
      reconcileTarget.value.id,
      reconcileForm.nurseryId,
      reconcileForm.batchNo.trim()
    )
    ElMessage.success('已按核定的苗圃 / 批号重跑本侧扣减')
    reconcileVisible.value = false
    reconcileTarget.value = null
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '核定失败')
  }
}

onMounted(() => {
  if (surveyStore.corals.length === 0 && nurseryStore.nurseries.length === 0) void initDatabase()
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
          苗圃组管苗圃编号、培育批次与可供移出量；回播珊瑚带批号才进礁区覆盖率，白化指数仍只按自然珊瑚算。
          两边按苗圃编号 + 样带编号 + 批号对账：对不上先挂起等核定，可供量不足为扣减失败（只重跑本侧，外业照旧）。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="RefreshRight" :loading="rerunning" @click="rerunSettlement">重跑本侧扣减</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建苗圃 / 批次</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="苗圃数" :value="stats.nurseryCount" suffix="个" icon="Grid" />
      <StatBadge label="可供移出量" :value="stats.totalAvailable" suffix="cm" tone="success" icon="Odometer" />
      <StatBadge label="已对账" :value="stats.confirmed" suffix="条" tone="primary" icon="CircleCheck" />
      <StatBadge label="挂起待核定" :value="stats.pending" suffix="条" tone="warning" icon="Clock" />
      <StatBadge label="扣减失败" :value="stats.failed" suffix="条" tone="danger" icon="WarningFilled" />
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>培育批次与可供移出量</h3>
        <span class="gb-hint">可供移出量 = 初始量 − 已对账回播覆盖长度（cm）</span>
      </div>
      <EmptyPanel
        v-if="batchRows.length === 0"
        title="还没有苗圃与批次"
        description="新建苗圃并登记培育批次与可供移出量，随后外业录入回播珊瑚时即可挂批号对账。"
        action-text="新建苗圃 / 批次"
        @action="openCreate"
      />
      <el-table v-else :data="batchRows" border stripe class="gb-table-compact">
        <el-table-column prop="nurseryNo" label="苗圃编号" width="110" />
        <el-table-column prop="nurseryName" label="苗圃名称" min-width="160" />
        <el-table-column prop="batchNo" label="培育批次" width="120">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.batchNo }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="初始可供量" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.initialAvailableCm }} cm</span>
          </template>
        </el-table-column>
        <el-table-column label="已扣减（回播）" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.deductedCm }} cm</span>
            <div class="gb-hint gb-mono">{{ row.coralCount }} 条已对账</div>
          </template>
        </el-table-column>
        <el-table-column label="当前可供移出量" width="160" align="right">
          <template #default="{ row }">
            <span class="gb-mono" :class="{ 'gb-danger': row.availableCm <= 0 }">{{ row.availableCm }} cm</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              :icon="Edit"
              @click="openEdit(nurseryStore.nurseryById(row.nurseryId)!)"
            >
              编辑
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              :icon="Delete"
              @click="removeNursery(nurseryStore.nurseryById(row.nurseryId)!)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>回播对账台账（{{ filteredLedgers.length }} 条）</h3>
        <el-radio-group v-model="statusFilter" size="small">
          <el-radio-button value="">全部</el-radio-button>
          <el-radio-button v-for="status in OUTPLANT_STATUSES" :key="status" :value="status">
            {{ OUTPLANT_STATUS_LABEL[status] }}
          </el-radio-button>
        </el-radio-group>
      </div>

      <EmptyPanel
        v-if="filteredLedgers.length === 0"
        title="没有对应状态的对账记录"
        description="外业在珊瑚计数页录入带回播批号的珊瑚后，这里会按苗圃编号 + 样带编号 + 批号生成对账台账。"
        compact
      />

      <el-table v-else :data="filteredLedgers" border stripe class="gb-table-compact">
        <el-table-column label="苗圃 / 批号" min-width="170">
          <template #default="{ row }">
            <div>{{ row.nurseryName }}</div>
            <div class="gb-hint">苗圃 {{ row.nurseryNo }} · 批次 {{ row.batchNo }}</div>
          </template>
        </el-table-column>
        <el-table-column label="样带编号" width="120">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.beltNo }}</span>
          </template>
        </el-table-column>
        <el-table-column label="回播覆盖长度" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coverCmTotal }} cm</span>
            <div class="gb-hint gb-mono">{{ row.coralCount }} 条</div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status as OutplantStatus)" size="small" effect="light">
              {{ OUTPLANT_STATUS_LABEL[row.status as OutplantStatus] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="原因 / 说明" min-width="240" show-overflow-tooltip />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status !== 'confirmed'"
              size="small"
              type="warning"
              plain
              :icon="Warning"
              @click="openReconcile(row.ledger)"
            >
              核定
            </el-button>
            <span v-else class="gb-hint">已扣减可供量</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑苗圃与批次' : '新建苗圃与培育批次'"
      width="620px"
      :close-on-click-modal="false"
    >
      <el-form label-width="110px">
        <el-form-item label="苗圃编号" required>
          <el-input v-model="form.no" placeholder="如：N-01" maxlength="20" />
        </el-form-item>
        <el-form-item label="苗圃名称" required>
          <el-input v-model="form.name" placeholder="如：清澜湾陆上苗圃" maxlength="40" />
        </el-form-item>
        <el-form-item label="位置">
          <el-input v-model="form.location" placeholder="如：文昌清澜港北岸育苗车间" maxlength="60" />
        </el-form-item>
        <el-form-item label="负责人">
          <el-input v-model="form.keeper" placeholder="苗圃组负责人" maxlength="20" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" placeholder="如：鹿角珊瑚断枝培育为主" maxlength="60" />
        </el-form-item>
        <el-form-item label="培育批次" required>
          <div class="page__batches">
            <div v-for="(batch, index) in form.batches" :key="index" class="page__batch-row">
              <el-input v-model="batch.batchNo" placeholder="批号，如 2026-A" maxlength="20" />
              <el-input-number v-model="batch.availableCm" :min="0" :step="100" controls-position="right" />
              <span class="page__unit">cm 可供移出</span>
              <el-button type="danger" plain :icon="Delete" circle @click="removeBatchRow(index)" />
            </div>
            <el-button size="small" :icon="Plus" @click="addBatchRow">增加批次</el-button>
            <p class="gb-hint">
              填写的是该批次可供移出的计划容量（初始量）；保存后自动按已对账回播重算当前可供移出量，
              调大容量可让「扣减失败」台账在重跑本侧后转为已对账。
            </p>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存并重跑扣减' : '建立苗圃' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="reconcileVisible" title="核定挂起 / 失败的回播台账" width="520px">
      <p class="gb-hint" v-if="reconcileTarget">
        样带 {{ reconcileTarget.beltNo }} 的回播记录当前批号为「{{ reconcileTarget.batchNo }}」、回播覆盖
        {{ reconcileTarget.coverCmTotal }} cm。由苗圃组选定正确的苗圃编号与批号后，仅重跑本侧扣减（不改外业覆盖长度）。
      </p>
      <el-form label-width="100px">
        <el-form-item label="苗圃编号" required>
          <el-select v-model="reconcileForm.nurseryId" placeholder="选择苗圃" filterable style="width: 100%">
            <el-option
              v-for="nursery in nurseryStore.nurseries"
              :key="nursery.id"
              :label="`${nursery.no} ${nursery.name}`"
              :value="nursery.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="培育批次" required>
          <el-select v-model="reconcileForm.batchNo" placeholder="选择已有批次" filterable style="width: 100%">
            <el-option
              v-for="option in reconcileBatchOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reconcileVisible = false">取消</el-button>
        <el-button type="primary" @click="submitReconcile">核定并重跑本侧</el-button>
      </template>
    </el-dialog>
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

.page__batches {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.page__batch-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.page__unit {
  font-size: 12px;
  color: #7c9995;
  white-space: nowrap;
}
</style>
