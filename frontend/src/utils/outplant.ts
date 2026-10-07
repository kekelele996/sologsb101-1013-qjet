/**
 * 回播对账与扣减：苗圃组（nurseries）与外业普查组（corals / belts）两侧的业务规则。
 *
 * 口径：
 * - 移栽珊瑚带批号（苗圃编号 + 批号）才进礁区覆盖率；白化指数仍只按自然珊瑚算。
 * - 两边按「苗圃编号（nurseryId）+ 样带编号（beltId）+ 批号」对账。
 * - 对不上的台账先挂起（pending）等苗圃组核定，不动可供移出量。
 * - 批号对得上但可供移出量不足 → failed，外业珊瑚记录照旧保留，只重跑本侧扣减。
 *
 * 纯函数只负责计算，写入在 nurseryStore 的事务中完成，保证两侧可独立重跑。
 */
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import { isOutplant } from '@/types/coralRecord'
import type { Nursery, NurseryBatch, OutplantStatus } from '@/types/nursery'
import type { OutplantLedger } from '@/types/outplant'
import { createId, db } from '@/utils/db'

/** 一条台账的对账扣减结果（纯计算，不写库） */
export interface SettlementResult {
  status: OutplantStatus
  reason: string
  coverCmTotal: number
  coralCount: number
}

/**
 * 计算单组（某苗圃某批次回播到某条样带）对账结果。
 * 调用方保证 corals 已按 nurseryId + beltId + batchNo 过滤。
 * @param otherConfirmedCm 同苗圃同批次、其他已对账（confirmed）样带已占用的覆盖长度。
 *        可供判定用「初始量 − 其他已对账量」，而非台账里可能过期的当前可供量，
 *        这样苗圃组补量（改初始量）后重跑本侧即可从 failed 翻成 confirmed。
 */
export function settleGroup(params: {
  nursery: Nursery | undefined
  batch: NurseryBatch | undefined
  belt: Belt | undefined
  corals: CoralRecord[]
  otherConfirmedCm?: number
}): SettlementResult {
  const { nursery, batch, belt, corals, otherConfirmedCm = 0 } = params
  const coverCmTotal = round1(corals.reduce((sum, coral) => sum + Math.max(0, coral.coverCm), 0))
  const coralCount = corals.length

  // 对不上：苗圃 / 批号 / 样带任一缺失，先挂起等苗圃组核定
  if (!nursery) {
    return {
      status: 'pending',
      reason: `苗圃不存在或已停用，等苗圃组核定`,
      coverCmTotal,
      coralCount
    }
  }
  if (!batch) {
    return {
      status: 'pending',
      reason: `批号在苗圃 ${nursery.no} 不存在，等苗圃组核定`,
      coverCmTotal,
      coralCount
    }
  }
  if (!belt) {
    return {
      status: 'pending',
      reason: `样带不存在，等苗圃组核定`,
      coverCmTotal,
      coralCount
    }
  }
  if (coverCmTotal <= 0) {
    return { status: 'confirmed', reason: '', coverCmTotal, coralCount }
  }
  // 批号对得上：本批剩余容量不足 → 扣减失败（外业照旧，只重跑本侧）
  const remaining = Math.max(0, round1(batch.initialAvailableCm - otherConfirmedCm))
  if (remaining < coverCmTotal) {
    return {
      status: 'failed',
      reason: `可供移出量不足：需扣减 ${coverCmTotal} cm，批次 ${batch.batchNo} 仅剩 ${remaining} cm`,
      coverCmTotal,
      coralCount
    }
  }
  return { status: 'confirmed', reason: '', coverCmTotal, coralCount }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 分组键：苗圃编号 + 样带编号 + 批号（对账键） */
function groupKey(nurseryId: string, beltId: string, batchNo: string): string {
  return `${nurseryId}__${beltId}__${batchNo}`
}

export interface OutplantGroup {
  nurseryId: string
  beltId: string
  batchNo: string
  corals: CoralRecord[]
}

/**
 * 从全部珊瑚记录中取出移栽珊瑚，按对账键分组。
 * 仅带齐「苗圃 + 批号」的移栽记录参与对账（进覆盖率的前提）；
 * 未挂苗圃 / 未带批号的记录既不进覆盖率也不扣减，由外业页提示先补录。
 */
export function groupOutplantCorals(corals: CoralRecord[]): OutplantGroup[] {
  const map = new Map<string, OutplantGroup>()
  corals
    .filter((coral) => coral.source === 'nursery' && isOutplant(coral))
    .forEach((coral) => {
      const nurseryId = coral.nurseryId.trim()
      const batchNo = coral.batchNo.trim()
      const key = groupKey(nurseryId, coral.beltId, batchNo)
      const bucket = map.get(key) ?? { nurseryId, beltId: coral.beltId, batchNo, corals: [] }
      bucket.corals.push(coral)
      map.set(key, bucket)
    })
  return Array.from(map.values())
}

/** 该移栽记录是否已挂到有效苗圃 + 批号（进覆盖率） */
export function coralInCoverage(coral: CoralRecord): boolean {
  return isOutplant(coral)
}

/** 台账的对账键，便于 upsert 去重 */
export function ledgerKey(ledger: Pick<OutplantLedger, 'nurseryId' | 'beltId' | 'batchNo'>): string {
  return groupKey(ledger.nurseryId, ledger.beltId, ledger.batchNo)
}

/**
 * 计算在给定台账状态下，某苗圃批次应有的可供移出量：
 * 初始量 - 全部 confirmed 台账的回播覆盖长度。
 * 用于重跑 / 核定时重算本侧数据，避免重复扣减或漏扣。
 */
export function recomputeAvailable(initialAvailableCm: number, confirmedLedgers: OutplantLedger[]): number {
  const deducted = confirmedLedgers.reduce((sum, ledger) => sum + Math.max(0, ledger.coverCmTotal), 0)
  return Math.max(0, round1(initialAvailableCm - deducted))
}

/**
 * 落库版全量对账（不依赖 Pinia，供首屏 / 导入后 / 苗圃页重跑共用）：
 * 1. 全部移栽珊瑚按 nurseryId + beltId + batchNo 分组结算；
 * 2. 台账按对账键 upsert（已无对应珊瑚的旧台账删除）；
 * 3. 每个苗圃批次的可供移出量 = 初始量 - 全部 confirmed 台账覆盖长度。
 *
 * beltFilter 非空时只动该样带相关分组（其余台账原样保留），实现「扣减失败只重跑本侧」。
 * 幂等：可供量始终由初始量与 confirmed 台账重算，可安全反复重跑。
 */
export async function reconcileOutplants(beltFilter?: string): Promise<Record<OutplantStatus, number>> {
  const [allCorals, allBelts, allNurseries, existingLedgers] = await Promise.all([
    db.corals.toArray(),
    db.belts.toArray(),
    db.nurseries.toArray(),
    db.outplants.toArray()
  ])

  const now = Date.now()
  const nurseryById = new Map(allNurseries.map((nursery) => [nursery.id, nursery]))
  const beltById = new Map(allBelts.map((belt) => [belt.id, belt]))

  const groups = groupOutplantCorals(allCorals).filter(
    (group) => !beltFilter || group.beltId === beltFilter
  )

  const result: Record<OutplantStatus, number> = { pending: 0, confirmed: 0, failed: 0 }
  const touchedKeys = new Set<string>()
  const ledgerByKey = new Map(
    existingLedgers.map((ledger) => [ledgerKey(ledger), ledger])
  )

  const upsertLedgers: OutplantLedger[] = []
  groups.forEach((group) => {
    const nursery = nurseryById.get(group.nurseryId)
    const batch = nursery?.batches.find((item) => item.batchNo === group.batchNo)
    const belt = beltById.get(group.beltId)
    // 同批次其他样带已对账占用量（不含本组），用于判定剩余容量
    const otherConfirmedCm = existingLedgers
      .filter(
        (ledger) =>
          ledger.nurseryId === group.nurseryId &&
          ledger.batchNo === group.batchNo &&
          ledger.beltId !== group.beltId &&
          ledger.status === 'confirmed'
      )
      .reduce((sum, ledger) => sum + ledger.coverCmTotal, 0)
    const settled = settleGroup({ nursery, batch, belt, corals: group.corals, otherConfirmedCm })
    result[settled.status] += 1
    const key = ledgerKey({ nurseryId: group.nurseryId, beltId: group.beltId, batchNo: group.batchNo })
    touchedKeys.add(key)
    const old = ledgerByKey.get(key)
    upsertLedgers.push({
      id: old?.id ?? createId('out'),
      nurseryId: group.nurseryId,
      nurseryNo: nursery?.no ?? group.nurseryId,
      beltId: group.beltId,
      beltNo: belt?.no ?? '—',
      batchNo: group.batchNo,
      coralCount: settled.coralCount,
      coverCmTotal: settled.coverCmTotal,
      status: settled.status,
      reason: settled.reason,
      lastAttemptAt: now,
      settledAt: settled.status === 'confirmed' ? now : old?.settledAt ?? null,
      createdAt: old?.createdAt ?? now,
      updatedAt: now
    })
  })

  await db.transaction('rw', [db.outplants, db.nurseries], async () => {
    // 只清理本次处理范围内、已无对应移栽珊瑚的旧台账
    const stale = existingLedgers.filter((ledger) => {
      if (beltFilter && ledger.beltId !== beltFilter) return false
      return !touchedKeys.has(ledgerKey(ledger))
    })
    if (stale.length > 0) await db.outplants.bulkDelete(stale.map((ledger) => ledger.id))
    if (upsertLedgers.length > 0) await db.outplants.bulkPut(upsertLedgers)

    // 以最新台账重算各批次可供移出量（pending / failed 不扣减）。
    // 即便只重跑单条样带，也重算全部苗圃：可供量是苗圃批次级状态，
    // 苗圃组补量 / 改批次后重跑本侧才能让 failed 台账正确翻成 confirmed。
    const finalLedgers = await db.outplants.toArray()
    const nurseryUpdates = allNurseries.map((nursery) => {
        const batches = nursery.batches.map((batch) => {
          const confirmed = finalLedgers.filter(
            (ledger) =>
              ledger.nurseryId === nursery.id &&
              ledger.batchNo === batch.batchNo &&
              ledger.status === 'confirmed'
          )
          return { ...batch, availableCm: recomputeAvailable(batch.initialAvailableCm, confirmed) }
        })
        return { ...nursery, batches, updatedAt: now }
      })
    if (nurseryUpdates.length > 0) await db.nurseries.bulkPut(nurseryUpdates)
  })

  return result
}
