/**
 * 回播对账记录（外业普查组 × 苗圃组之间的回播台账）。
 *
 * 口径：
 * - 移栽珊瑚带批号才进礁区覆盖率；白化指数仍按自然珊瑚算。
 * - 苗圃组按回播覆盖长度扣减对应批次的可供移出量。
 * - 两边按「苗圃编号 + 样带编号」对账；对不上的先挂起，等苗圃组核定后只重跑苗圃侧。
 * - 苗圃组扣减失败不影响外业：外业珊瑚记录照常入库，本条置为挂起。
 */

/** 对账状态：已扣减 / 挂起（挂起等苗圃组核定后重跑本侧） */
export type OutplantStatus = '已扣减' | '挂起'

export const OUTPLANT_STATUSES: OutplantStatus[] = ['已扣减', '挂起']

/** 挂起原因（对账键对不上 / 可供移出量不足 / 批号缺失） */
export type OutplantIssue =
  | '苗圃编号与批号对不上'
  | '可供移出量不足'
  | '回播记录缺少批号'
  | '样带编号对不上'

export const OUTPLANT_ISSUES: OutplantIssue[] = [
  '苗圃编号与批号对不上',
  '可供移出量不足',
  '回播记录缺少批号',
  '样带编号对不上'
]

/** 回播对账记录 */
export interface OutplantRecord {
  id: string
  /** 所属样带（外业侧记录所在样带；挂起记录可能缺 beltId） */
  beltId: string
  /** 外业样带编号（对账键之一），如 T-01 */
  beltNo: string
  /** 来源苗圃编号（对账键之一），如 N-01 */
  nurseryNo: string
  /** 培育批次号 */
  batchNo: string
  /** 回播覆盖长度（cm）：按它扣减可供移出量 */
  coverCm: number
  /** 对账状态 */
  status: OutplantStatus
  /** 挂起原因（已扣减时为空） */
  issue: string
  /** 关联的珊瑚记录 id（外业已照常入库） */
  coralId: string
  /** 回播 / 调查日期 */
  surveyDate: string
  /** 经办人 */
  observer: string
  /** 已扣减量（cm）：成功时等于 coverCm，重跑幂等防重复扣减 */
  deductedCm: number
  /** 最近一次重跑时间戳 */
  lastRetryAt: number
  createdAt: number
  updatedAt: number
}

/** 外业提交回播时的入参（不含对账结果，由 nurseryStore 判定） */
export interface OutplantRequest {
  beltId: string
  beltNo: string
  nurseryNo: string
  batchNo: string
  coverCm: number
  coralId: string
  surveyDate: string
  observer: string
}

/** 一次扣减尝试结果（只反映苗圃侧，外业结果不受其影响） */
export interface OutplantApplyResult {
  status: OutplantStatus
  issue: string
  /** 成功时实际扣减的 cm */
  deductedCm: number
}

/** 回播对账页筛选条件 */
export interface OutplantFilterState {
  keyword: string
  statuses: OutplantStatus[]
}

export function createEmptyOutplantFilter(): OutplantFilterState {
  return { keyword: '', statuses: [] }
}

/** 挂起判定 */
export function isSuspended(record: Pick<OutplantRecord, 'status'>): boolean {
  return record.status === '挂起'
}
