<script setup lang="ts">
/**
 * 模块 4：/belts/:id/corals 底质与珊瑚分类计数
 * 按属名与形态分组录入，同一样带叠加多条记录并汇总覆盖率与白化占比；
 * 支持批量粘贴与批量改白化等级，深链访问时样带不存在给出友好空态。
 * 复用 <BleachTag>、<StatBadge>。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, DocumentCopy, Edit, Plus } from '@element-plus/icons-vue'
import BleachTag from '@/components/common/BleachTag.vue'
import SourceTag from '@/components/common/SourceTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useNurseryStore } from '@/stores/nurseryStore'
import {
  BLEACH_LEVELS,
  COMMON_GENERA,
  CORAL_FORMS,
  CORAL_SOURCES,
  CORAL_SOURCE_LABEL,
  isOutplant,
  parseCoralPaste
} from '@/types/coralRecord'
import type { BleachLevel, CoralForm, CoralRecord, CoralSource } from '@/types/coralRecord'
import { BLEACH_BG, BLEACH_COLOR, bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, coralsInCoverage, groupByForm, groupByGenus, naturalCoralsOnly } from '@/utils/bleach'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()
const nurseryStore = useNurseryStore()

const beltId = computed(() => String(route.params.id ?? ''))
const belt = computed(() => beltStore.beltById(beltId.value))
const site = computed(() => (belt.value ? reefStore.siteById(belt.value.siteId) : null))
const reef = computed(() => (site.value ? reefStore.reefById(site.value.reefId) : null))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const pasteVisible = ref(false)
const pasteText = ref('')
const pasteErrors = ref<string[]>([])
const selectedIds = ref<string[]>([])
const form = reactive({
  genus: '',
  form: '枝状' as CoralForm,
  coverCm: 100,
  bleachLevel: '无' as BleachLevel,
  remark: '',
  source: 'natural' as CoralSource,
  nurseryId: '',
  batchNo: ''
})

const records = computed(() => surveyStore.coralsOfBelt(beltId.value))

/** 可选苗圃（录入回播记录时挂批号） */
const nurseryOptions = computed(() =>
  nurseryStore.nurseries.map((nursery) => ({
    value: nursery.id,
    label: `${nursery.no} ${nursery.name}`
  }))
)

/** 当前选中苗圃的可选批号 */
const batchOptions = computed(() => {
  const nursery = nurseryStore.nurseryById(form.nurseryId)
  return (nursery?.batches ?? []).map((batch) => ({
    value: batch.batchNo,
    label: `${batch.batchNo}（可供 ${batch.availableCm} cm）`,
    availableCm: batch.availableCm
  }))
})

/** 进覆盖率的记录：自然珊瑚 + 批号在苗圃台账中存在的移栽珊瑚 */
const coverageRecords = computed(() =>
  coralsInCoverage(
    records.value,
    (nurseryId) => nurseryStore.nurseryById(nurseryId) ?? undefined
  )
)
/** 白化评定只按自然珊瑚 */
const naturalRecords = computed(() => naturalCoralsOnly(records.value))
/** 未挂上批号的移栽记录（挂起、不进覆盖率） */
const unmatchedRecords = computed(() =>
  records.value.filter((coral) => coral.source === 'nursery' && !isOutplant(coral))
)

function nurseryNoOf(record: CoralRecord): string {
  return nurseryStore.nurseryById(record.nurseryId)?.no ?? record.nurseryId
}

/** 某条移栽记录的挂起原因（对应苗圃台账） */
function pendingReason(record: CoralRecord): string {
  if (!isOutplant(record)) {
    if (!record.nurseryId) return '未挂苗圃，等苗圃组核定'
    const nursery = nurseryStore.nurseryById(record.nurseryId)
    if (!nursery) return '苗圃不存在，等苗圃组核定'
    if (!record.batchNo) return '未带批号，等苗圃组核定'
    if (!nursery.batches.some((batch) => batch.batchNo === record.batchNo)) {
      return `批号 ${record.batchNo} 在苗圃 ${nursery.no} 不存在`
    }
  }
  return ''
}

/** 按属名分组汇总（覆盖率口径） */
const genusGroups = computed(() =>
  groupByGenus(coverageRecords.value).map((group) => {
    const list = coverageRecords.value.filter((record) => record.genus === group.genus)
    const index = bleachIndex(naturalCoralsOnly(list))
    return { ...group, count: list.length, bleachIndex: index, grade: bleachGrade(index) }
  })
)

/** 按形态分组汇总（覆盖率口径） */
const formGroups = computed(() => groupByForm(coverageRecords.value))

const stats = computed(() => {
  const list = coverageRecords.value
  const naturalList = naturalRecords.value
  const coverCmTotal = list.reduce((sum, record) => sum + record.coverCm, 0)
  const outplantCm = list
    .filter((record) => record.source === 'nursery')
    .reduce((sum, record) => sum + record.coverCm, 0)
  const index = bleachIndex(naturalList)
  return {
    coralCount: records.value.length,
    coverCmTotal,
    outplantCm,
    coveragePct: belt.value ? coralCoveragePct(coverCmTotal, belt.value.lengthM) : 0,
    bleachIndex: index,
    grade: bleachGrade(index),
    bleachedSharePct: bleachedSharePct(naturalList),
    maxCoverCm: list.length ? Math.max(...list.map((record) => record.coverCm)) : 0
  }
})

/** 白化等级 → 累计覆盖长度（只按自然珊瑚） */
const distribution = computed<Record<BleachLevel, number>>(() => {
  const result: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
  BLEACH_LEVELS.forEach((level) => {
    result[level] = naturalRecords.value
      .filter((record) => record.bleachLevel === level)
      .reduce((sum, record) => sum + record.coverCm, 0)
  })
  return result
})

/** 进度条宽度（%），总量为 0 时返回 0% */
function barPercent(value: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0%'
  return `${Math.min(100, (value / total) * 100).toFixed(1)}%`
}

function openCreate(): void {
  editingId.value = null
  form.genus = ''
  form.form = '枝状'
  form.coverCm = 100
  form.bleachLevel = '无'
  form.remark = ''
  form.source = 'natural'
  form.nurseryId = nurseryStore.nurseries[0]?.id ?? ''
  form.batchNo = ''
  dialogVisible.value = true
}

function openEdit(record: CoralRecord): void {
  editingId.value = record.id
  form.genus = record.genus
  form.form = record.form
  form.coverCm = record.coverCm
  form.bleachLevel = record.bleachLevel
  form.remark = record.remark
  form.source = record.source
  form.nurseryId = record.nurseryId
  form.batchNo = record.batchNo
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.genus.trim()) {
    ElMessage.warning('请填写属名')
    return
  }
  if (!Number.isFinite(form.coverCm) || form.coverCm < 0) {
    ElMessage.warning('覆盖长度应为非负数字（cm）')
    return
  }
  if (belt.value && form.coverCm > belt.value.lengthM * 100) {
    ElMessage.warning(`覆盖长度不应超过样带长度（${belt.value.lengthM * 100} cm）`)
    return
  }
  // 回播记录必须挂上苗圃编号与批号才进礁区覆盖率；挂不上也允许保存，先挂起等苗圃组核定
  if (form.source === 'nursery' && (!form.nurseryId || !form.batchNo.trim())) {
    try {
      await ElMessageBox.confirm(
        '回播珊瑚未挂齐「苗圃 + 批号」，该记录将先挂起（不计入覆盖率、不扣减可供移出量），等苗圃组核定。仍要保存？',
        '回播批号不完整',
        { type: 'warning', confirmButtonText: '先挂起保存', cancelButtonText: '返回补全' }
      )
    } catch {
      return
    }
  }
  submitting.value = true
  try {
    const payload = {
      genus: form.genus.trim(),
      form: form.form,
      coverCm: form.coverCm,
      bleachLevel: form.bleachLevel,
      remark: form.remark.trim(),
      source: form.source,
      nurseryId: form.source === 'nursery' ? form.nurseryId : '',
      batchNo: form.source === 'nursery' ? form.batchNo.trim() : ''
    }
    if (editingId.value) {
      await surveyStore.updateCoral(editingId.value, payload)
      ElMessage.success('珊瑚记录已更新')
    } else {
      await surveyStore.createCoral(beltId.value, payload)
      if (payload.source === 'nursery' && payload.nurseryId && payload.batchNo) {
        ElMessage.success('回播记录已录入：带批号进礁区覆盖率，苗圃组按覆盖长度扣减可供移出量')
      } else if (payload.source === 'nursery') {
        ElMessage.warning('回播记录已挂起，等苗圃组核定')
      } else {
        ElMessage.success('珊瑚记录已新增，覆盖率与白化占比已重算')
      }
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeRecord(record: CoralRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除「${record.genus}（${record.form}）」覆盖 ${record.coverCm} cm 的记录？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await surveyStore.removeCoral(record.id)
  selectedIds.value = selectedIds.value.filter((id) => id !== record.id)
  ElMessage.success('珊瑚记录已删除')
}

function toggleSelect(id: string): void {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function toggleSelectAll(): void {
  selectedIds.value =
    selectedIds.value.length === records.value.length ? [] : records.value.map((record) => record.id)
}

async function bulkSetLevel(level: BleachLevel): Promise<void> {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选要批量改级的记录')
    return
  }
  const count = await surveyStore.bulkSetBleachLevel(selectedIds.value, level)
  ElMessage.success(`已批量将 ${count} 条记录的白化等级改为「${level}」`)
  selectedIds.value = []
}

function openPaste(): void {
  pasteText.value = ''
  pasteErrors.value = []
  pasteVisible.value = true
}

function previewPaste(): void {
  const parsed = parseCoralPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0 && parsed.errors.length === 0) {
    ElMessage.warning('请先粘贴内容，每行格式「属名,形态,覆盖长度[,白化等级]」')
  }
}

async function importPaste(): Promise<void> {
  const parsed = parseCoralPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0) {
    ElMessage.warning('没有可导入的有效行')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将用 ${parsed.rows.length} 行数据覆盖该样带现有 ${records.value.length} 条珊瑚记录，确认导入？`,
      '批量导入确认',
      { type: 'warning', confirmButtonText: '覆盖导入', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const count = await surveyStore.importCoralRows(beltId.value, parsed.rows)
  pasteVisible.value = false
  ElMessage.success(`已导入 ${count} 条珊瑚记录`)
}

function gotoFishes(): void {
  void router.push(`/belts/${beltId.value}/fishes`)
}

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
  nurseryStore.start()
  if (belt.value) beltStore.selectBelt(belt.value.id)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!beltStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!belt"
      entity-label="样带"
      :missing-id="beltId"
      fallback-path="/reefs"
      fallback-text="返回礁区台账"
      :candidates="
        beltStore.belts.slice(0, 3).map((item) => ({
          id: item.id,
          label: `样带 ${item.no} 的珊瑚记录`,
          path: `/belts/${item.id}/corals`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/reefs' }">礁区台账</el-breadcrumb-item>
            <el-breadcrumb-item v-if="reef" :to="{ path: `/reefs/${reef.id}/sites` }">{{ reef.name }} 站位</el-breadcrumb-item>
            <el-breadcrumb-item v-if="site" :to="{ path: `/sites/${site.id}/belts` }">站位 {{ site.no }} 样带</el-breadcrumb-item>
            <el-breadcrumb-item>珊瑚分类计数</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            样带 {{ belt.no }} · 底质与珊瑚分类计数
            <el-tag size="small" effect="plain">{{ belt.orientation }}向</el-tag>
            <el-tag size="small" type="info" effect="plain">长 {{ belt.lengthM }} m</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ belt.surveyDate }}</el-tag>
          </h2>
          <p class="gb-hint">
            自然珊瑚按属名与形态逐条录入；带「苗圃编号 + 批号」的回播珊瑚计入覆盖率，但白化指数仍只按自然珊瑚算。未挂齐批号的回播先挂起，等苗圃组核定。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="DocumentCopy" @click="openPaste">批量粘贴</el-button>
          <el-button @click="gotoFishes">鱼类计数 →</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增珊瑚记录</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="珊瑚记录" :value="stats.coralCount" suffix="条" icon="Histogram" />
        <StatBadge label="覆盖长度合计" :value="stats.coverCmTotal" suffix="cm" tone="info" icon="Odometer" />
        <StatBadge label="其中回播" :value="stats.outplantCm" suffix="cm" tone="primary" icon="Position" />
        <StatBadge label="珊瑚覆盖率" :value="stats.coveragePct" suffix="%" :percent="Math.min(100, stats.coveragePct)" tone="success" icon="PieChart" />
        <StatBadge
          label="白化指数（自然）"
          :value="stats.bleachIndex"
          suffix="/ 4"
          :tone="stats.bleachIndex > 1 ? 'warning' : 'success'"
          :icon="stats.bleachIndex > 1 ? 'WarningFilled' : 'DataLine'"
        />
        <StatBadge label="白化占比（自然）" :value="stats.bleachedSharePct" suffix="%" tone="warning" icon="TrendCharts" />
      </div>

      <el-alert
        v-if="unmatchedRecords.length > 0"
        type="warning"
        show-icon
        :closable="false"
        :title="`有 ${unmatchedRecords.length} 条回播记录未挂齐苗圃 / 批号，已挂起（不计入覆盖率），请到苗圃台账页由苗圃组核定。`"
      />

      <el-card v-if="records.length > 0" shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>汇总视图</h3>
          <div class="page__bulk">
            <span class="gb-hint">批量改白化等级：</span>
            <el-button v-for="level in BLEACH_LEVELS" :key="level" size="small" @click="bulkSetLevel(level)">
              {{ level }}
            </el-button>
          </div>
        </div>
        <div class="page__grid">
          <div>
            <h4 class="page__sub">按属名分组（覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="group in genusGroups" :key="group.genus" class="gb-bar">
                <span>{{ group.genus }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: '#0b5d5a', width: barPercent(group.coverCm, stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">
                  {{ group.coverCm }} cm · {{ group.count }} 条
                  <BleachTag :level="group.grade" size="small" :plain="true" />
                </span>
              </div>
            </div>
          </div>
          <div>
            <h4 class="page__sub">按形态分组（覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="group in formGroups" :key="group.form" class="gb-bar">
                <span>{{ group.form }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: '#3f9ec4', width: barPercent(group.coverCm, stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">{{ group.coverCm }} cm</span>
              </div>
            </div>
          </div>
          <div>
            <h4 class="page__sub">白化等级分布（覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="level in BLEACH_LEVELS" :key="`bar-${level}`" class="gb-bar">
                <span>{{ level }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: BLEACH_COLOR[level], width: barPercent(distribution[level], stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">{{ distribution[level] }} cm</span>
              </div>
            </div>
          </div>
        </div>
      </el-card>

      <EmptyPanel
        v-if="records.length === 0"
        title="该样带还没有珊瑚记录"
        description="按属名与形态逐条录入覆盖长度与白化等级；也可以批量粘贴导入整段摸底数据。"
        action-text="新增珊瑚记录"
        secondary-text="批量粘贴导入"
        @action="openCreate"
        @secondary="openPaste"
      />

      <el-table v-else :data="records" border stripe class="gb-table-compact">
        <el-table-column label="选择" width="70" align="center">
          <template #default="{ row }">
            <el-checkbox :model-value="selectedIds.includes(row.id)" @change="() => toggleSelect(row.id)" />
          </template>
        </el-table-column>
        <el-table-column prop="genus" label="属名" min-width="130" />
        <el-table-column prop="form" label="形态" width="90" />
        <el-table-column label="来源 / 批号" width="150">
          <template #default="{ row }">
            <SourceTag
              :source="row.source"
              :batch-no="row.batchNo"
              :nursery-no="nurseryNoOf(row)"
              :pending="row.source === 'nursery' && !isOutplant(row)"
              size="small"
            />
            <div v-if="row.source === 'nursery' && !isOutplant(row)" class="gb-hint gb-danger">
              {{ pendingReason(row) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="覆盖长度 (cm)" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coverCm }}</span>
            <div class="gb-hint gb-mono">
              占样带 {{ belt.lengthM > 0 ? ((row.coverCm / (belt.lengthM * 100)) * 100).toFixed(1) : '0.0' }}%
            </div>
          </template>
        </el-table-column>
        <el-table-column label="白化等级" width="150">
          <template #default="{ row }">
            <BleachTag :level="row.bleachLevel" size="small" :plain="true" />
            <div v-if="row.source === 'nursery'" class="gb-hint">回播不参与白化指数</div>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRecord(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无珊瑚记录" description="点击右上角「新增珊瑚记录」开始录入。" compact />
        </template>
      </el-table>

      <p v-if="records.length > 0" class="gb-hint">
          <el-button size="small" text type="primary" @click="toggleSelectAll">
            {selectedIds.length === records.length ? '取消全选' : '全选本页'}
          </el-button>
        已选 {{ selectedIds.length }} 条；最大单条覆盖长度 {{ stats.maxCoverCm }} cm。
      </p>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑珊瑚记录' : '新增珊瑚记录'" width="560px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="来源" required>
          <el-radio-group v-model="form.source">
            <el-radio-button v-for="src in CORAL_SOURCES" :key="src" :value="src">
              {{ CORAL_SOURCE_LABEL[src] }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="属名" required>
          <el-input v-model="form.genus" list="genus-options" placeholder="如：鹿角珊瑚属" maxlength="30" />
          <datalist id="genus-options">
            <option v-for="genus in COMMON_GENERA" :key="genus" :value="genus"></option>
          </datalist>
        </el-form-item>
        <el-form-item label="形态" required>
          <el-radio-group v-model="form.form">
            <el-radio-button v-for="item in CORAL_FORMS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <template v-if="form.source === 'nursery'">
          <el-form-item label="苗圃编号" required>
            <el-select v-model="form.nurseryId" placeholder="选择来源苗圃" filterable style="width: 100%">
              <el-option v-for="option in nurseryOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="培育批次号" required>
            <el-select
              v-model="form.batchNo"
              placeholder="选择培育批次（带批号才进覆盖率）"
              filterable
              allow-create
              default-first-option
              style="width: 100%"
            >
              <el-option
                v-for="option in batchOptions"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
            <div v-if="form.nurseryId && batchOptions.length === 0" class="gb-hint gb-danger">
              该苗圃暂无批次，保存后将先挂起等苗圃组核定。
            </div>
          </el-form-item>
        </template>
        <el-form-item label="覆盖长度" required>
          <el-input-number v-model="form.coverCm" :min="0" :max="belt ? belt.lengthM * 100 : 10000" :step="10" controls-position="right" />
          <span class="page__unit">cm（样带全长 {{ belt ? belt.lengthM * 100 : 0 }} cm）</span>
        </el-form-item>
        <el-form-item label="白化等级" required>
          <el-radio-group v-model="form.bleachLevel">
            <el-radio-button v-for="level in BLEACH_LEVELS" :key="level" :value="level">
              {{ level }}
            </el-radio-button>
          </el-radio-group>
          <div v-if="form.source === 'nursery'" class="gb-hint">
            白化等级照录存档，但回播珊瑚不参与样带白化指数 / 白化占比计算。
          </div>
          <div class="page__legend">
            <span
              v-for="level in BLEACH_LEVELS"
              :key="`legend-${level}`"
              class="page__legend-item"
              :style="{ background: BLEACH_BG[level], color: BLEACH_COLOR[level], borderColor: BLEACH_COLOR[level] }"
            >
              {{ level }}
            </span>
          </div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" placeholder="如：局部褪色 / 台风扰动后白化" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新增记录' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pasteVisible" title="批量粘贴导入珊瑚记录" width="620px">
      <p class="gb-hint">
        每行一条，格式「属名,形态,覆盖长度(cm)[,白化等级]」，逗号 / 制表符 / 分号均可。批量粘贴的外业摸底数据一律按<strong>自然珊瑚</strong>录入，仅覆盖该样带现有自然珊瑚，不影响已录入的回播记录。示例：<br />
        <span class="gb-mono">鹿角珊瑚属,枝状,860,无</span><br />
        <span class="gb-mono">蔷薇珊瑚属;叶状;720;中</span><br />
        <span class="gb-mono">滨珊瑚属,块状,1120</span>
      </p>
      <el-input v-model="pasteText" type="textarea" :rows="8" placeholder="鹿角珊瑚属,枝状,860,无" />
      <div v-if="pasteErrors.length > 0" class="page__errors">
        <el-alert v-for="(error, index) in pasteErrors" :key="index" type="warning" :title="error" :closable="false" show-icon />
      </div>
      <template #footer>
        <el-button @click="pasteVisible = false">取消</el-button>
        <el-button @click="previewPaste">解析预览</el-button>
        <el-button type="primary" @click="importPaste">覆盖导入</el-button>
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
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}

.page__sub {
  margin: 0 0 8px;
  font-size: 13px;
  color: #4c6663;
}

.page__bulk {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #7c9995;
}

.page__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.page__legend-item {
  padding: 1px 8px;
  border: 1px solid;
  border-radius: 999px;
  font-size: 11px;
}

.page__errors {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  max-height: 160px;
  overflow: auto;
}
</style>
