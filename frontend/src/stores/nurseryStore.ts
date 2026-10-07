/**
 * 苗圃 store：苗圃组台账（苗圃编号 / 培育批次 / 可供移出量）与回播对账记录。
 *
 * 协作口径：
 * - 外业录入回播珊瑚后调用 registerOutplant()：外业珊瑚记录已自行入库，与本侧结果无关。
 * - 苗圃侧按「苗圃编号 + 批次号」定位批次并按回播覆盖长度扣减可供移出量；
 *   两边对账键（苗圃编号 / 样带编号）对不上或存量不足时，对账记录挂起等苗圃组核定。
 * - retryOutplant() 只重跑苗圃侧（nurseries + outplants），不触碰外业样带 / 珊瑚记录。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { NurseryBatch, NurseryDraft, NurseryFilterState } from '@/types/nursery'
import { createEmptyNurseryFilter } from '@/types/nursery'
import type {
  OutplantFilterState,
  OutplantRecord,
  OutplantRequest,
  OutplantStatus
} from '@/types/outplant'
import { createEmptyOutplantFilter } from '@/types/outplant'
import type { Belt } from '@/types/belt'
import { evaluateOutplant, reevaluateOutplant } from '@/utils/outplant'

export const useNurseryStore = defineStore('nursery', () => {
  const nurseries = ref<NurseryBatch[]>([])
  const outplants = ref<OutplantRecord[]>([])
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const nurseryFilter = ref<NurseryFilterState>(createEmptyNurseryFilter())
  const outplantFilter = ref<OutplantFilterState>(createEmptyOutplantFilter())

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<NurseryBatch>(() => db.nurseries).subscribe((rows) => {
      nurseries.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<OutplantRecord>(() => db.outplants).subscribe((rows) => {
      outplants.value = rows
    })
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
    })
  }

  /* ------------------------------ 派生视图 ------------------------------ */

  /** 批次台账行：附本批次已成功回播扣减量与挂起量 */
  const nurseryRows = computed(() =>
    nurseries.value
      .map((batch) => {
        const related = outplants.value.filter(
          (record) => record.nurseryNo === batch.nurseryNo && record.batchNo === batch.batchNo
        )
        const deductedCm = related.reduce((sum, record) => sum + record.deductedCm, 0)
        const suspendedCm = related
          .filter((record) => record.status === '挂起')
          .reduce((sum, record) => sum + record.coverCm, 0)
        return {
          batch,
          deductedCm,
          suspendedCm,
          recordCount: related.length,
          exhausted: batch.availableCm <= 0
        }
      })
      .sort((a, b) => a.batch.nurseryNo.localeCompare(b.batch.nurseryNo, 'zh-Hans-CN') || a.batch.batchNo.localeCompare(b.batch.batchNo, 'zh-Hans-CN'))
  )

  const filteredNurseryRows = computed(() =>
    nurseryRows.value.filter((row) => {
      const keyword = nurseryFilter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.batch.nurseryNo}${row.batch.batchNo}${row.batch.species}${row.batch.keeper}`
        if (!haystack.includes(keyword)) return false
      }
      if (nurseryFilter.value.statuses.length > 0) {
        const matched = nurseryFilter.value.statuses.some((status) =>
          status === '已扣完' ? row.exhausted : !row.exhausted
        )
        if (!matched) return false
      }
      return true
    })
  )

  /** 回播对账行：挂上样带编号与日期，便于两边核对 */
  const outplantRows = computed(() =>
    outplants.value
      .map((record) => {
        const belt = belts.value.find((item) => item.id === record.beltId)
        return {
          record,
          beltNoResolved: belt?.no ?? record.beltNo,
          surveyDateResolved: belt?.surveyDate ?? record.surveyDate
        }
      })
      .sort((a, b) => {
        if (a.record.status !== b.record.status) return a.record.status === '挂起' ? -1 : 1
        return b.record.updatedAt - a.record.updatedAt
      })
  )

  const filteredOutplantRows = computed(() =>
    outplantRows.value.filter((row) => {
      const keyword = outplantFilter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack =
          `${row.record.nurseryNo}${row.record.batchNo}${row.beltNoResolved}` +
          `${row.record.observer}${row.record.issue}${row.record.coralId}`
        if (!haystack.includes(keyword)) return false
      }
      if (
        outplantFilter.value.statuses.length > 0 &&
        !outplantFilter.value.statuses.includes(row.record.status)
      ) {
        return false
      }
      return true
    })
  )

  const suspendedCount = computed(() => outplants.value.filter((record) => record.status === '挂起').length)
  const suspendedCoverCm = computed(() =>
    outplants.value
      .filter((record) => record.status === '挂起')
      .reduce((sum, record) => sum + record.coverCm, 0)
  )
  const totalAvailableCm = computed(() =>
    nurseries.value.reduce((sum, batch) => sum + batch.availableCm, 0)
  )

  function patchNurseryFilter(patch: Partial<NurseryFilterState>): void {
    nurseryFilter.value = { ...nurseryFilter.value, ...patch }
  }

  function resetNurseryFilter(): void {
    nurseryFilter.value = createEmptyNurseryFilter()
  }

  function patchOutplantFilter(patch: Partial<OutplantFilterState>): void {
    outplantFilter.value = { ...outplantFilter.value, ...patch }
  }

  function resetOutplantFilter(): void {
    outplantFilter.value = createEmptyOutplantFilter()
  }

  /* ------------------------------ 苗圃批次 ------------------------------ */

  async function createNursery(payload: NurseryDraft): Promise<NurseryBatch> {
    const now = Date.now()
    const row: NurseryBatch = { ...payload, id: createId('nur'), createdAt: now, updatedAt: now }
    await db.nurseries.put(row)
    return row
  }

  async function updateNursery(id: string, patch: Partial<NurseryBatch>): Promise<void> {
    await db.nurseries.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeNursery(id: string): Promise<void> {
    await db.nurseries.delete(id)
  }

  /** 同一苗圃编号 + 批次号不允许重复建档 */
  function findDuplicateBatch(nurseryNo: string, batchNo: string, excludeId?: string): NurseryBatch | null {
    return (
      nurseries.value.find(
        (batch) =>
          batch.id !== excludeId &&
          batch.nurseryNo.trim() === nurseryNo.trim() &&
          batch.batchNo.trim() === batchNo.trim()
      ) ?? null
    )
  }

  /** 表单下拉：苗圃编号 → 批次号 选项 */
  const batchOptions = computed(() =>
    nurseries.value.map((batch) => ({
      nurseryNo: batch.nurseryNo,
      batchNo: batch.batchNo,
      label: `${batch.nurseryNo}｜${batch.batchNo}｜${batch.species}（余 ${batch.availableCm} cm）`,
      availableCm: batch.availableCm
    }))
  )

  function batchesOfNursery(nurseryNo: string) {
    return nurseries.value.filter((batch) => batch.nurseryNo === nurseryNo)
  }

  /* ------------------------------ 回播对账 ------------------------------ */

  /**
   * 外业回播登记（由 surveyStore 在珊瑚记录入库后调用）。
   * 外业珊瑚记录是否成功不依赖本方法：本方法只负责苗圃侧扣减与落对账记录。
   * 校验 + 扣减在同一个事务内基于最新库内数据完成，避免并发下读到旧存量。
   */
  async function registerOutplant(request: OutplantRequest): Promise<OutplantRecord> {
    const now = Date.now()
    const id = createId('out')
    await db.transaction('rw', [db.nurseries, db.outplants, db.belts], async () => {
      const [batchesFresh, beltsFresh] = await Promise.all([db.nurseries.toArray(), db.belts.toArray()])
      const result = evaluateOutplant(request, batchesFresh, beltsFresh)
      if (result.status === '已扣减') {
        const batch = batchesFresh.find(
          (item) => item.nurseryNo === request.nurseryNo.trim() && item.batchNo === request.batchNo.trim()
        )
        if (batch) {
          await db.nurseries.update(batch.id, {
            availableCm: Math.max(0, batch.availableCm - result.deductedCm),
            updatedAt: now
          } as never)
        }
      }
      await db.outplants.put({
        id,
        beltId: request.beltId,
        beltNo: request.beltNo,
        nurseryNo: request.nurseryNo.trim(),
        batchNo: request.batchNo.trim(),
        coverCm: request.coverCm,
        status: result.status,
        issue: result.issue,
        coralId: request.coralId,
        surveyDate: request.surveyDate,
        observer: request.observer,
        deductedCm: result.deductedCm,
        lastRetryAt: 0,
        createdAt: now,
        updatedAt: now
      })
    })
    return (await db.outplants.get(id)) as OutplantRecord
  }

  /**
   * 重跑挂起记录（苗圃组核定后）：只重跑苗圃侧，外业照旧不重放。
   * 校验 + 扣减在单事务内读最新存量；成功置为已扣减并补扣，仍对不上则刷新挂起原因。
   * 已扣减过的记录幂等返回，避免重复扣减。
   */
  async function retryOutplant(id: string): Promise<OutplantRecord> {
    const existing = await db.outplants.get(id)
    if (!existing) throw new Error('对账记录不存在')
    if (existing.status === '已扣减') return existing

    const now = Date.now()
    await db.transaction('rw', [db.nurseries, db.outplants, db.belts], async () => {
      const [batchesFresh, beltsFresh] = await Promise.all([db.nurseries.toArray(), db.belts.toArray()])
      const result = reevaluateOutplant(
        {
          nurseryNo: existing.nurseryNo,
          batchNo: existing.batchNo,
          beltNo: existing.beltNo,
          coverCm: existing.coverCm
        },
        batchesFresh,
        beltsFresh,
        existing.deductedCm
      )
      if (result.status === '已扣减' && existing.deductedCm === 0) {
        const batch = batchesFresh.find(
          (item) => item.nurseryNo === existing.nurseryNo && item.batchNo === existing.batchNo
        )
        if (batch) {
          await db.nurseries.update(batch.id, {
            availableCm: Math.max(0, batch.availableCm - result.deductedCm),
            updatedAt: now
          } as never)
        }
      }
      await db.outplants.update(id, {
        status: result.status,
        issue: result.issue,
        deductedCm: result.deductedCm,
        lastRetryAt: now,
        updatedAt: now
      } as never)
    })
    return (await db.outplants.get(id)) ?? existing
  }

  /** 批量重跑全部挂起记录，逐条独立处理，单条失败不影响其余（只重跑本侧） */
  async function retryAllSuspended(): Promise<{ resolved: number; stillSuspended: number }> {
    const pending = outplants.value.filter((record) => record.status === '挂起')
    let resolved = 0
    for (const record of pending) {
      const updated = await retryOutplant(record.id)
      if (updated.status === '已扣减') resolved += 1
    }
    return { resolved, stillSuspended: pending.length - resolved }
  }

  /** 删除对账记录（误登记撤销用；不回补珊瑚记录） */
  async function removeOutplant(id: string): Promise<void> {
    await db.outplants.delete(id)
  }

  /** 状态徽标用的中文状态集合（供页面引用保持口径一致） */
  const statuses: OutplantStatus[] = ['已扣减', '挂起']

  return {
    nurseries,
    outplants,
    ready,
    error,
    nurseryFilter,
    outplantFilter,
    nurseryRows,
    filteredNurseryRows,
    outplantRows,
    filteredOutplantRows,
    suspendedCount,
    suspendedCoverCm,
    totalAvailableCm,
    batchOptions,
    statuses,
    start,
    patchNurseryFilter,
    resetNurseryFilter,
    patchOutplantFilter,
    resetOutplantFilter,
    createNursery,
    updateNursery,
    removeNursery,
    findDuplicateBatch,
    batchesOfNursery,
    registerOutplant,
    retryOutplant,
    retryAllSuspended,
    removeOutplant
  }
})
