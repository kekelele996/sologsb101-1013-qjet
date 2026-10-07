/**
 * 回播对账与扣减服务（纯函数口径，store / 页面共用）。
 *
 * 业务口径：
 * - 移栽珊瑚带批号才进礁区覆盖率，白化指数仍按自然珊瑚算。
 * - 苗圃组按回播覆盖长度扣减「苗圃编号 + 批次号」对应批次的可供移出量。
 * - 两边按苗圃编号和样带编号对账，对不上的先挂起，等苗圃组核定。
 * - 扣减只跑苗圃侧（nurseries + outplants 两表），失败可独立重跑，外业不受影响。
 */
import type { NurseryBatch } from '@/types/nursery'
import type { Belt } from '@/types/belt'
import type { OutplantApplyResult, OutplantIssue, OutplantRequest } from '@/types/outplant'

/**
 * 匹配苗圃批次：苗圃编号与批次号必须同时对上。
 * 对不上返回 null，调用方按挂起处理。
 */
export function matchBatch(
  batches: NurseryBatch[],
  nurseryNo: string,
  batchNo: string
): NurseryBatch | null {
  return (
    batches.find(
      (batch) => batch.nurseryNo.trim() === nurseryNo.trim() && batch.batchNo.trim() === batchNo.trim()
    ) ?? null
  )
}

/**
 * 匹配样带：对账键之一的样带编号需在样带台账中存在。
 * 挂起重跑时允许外业样带尚未同步（返回 false 仅影响提示，不影响苗圃侧重跑）。
 */
export function beltNoExists(belts: Belt[], beltNo: string): boolean {
  return belts.some((belt) => belt.no.trim() === beltNo.trim())
}

/**
 * 评估一次回播扣减（不写库，只返回苗圃侧结果）。
 * 外业珊瑚记录是否入库不依赖本结果：任何失败都映射成挂起原因。
 *
 * @param checkBeltNo 是否校验样带编号。首次登记（外业侧）需对账样带编号；
 *                    苗圃组核定重跑只重跑本侧，不再以外业样带是否存在为前提。
 */
export function evaluateOutplant(
  request: Pick<OutplantRequest, 'nurseryNo' | 'batchNo' | 'beltNo' | 'coverCm'>,
  batches: NurseryBatch[],
  belts: Belt[],
  checkBeltNo = true
): OutplantApplyResult {
  const fail = (issue: OutplantIssue): OutplantApplyResult => ({
    status: '挂起',
    issue,
    deductedCm: 0
  })

  if (!request.batchNo || request.batchNo.trim().length === 0) return fail('回播记录缺少批号')
  if (checkBeltNo && !beltNoExists(belts, request.beltNo)) return fail('样带编号对不上')

  const batch = matchBatch(batches, request.nurseryNo, request.batchNo)
  if (!batch) return fail('苗圃编号与批号对不上')
  if (!(request.coverCm > 0)) return fail('可供移出量不足')
  if (batch.availableCm < request.coverCm) return fail('可供移出量不足')

  return { status: '已扣减', issue: '', deductedCm: request.coverCm }
}

/**
 * 重跑单条挂起记录（苗圃侧专用）：只看苗圃台账（批号 + 存量），不重放外业。
 * 与首次评估同口径但跳过样带编号校验；已扣减过的记录幂等返回，避免重复扣减。
 */
export function reevaluateOutplant(
  request: Pick<OutplantRequest, 'nurseryNo' | 'batchNo' | 'beltNo' | 'coverCm'>,
  batches: NurseryBatch[],
  _belts: Belt[],
  alreadyDeductedCm: number
): OutplantApplyResult {
  if (alreadyDeductedCm > 0) {
    return { status: '已扣减', issue: '', deductedCm: alreadyDeductedCm }
  }
  return evaluateOutplant(request, batches, [], false)
}
