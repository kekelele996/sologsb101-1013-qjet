/** 珊瑚来源：外业普查的自然珊瑚 / 苗圃回播的移栽珊瑚 */
export type CoralSource = 'natural' | 'nursery'

export const CORAL_SOURCES: CoralSource[] = ['natural', 'nursery']

export const CORAL_SOURCE_LABEL: Record<CoralSource, string> = {
  natural: '自然珊瑚',
  nursery: '苗圃回播'
}

/**
 * 苗圃：苗圃组维护的培育单位。
 * 一个苗圃可分多个培育批次，每个批次记录可供移出量（cm），
 * 回播到样带后按覆盖长度扣减。
 */
export interface NurseryBatch {
  /** 培育批次号（对账键之一） */
  batchNo: string
  /** 初始可供移出量（cm，录入时快照） */
  initialAvailableCm: number
  /** 当前可供移出量（cm，回播扣减后更新） */
  availableCm: number
}

export interface Nursery {
  id: string
  /** 苗圃编号，如 N-01（对账键之一） */
  no: string
  /** 苗圃名称 */
  name: string
  /** 所在地 / 位置描述 */
  location: string
  /** 负责人（苗圃组） */
  keeper: string
  /** 备注 */
  remark: string
  /** 培育批次与可供移出量 */
  batches: NurseryBatch[]
  createdAt: number
  updatedAt: number
}

/** 苗圃台账中的培育批次行（同苗圃编号下按批号分组派生） */
export interface NurseryBatchRow {
  /** 苗圃 id */
  nurseryId: string
  /** 苗圃编号 */
  nurseryNo: string
  /** 苗圃名称 */
  nurseryName: string
  /** 培育批次号（对账键之一） */
  batchNo: string
  /** 初始可供移出量（cm，播种 / 录入时快照） */
  initialAvailableCm: number
  /** 当前可供移出量（cm） */
  availableCm: number
  /** 已回播扣减长度（cm） */
  deductedCm: number
  /** 批次记录条数 */
  coralCount: number
}

/** 新建 / 编辑苗圃时的批次明细（随苗圃表单一起提交） */
export interface NurseryBatchInput {
  batchNo: string
  availableCm: number
}

/** 苗圃表单草稿（存于 nurseryStore） */
export interface NurseryDraft {
  no: string
  name: string
  location: string
  keeper: string
  remark: string
  batches: NurseryBatchInput[]
}

export function createEmptyNurseryDraft(): NurseryDraft {
  return {
    no: '',
    name: '',
    location: '',
    keeper: '',
    remark: '',
    batches: [{ batchNo: '', availableCm: 2000 }]
  }
}

/**
 * 回播对账状态：
 * - pending   挂起：苗圃编号 + 批号 / 样带对不上，等苗圃组核定（不扣减可供移出量）
 * - confirmed 已对账：批号有效、样带存在，已按回播覆盖长度扣减
 * - failed    扣减失败：可供移出量不足等苗圃侧原因，外业照旧，只重跑本侧扣减
 */
export type OutplantStatus = 'pending' | 'confirmed' | 'failed'

export const OUTPLANT_STATUSES: OutplantStatus[] = ['pending', 'confirmed', 'failed']

export const OUTPLANT_STATUS_LABEL: Record<OutplantStatus, string> = {
  pending: '挂起待核定',
  confirmed: '已对账',
  failed: '扣减失败'
}
