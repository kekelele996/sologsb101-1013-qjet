/** 珊瑚形态 */
import type { CoralSource } from '@/types/nursery'

export type { CoralSource }
export { CORAL_SOURCES, CORAL_SOURCE_LABEL } from '@/types/nursery'

export type CoralForm = '枝状' | '块状' | '叶状' | '软珊瑚'

export const CORAL_FORMS: CoralForm[] = ['枝状', '块状', '叶状', '软珊瑚']

/** 白化等级 */
export type BleachLevel = '无' | '轻' | '中' | '重' | '死亡'

export const BLEACH_LEVELS: BleachLevel[] = ['无', '轻', '中', '重', '死亡']

/** 珊瑚记录：样带内某属名、某形态的覆盖长度与白化等级 */
export interface CoralRecord {
  id: string
  /** 所属样带 */
  beltId: string
  /** 属名，如 鹿角珊瑚属 */
  genus: string
  /** 形态 */
  form: CoralForm
  /** 覆盖长度（cm） */
  coverCm: number
  /** 白化等级 */
  bleachLevel: BleachLevel
  /** 备注（病敌害、断枝等） */
  remark: string
  /**
   * 来源：natural 自然珊瑚（外业普查）/ nursery 苗圃回播。
   * 旧数据未记来源，v3 升级时统一回填为 natural。
   */
  source: CoralSource
  /** 来源苗圃 id（仅 nursery 记录，回播带批号进礁区覆盖率的对账键之一） */
  nurseryId: string
  /** 培育批次号（仅 nursery 记录；批号对得上才计入礁区覆盖率） */
  batchNo: string
  createdAt: number
  updatedAt: number
}

/**
 * 移栽珊瑚是否带有效批号（据此决定能否进礁区覆盖率）：
 * 必须来源为 nursery、同时挂上苗圃与批号。
 * 入参字段允许缺省，便于在升级前的旧数据上调用。
 */
export function isOutplant(record: { source?: CoralSource; nurseryId?: string; batchNo?: string }): boolean {
  return record.source === 'nursery' && (record.nurseryId ?? '').trim().length > 0 && (record.batchNo ?? '').trim().length > 0
}

/** 自然珊瑚判定：白化指数 / 白化占比只统计自然珊瑚（来源缺省的旧数据按自然珊瑚处理） */
export function isNaturalCoral(record: { source?: CoralSource }): boolean {
  return record.source !== 'nursery'
}

/** 珊瑚记录草稿（存于 surveyStore） */
export interface CoralDraft {
  genus: string
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
  remark: string
  source: CoralSource
  nurseryId: string
  batchNo: string
}

export function createEmptyCoralDraft(): CoralDraft {
  return {
    genus: '',
    form: '枝状',
    coverCm: 100,
    bleachLevel: '无',
    remark: '',
    source: 'natural',
    nurseryId: '',
    batchNo: ''
  }
}

/** 常见属名（表单联想用） */
export const COMMON_GENERA: string[] = [
  '鹿角珊瑚属',
  '杯形珊瑚属',
  '滨珊瑚属',
  '蜂巢珊瑚属',
  '蔷薇珊瑚属',
  '陀螺珊瑚属',
  '石芝珊瑚属',
  '软珊瑚属',
  '柳珊瑚属',
  '星珊瑚属'
]

/** 批量粘贴解析出的一行珊瑚记录 */
export interface CoralPasteRow {
  genus: string
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
}

/**
 * 解析批量粘贴文本：每行「属名,形态,覆盖长度[,白化等级]」。
 * 逗号 / 制表符 / 分号可作分隔（属名常含空格，不用空格定界）。
 */
export function parseCoralPaste(text: string): { rows: CoralPasteRow[]; errors: string[] } {
  const rows: CoralPasteRow[] = []
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；]+/).map((cell) => cell.trim())
    if (cells.length < 3) {
      errors.push(`第 ${index + 1} 行「${line}」至少需要「属名,形态,覆盖长度(cm)」三列`)
      return
    }
    const form = cells[1] as CoralForm
    if (!CORAL_FORMS.includes(form)) {
      errors.push(`第 ${index + 1} 行形态「${cells[1]}」不在 ${CORAL_FORMS.join(' / ')} 之内`)
      return
    }
    const coverCm = Number(cells[2])
    if (!Number.isFinite(coverCm) || coverCm < 0) {
      errors.push(`第 ${index + 1} 行覆盖长度应为非负数字（cm）`)
      return
    }
    const bleachLevel = (cells.length >= 4 ? cells[3] : '无') as BleachLevel
    if (!BLEACH_LEVELS.includes(bleachLevel)) {
      errors.push(`第 ${index + 1} 行白化等级「${cells[3]}」不在 ${BLEACH_LEVELS.join(' / ')} 之内`)
      return
    }
    rows.push({
      genus: cells[0],
      form,
      coverCm: Number(coverCm.toFixed(1)),
      bleachLevel
    })
  })
  return { rows, errors }
}
