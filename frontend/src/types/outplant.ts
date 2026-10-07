import type { OutplantStatus } from '@/types/nursery'

/**
 * 回播对账台账：苗圃组与外业普查组两边的对账记录。
 * 对账键为「苗圃编号（nurseryId）+ 样带编号（beltId）+ 批号」，
 * 一条台账对应某批次回播到某条样带的全部移栽珊瑚记录。
 *
 * 挂起（pending）/ 扣减失败（failed）的台账等苗圃组核定后重跑本侧扣减；
 * 外业普查侧的珊瑚记录与覆盖率不受苗圃侧扣减成败影响。
 */
export interface OutplantLedger {
  id: string
  /** 苗圃 id（对账键） */
  nurseryId: string
  /** 苗圃编号快照，便于挂起时人工核对 */
  nurseryNo: string
  /** 样带 id（对账键） */
  beltId: string
  /** 样带编号快照 */
  beltNo: string
  /** 培育批次号（对账键） */
  batchNo: string
  /** 该批次在该样带上的回播珊瑚记录数 */
  coralCount: number
  /** 回播覆盖长度合计（cm）—— 苗圃组据此扣减可供移出量 */
  coverCmTotal: number
  /** 对账状态 */
  status: OutplantStatus
  /** 挂起 / 失败原因（核定提示用） */
  reason: string
  /** 最近一次尝试扣减的时间（无则为创建时间） */
  lastAttemptAt: number
  /** 最近一次核定 / 成功扣减时间 */
  settledAt: number | null
  createdAt: number
  updatedAt: number
}

/** 台账展示行：附带珊瑚记录明细，供苗圃台账页核定 */
export interface OutplantLedgerRow {
  ledger: OutplantLedger
  /** 该台账覆盖的移栽珊瑚记录 id 列表 */
  coralIds: string[]
}
