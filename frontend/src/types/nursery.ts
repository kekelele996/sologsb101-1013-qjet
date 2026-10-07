/**
 * 苗圃培育批次（苗圃组台账）。
 * 苗圃组负责维护苗圃编号、培育批次与可供移出量；
 * 外业回播按「回播覆盖长度」扣减对应批次的可供移出量（cm）。
 */

/** 苗圃批次：一个苗圃编号 + 一个培育批次号唯一确定一行 */
export interface NurseryBatch {
  id: string
  /** 苗圃编号，如 N-01（与外业样带编号一起作为对账键） */
  nurseryNo: string
  /** 培育批次号，如 B2026-03 */
  batchNo: string
  /** 培育物种 / 属名，如 鹿角珊瑚属 */
  species: string
  /** 培育形态 */
  form: import('@/types/coralRecord').CoralForm
  /** 可供移出量（cm）：回播扣减后更新，不允许为负 */
  availableCm: number
  /** 负责人 / 苗圃管理员 */
  keeper: string
  /** 建批次日期 */
  startedAt: string
  /** 备注 */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 苗圃批次草稿（存于 nurseryStore） */
export interface NurseryDraft {
  nurseryNo: string
  batchNo: string
  species: string
  form: import('@/types/coralRecord').CoralForm
  availableCm: number
  keeper: string
  startedAt: string
  remark: string
}

/** 常用苗圃编号（表单联想用） */
export const COMMON_NURSERY_NOS: string[] = ['N-01', 'N-02', 'N-03']

export function createEmptyNurseryDraft(): NurseryDraft {
  return {
    nurseryNo: '',
    batchNo: '',
    species: '',
    form: '枝状',
    availableCm: 1000,
    keeper: '',
    startedAt: new Date().toISOString().slice(0, 10),
    remark: ''
  }
}

/** 苗圃台账筛选条件 */
export interface NurseryFilterState {
  keyword: string
  statuses: NurseryBatchStatus[]
}

/** 批次台账状态（由可供移出量派生，仅用于筛选） */
export type NurseryBatchStatus = '有存量' | '已扣完'

export const NURSERY_BATCH_STATUSES: NurseryBatchStatus[] = ['有存量', '已扣完']

export function createEmptyNurseryFilter(): NurseryFilterState {
  return { keyword: '', statuses: [] }
}
