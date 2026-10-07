/**
 * 苗圃 store：苗圃组一侧的数据。
 * - 维护苗圃编号、培育批次与可供移出量（随苗圃表单整体提交的批次行）；
 * - 维护回播对账台账（nurseryId + beltId + batchNo），挂起 / 失败台账核定后重跑本侧扣减；
 * - 扣减只改苗圃侧（nurseries / outplants），外业珊瑚记录与覆盖率不受影响（外业照旧）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Nursery, NurseryBatchRow, NurseryDraft, OutplantStatus } from '@/types/nursery'
import { OUTPLANT_STATUSES } from '@/types/nursery'
import type { OutplantLedger } from '@/types/outplant'
import type { CoralRecord } from '@/types/coralRecord'
import { reconcileOutplants } from '@/utils/outplant'

/** 台账展示行：附带所属苗圃 / 样带快照与珊瑚明细数 */
export interface LedgerView {
  ledger: OutplantLedger
  nurseryNo: string
  nurseryName: string
  beltNo: string
  batchNo: string
  coverCmTotal: number
  coralCount: number
  status: OutplantStatus
  reason: string
}

export const useNurseryStore = defineStore('nursery', () => {
  const nurseries = ref<Nursery[]>([])
  const ledgers = ref<OutplantLedger[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Nursery>(() => db.nurseries).subscribe((rows) => {
      nurseries.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<OutplantLedger>(() => db.outplants).subscribe((rows) => {
      ledgers.value = rows
    })
  }

  function nurseryById(id: string | null | undefined): Nursery | null {
    if (!id) return null
    return nurseries.value.find((nursery) => nursery.id === id) ?? null
  }

  function findBatch(nurseryId: string, batchNo: string): Nursery['batches'][number] | undefined {
    const nursery = nurseryById(nurseryId)
    return nursery?.batches.find((batch) => batch.batchNo === batchNo.trim())
  }

  /** 台账展示行（按状态：挂起 / 失败优先，再按更新时间倒序） */
  const ledgerViews = computed<LedgerView[]>(() => {
    const statusWeight: Record<OutplantStatus, number> = { pending: 0, failed: 1, confirmed: 2 }
    return ledgers.value
      .map((ledger) => {
        const nursery = nurseryById(ledger.nurseryId)
        return {
          ledger,
          nurseryNo: ledger.nurseryNo || nursery?.no || '—',
          nurseryName: nursery?.name || '未知苗圃',
          beltNo: ledger.beltNo,
          batchNo: ledger.batchNo,
          coverCmTotal: ledger.coverCmTotal,
          coralCount: ledger.coralCount,
          status: ledger.status,
          reason: ledger.reason
        }
      })
      .sort((a, b) => {
        const weightDiff = statusWeight[a.status] - statusWeight[b.status]
        if (weightDiff !== 0) return weightDiff
        return b.ledger.updatedAt - a.ledger.updatedAt
      })
  })

  /** 待处理（挂起 + 扣减失败）台账数，导航徽标用 */
  const pendingCount = computed(
    () => ledgers.value.filter((ledger) => ledger.status === 'pending' || ledger.status === 'failed').length
  )

  /** 按状态统计台账条数 */
  const ledgerStatusCounts = computed<Record<OutplantStatus, number>>(() => {
    const counts: Record<OutplantStatus, number> = { pending: 0, confirmed: 0, failed: 0 }
    ledgers.value.forEach((ledger) => {
      counts[ledger.status] += 1
    })
    return counts
  })

  /** 苗圃批次台账行（可供移出量 / 已扣减 / 关联珊瑚条数） */
  const batchRows = computed<NurseryBatchRow[]>(() => {
    const rows: NurseryBatchRow[] = []
    nurseries.value.forEach((nursery) => {
      nursery.batches.forEach((batch) => {
        const related = ledgers.value.filter(
          (ledger) => ledger.nurseryId === nursery.id && ledger.batchNo === batch.batchNo
        )
        const deducted = related
          .filter((ledger) => ledger.status === 'confirmed')
          .reduce((sum, ledger) => sum + ledger.coverCmTotal, 0)
        const coralCount = related
          .filter((ledger) => ledger.status === 'confirmed')
          .reduce((sum, ledger) => sum + ledger.coralCount, 0)
        rows.push({
          nurseryId: nursery.id,
          nurseryNo: nursery.no,
          nurseryName: nursery.name,
          batchNo: batch.batchNo,
          initialAvailableCm: batch.initialAvailableCm,
          availableCm: batch.availableCm,
          deductedCm: Math.round(deducted * 10) / 10,
          coralCount
        })
      })
    })
    return rows
  })

  /* ------------------------------ 苗圃 / 批次 ------------------------------ */

  async function createNursery(
    payload: Omit<Nursery, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Nursery> {
    const now = Date.now()
    const row: Nursery = { ...payload, id: createId('nur'), createdAt: now, updatedAt: now }
    await db.nurseries.put(row)
    return row
  }

  async function updateNursery(id: string, patch: Partial<Nursery>): Promise<void> {
    await db.nurseries.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeNursery(id: string): Promise<void> {
    await db.transaction('rw', [db.nurseries, db.outplants], async () => {
      await db.outplants.where('nurseryId').equals(id).delete()
      await db.nurseries.delete(id)
    })
  }

  /**
   * 表单批次明细 → 持久化批次。
   * 表单填的是「可供移出量（初始 / 计划容量）」，即 initialAvailableCm；
   * 当前可供移出量一律不由表单写入，而由随后的 settleAll 按
   * 「初始量 − confirmed 台账」重算，保证改大容量后 failed 台账可重跑成功。
   */
  function mergeBatches(_existing: Nursery['batches'], inputs: NurseryDraft['batches']): Nursery['batches'] {
    return inputs.map((input) => ({
      batchNo: input.batchNo.trim(),
      initialAvailableCm: input.availableCm,
      availableCm: input.availableCm
    }))
  }

  /* ------------------------------ 回播对账扣减 ------------------------------ */

  /**
   * 全量重跑对账：按全部移栽珊瑚重新分组结算。
   * 幂等——可供移出量始终由「初始量 - confirmed 台账」重算，不会重复扣减。
   * 返回各状态台账条数。
   */
  async function settleAll(): Promise<Record<OutplantStatus, number>> {
    return reconcileOutplants()
  }

  /**
   * 只重跑某条样带本侧（外业新增 / 编辑移栽珊瑚后调用）。
   * 读全部数据保证可供移出量重算一致，但只更新该样带相关台账。
   */
  async function settleBelt(beltId: string): Promise<Record<OutplantStatus, number>> {
    return reconcileOutplants(beltId)
  }

  /**
   * 核定挂起 / 失败台账：由苗圃组把该台账下移栽珊瑚改挂到正确的苗圃 / 批号后重跑本侧。
   * 只改苗圃侧归属（nurseryId / batchNo），不改覆盖长度、不删外业记录。
   */
  async function reconcileLedger(ledgerId: string, nurseryId: string, batchNo: string): Promise<void> {
    const ledger = await db.outplants.get(ledgerId)
    if (!ledger) return
    const targetNursery = await db.nurseries.get(nurseryId)
    if (!targetNursery) throw new Error('所选苗圃不存在')
    const trimmedBatch = batchNo.trim()
    if (!targetNursery.batches.some((batch) => batch.batchNo === trimmedBatch)) {
      throw new Error(`批号 ${batchNo} 在苗圃 ${targetNursery.no} 不存在`)
    }
    // 台账原苗圃 / 批号是否仍有效；挂起台账可能两者都已失效。
    const sourceNursery = await db.nurseries.get(ledger.nurseryId)
    const sourceValid = !!sourceNursery && sourceNursery.batches.some((batch) => batch.batchNo === ledger.batchNo)
    await db.transaction('rw', [db.corals, db.outplants, db.nurseries], async () => {
      // 把该台账原组的移栽珊瑚改挂到核定后的苗圃 + 批号。
      // 原归属有效时按 nurseryId + 批号精确匹配；失效（挂起）时退化为按批号匹配该样带上的回播记录。
      await db.corals
        .where('beltId')
        .equals(ledger.beltId)
        .modify((coral: CoralRecord) => {
          if (coral.source !== 'nursery') return
          const exact = coral.nurseryId === ledger.nurseryId && coral.batchNo === ledger.batchNo
          const looseFallback = !sourceValid && coral.batchNo === ledger.batchNo
          if (exact || looseFallback) {
            coral.nurseryId = nurseryId
            coral.batchNo = trimmedBatch
            coral.updatedAt = Date.now()
          }
        })
      // 旧键台账删除，随后由 settleBelt 按新键重建并扣减
      await db.outplants.delete(ledgerId)
    })
    await settleBelt(ledger.beltId)
  }

  /** 台账状态列表（页面筛选下拉用） */
  const statuses = OUTPLANT_STATUSES

  return {
    nurseries,
    ledgers,
    ready,
    error,
    statuses,
    ledgerViews,
    pendingCount,
    ledgerStatusCounts,
    batchRows,
    start,
    nurseryById,
    findBatch,
    createNursery,
    updateNursery,
    removeNursery,
    mergeBatches,
    settleAll,
    settleBelt,
    reconcileLedger
  }
})
