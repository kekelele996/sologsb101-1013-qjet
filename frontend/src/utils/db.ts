/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbcoralbelt，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（礁区 → 站位 → 样带 → 珊瑚记录/鱼类计数）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import type { Nursery } from '@/types/nursery'
import type { OutplantLedger } from '@/types/outplant'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbcoralbelt'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbcoralbelt:db-version',
  lastBackupAt: 'gbcoralbelt:last-backup-at',
  lastReefId: 'gbcoralbelt:last-reef-id'
} as const

/** 备份文件结构，供 utils/export.ts 与覆盖度汇总页使用 */
export interface BackupPayload {
  app: 'gbcoralbelt'
  dbVersion: number
  exportedAt: string
  reefs: Reef[]
  sites: Site[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
  nurseries: Nursery[]
  outplants: OutplantLedger[]
}

export class CoralBeltDatabase extends Dexie {
  reefs!: Table<Reef, string>
  sites!: Table<Site, string>
  belts!: Table<Belt, string>
  corals!: Table<CoralRecord, string>
  fishes!: Table<FishCount, string>
  nurseries!: Table<Nursery, string>
  outplants!: Table<OutplantLedger, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      reefs: 'id, name, protectStatus',
      sites: 'id, reefId, no',
      belts: 'id, siteId, no, surveyDate',
      corals: 'id, beltId, genus, form',
      fishes: 'id, beltId, family, sizeClass'
    })

    // v2：补齐筛选与统计需要的索引（位置/面积、经纬度/水深、样带长度与朝向、白化等级、类别）
    this.version(2)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与必填字段，避免列表排序与筛选拿到 undefined
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['reefs', () => ({ manager: '', areaKm2: 0 })],
          ['sites', () => ({ lat: 0, lng: 0, depthM: 5, substrate: '珊瑚礁石' })],
          ['belts', () => ({ lengthM: 50, orientation: '北', observer: '' })],
          ['corals', () => ({ coverCm: 0, bleachLevel: '无', remark: '' })],
          ['fishes', () => ({ count: 0, sizeClass: '11-20cm', category: '鱼类' })]
        ]
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, factory())
            })
        }
      })

    // v3：苗圃回播业务——新增 nurseries（苗圃+批次）、outplants（回播对账台账），
    // corals 补 source / nurseryId / batchNo 与 [nurseryId+batchNo] 复合索引。
    this.version(DB_VERSION)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, source, nurseryId, batchNo, [nurseryId+batchNo], updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt',
        nurseries: 'id, no, name, keeper, updatedAt',
        outplants: 'id, nurseryId, beltId, batchNo, status, [nurseryId+beltId], updatedAt'
      })
      .upgrade(async (tx) => {
        // 旧数据没记来源：升级时把已有珊瑚记录一律标成自然珊瑚。
        await tx
          .table<CoralRecord, string>('corals')
          .toCollection()
          .modify((row) => {
            if (row.source !== 'nursery') row.source = 'natural'
            if (typeof row.nurseryId !== 'string') row.nurseryId = ''
            if (typeof row.batchNo !== 'string') row.batchNo = ''
          })
      })
  }
}

export const db = new CoralBeltDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCoral {
  id: string
  beltId: string
  genus: string
  form: CoralRecord['form']
  coverCm: number
  bleachLevel: CoralRecord['bleachLevel']
  remark: string
  /** 来源：默认自然珊瑚；回播记录置 nursery 并带苗圃/批号 */
  source?: CoralRecord['source']
  nurseryId?: string
  batchNo?: string
}

interface SeedOutplant {
  id: string
  nurseryId: string
  nurseryNo: string
  beltId: string
  beltNo: string
  batchNo: string
  coralCount: number
  coverCmTotal: number
  status: OutplantLedger['status']
  reason: string
  lastAttemptAt: number
  settledAt: number | null
}

interface SeedNursery {
  id: string
  no: string
  name: string
  location: string
  keeper: string
  remark: string
  /** 培育批次：批号 + 初始可供移出量（cm） */
  batches: Array<{ batchNo: string; availableCm: number }>
}

interface SeedFish {
  id: string
  beltId: string
  family: string
  count: number
  sizeClass: FishCount['sizeClass']
  category: FishCount['category']
}

interface SeedBelt {
  id: string
  siteId: string
  no: string
  lengthM: number
  orientation: Belt['orientation']
  surveyDate: string
  observer: string
  corals: SeedCoral[]
  fishes: SeedFish[]
}

/**
 * 播种演示数据：3 个礁区 → 4 个站位 → 5 条样带 → 14 条珊瑚记录 + 12 条鱼类计数，
 * 覆盖无 / 轻 / 中 / 重 / 死亡 全部白化等级，保证每个页面打开都有内容、层级路由也能命中真实 id。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)

  const reefs: Array<Omit<Reef, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'reef_ql01',
      name: '清澜湾珊瑚礁区',
      location: '海南文昌清澜湾东侧 3.5 km 海域',
      areaKm2: 18.6,
      protectStatus: '核心区',
      manager: '清澜湾海洋保护站'
    },
    {
      id: 'reef_yr02',
      name: '永兴岛西侧礁盘',
      location: '西沙永兴岛西侧礁盘外缘',
      areaKm2: 42.3,
      protectStatus: '缓冲区',
      manager: '西沙海洋环境监测中心'
    },
    {
      id: 'reef_dz03',
      name: '大洲岛南岸礁区',
      location: '万宁大洲岛南岸潮下带',
      areaKm2: 6.4,
      protectStatus: '实验区',
      manager: '大洲岛国家级自然保护区管理处'
    }
  ]

  const sites: Array<Omit<Site, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'site_ql_01',
      reefId: 'reef_ql01',
      no: 'S-01',
      lat: 19.5621,
      lng: 110.7924,
      depthM: 4.2,
      substrate: '珊瑚礁石'
    },
    {
      id: 'site_ql_02',
      reefId: 'reef_ql01',
      no: 'S-02',
      lat: 19.5487,
      lng: 110.8103,
      depthM: 8.6,
      substrate: '礁砂'
    },
    {
      id: 'site_yr_01',
      reefId: 'reef_yr02',
      no: 'S-01',
      lat: 16.8342,
      lng: 112.3286,
      depthM: 12.4,
      substrate: '砾石'
    },
    {
      id: 'site_dz_01',
      reefId: 'reef_dz03',
      no: 'S-01',
      lat: 18.6712,
      lng: 110.4913,
      depthM: 6.8,
      substrate: '岩礁'
    }
  ]

  const belts: SeedBelt[] = [
    {
      id: 'belt_ql01_a',
      siteId: 'site_ql_01',
      no: 'T-01',
      lengthM: 50,
      orientation: '北',
      surveyDate: today,
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01a_1', beltId: 'belt_ql01_a', genus: '鹿角珊瑚属', form: '枝状', coverCm: 860, bleachLevel: '无', remark: '长势良好' },
        { id: 'cor_ql01a_2', beltId: 'belt_ql01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 540, bleachLevel: '轻', remark: '局部褪色' },
        { id: 'cor_ql01a_3', beltId: 'belt_ql01_a', genus: '滨珊瑚属', form: '块状', coverCm: 1120, bleachLevel: '无', remark: '' },
        { id: 'cor_ql01a_4', beltId: 'belt_ql01_a', genus: '软珊瑚属', form: '软珊瑚', coverCm: 380, bleachLevel: '轻', remark: '' },
        // 苗圃 N-01 批次 2026-A 回播，带批号 → 进礁区覆盖率，但不参与白化评定
        { id: 'cor_ql01a_5', beltId: 'belt_ql01_a', genus: '鹿角珊瑚属', form: '枝状', coverCm: 300, bleachLevel: '无', remark: '苗圃回播断枝，固定基座', source: 'nursery', nurseryId: 'nur_01', batchNo: '2026-A' }
      ],
      fishes: [
        { id: 'fsh_ql01a_1', beltId: 'belt_ql01_a', family: '雀鲷科', count: 46, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_ql01a_2', beltId: 'belt_ql01_a', family: '蝴蝶鱼科', count: 18, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01a_3', beltId: 'belt_ql01_a', family: '鹦嘴鱼科', count: 7, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01a_4', beltId: 'belt_ql01_a', family: '海胆科', count: 12, sizeClass: '0-10cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_ql01_b',
      siteId: 'site_ql_01',
      no: 'T-02',
      lengthM: 50,
      orientation: '东',
      surveyDate: today,
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01b_1', beltId: 'belt_ql01_b', genus: '蔷薇珊瑚属', form: '叶状', coverCm: 720, bleachLevel: '中', remark: '边缘白化明显' },
        { id: 'cor_ql01b_2', beltId: 'belt_ql01_b', genus: '蜂巢珊瑚属', form: '块状', coverCm: 980, bleachLevel: '轻', remark: '' },
        { id: 'cor_ql01b_3', beltId: 'belt_ql01_b', genus: '鹿角珊瑚属', form: '枝状', coverCm: 430, bleachLevel: '重', remark: '大面积白化，部分死亡' },
        // 回播批号 2026-X 在苗圃 N-01 查不到 → 挂起待核定，暂不进覆盖率
        { id: 'cor_ql01b_4', beltId: 'belt_ql01_b', genus: '杯形珊瑚属', form: '枝状', coverCm: 260, bleachLevel: '无', remark: '回播标签模糊，批号待核', source: 'nursery', nurseryId: 'nur_01', batchNo: '2026-X' }
      ],
      fishes: [
        { id: 'fsh_ql01b_1', beltId: 'belt_ql01_b', family: '隆头鱼科', count: 22, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01b_2', beltId: 'belt_ql01_b', family: '刺尾鱼科', count: 15, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01b_3', beltId: 'belt_ql01_b', family: '砗磲科', count: 3, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_ql02_a',
      siteId: 'site_ql_02',
      no: 'T-01',
      lengthM: 30,
      orientation: '南',
      surveyDate: today,
      observer: '周渝',
      corals: [
        { id: 'cor_ql02a_1', beltId: 'belt_ql02_a', genus: '滨珊瑚属', form: '块状', coverCm: 1240, bleachLevel: '无', remark: '' },
        { id: 'cor_ql02a_2', beltId: 'belt_ql02_a', genus: '陀螺珊瑚属', form: '块状', coverCm: 260, bleachLevel: '死亡', remark: '仅存骨骼，附着藻类' }
      ],
      fishes: [
        { id: 'fsh_ql02a_1', beltId: 'belt_ql02_a', family: '石斑鱼科', count: 4, sizeClass: '>30cm', category: '鱼类' },
        { id: 'fsh_ql02a_2', beltId: 'belt_ql02_a', family: '海参科', count: 6, sizeClass: '21-30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_yr01_a',
      siteId: 'site_yr_01',
      no: 'T-01',
      lengthM: 100,
      orientation: '西',
      surveyDate: today,
      observer: '陈立群',
      corals: [
        { id: 'cor_yr01a_1', beltId: 'belt_yr01_a', genus: '星珊瑚属', form: '块状', coverCm: 1580, bleachLevel: '轻', remark: '' },
        { id: 'cor_yr01a_2', beltId: 'belt_yr01_a', genus: '柳珊瑚属', form: '软珊瑚', coverCm: 640, bleachLevel: '中', remark: '水流较强区域' },
        { id: 'cor_yr01a_3', beltId: 'belt_yr01_a', genus: '石芝珊瑚属', form: '叶状', coverCm: 480, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_yr01a_1', beltId: 'belt_yr01_a', family: '笛鲷科', count: 28, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_yr01a_2', beltId: 'belt_yr01_a', family: '篮子鱼科', count: 11, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_yr01a_3', beltId: 'belt_yr01_a', family: '法螺科', count: 2, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_dz01_a',
      siteId: 'site_dz_01',
      no: 'T-01',
      lengthM: 25,
      orientation: '东',
      surveyDate: today,
      observer: '陈立群',
      corals: [
        { id: 'cor_dz01a_1', beltId: 'belt_dz01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 520, bleachLevel: '重', remark: '受台风扰动后白化' },
        { id: 'cor_dz01a_2', beltId: 'belt_dz01_a', genus: '蜂巢珊瑚属', form: '块状', coverCm: 310, bleachLevel: '中', remark: '' },
        // 苗圃 N-02 批次 2026-B 回播量超过可供移出量 → 扣减失败，外业照旧、待重跑本侧
        { id: 'cor_dz01a_3', beltId: 'belt_dz01_a', genus: '鹿角珊瑚属', form: '枝状', coverCm: 900, bleachLevel: '无', remark: '回播断枝，苗圃侧可供量不足', source: 'nursery', nurseryId: 'nur_02', batchNo: '2026-B' }
      ],
      fishes: [
        { id: 'fsh_dz01a_1', beltId: 'belt_dz01_a', family: '雀鲷科', count: 34, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_dz01a_2', beltId: 'belt_dz01_a', family: '海星科', count: 5, sizeClass: '11-20cm', category: '无脊椎动物' }
      ]
    }
  ]

  /**
   * 苗圃演示数据：
   * - N-01 批次 2026-A 初始 2000 cm，已被 belt_ql01_a 回播 300 cm（confirmed），余 1700；
   *   批次 2026-X 不存在 → belt_ql01_b 的回播挂起待核定。
   * - N-02 批次 2026-B 仅余 500 cm，belt_dz01_a 回播 900 cm 超额 → 扣减失败待重跑。
   */
  const nurseries: Nursery[] = [
    {
      id: 'nur_01',
      no: 'N-01',
      name: '清澜湾陆上苗圃',
      location: '文昌清澜港北岸育苗车间',
      keeper: '何屿',
      remark: '鹿角珊瑚断枝培育为主',
      batches: [
        { batchNo: '2026-A', initialAvailableCm: 2000, availableCm: 1700 },
        { batchNo: '2026-C', initialAvailableCm: 1500, availableCm: 1500 }
      ],
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'nur_02',
      no: 'N-02',
      name: '永兴岛海上浮排苗圃',
      location: '西沙永兴岛西南潟湖浮排',
      keeper: '梁海生',
      remark: '热带枝状 / 块状珊瑚',
      batches: [{ batchNo: '2026-B', initialAvailableCm: 500, availableCm: 500 }],
      createdAt: now,
      updatedAt: now
    }
  ]

  const outplants: SeedOutplant[] = [
    {
      id: 'out_ql01a_n01_a',
      nurseryId: 'nur_01',
      nurseryNo: 'N-01',
      beltId: 'belt_ql01_a',
      beltNo: 'T-01',
      batchNo: '2026-A',
      coralCount: 1,
      coverCmTotal: 300,
      status: 'confirmed',
      reason: '',
      lastAttemptAt: now,
      settledAt: now
    },
    {
      id: 'out_ql01b_n01_x',
      nurseryId: 'nur_01',
      nurseryNo: 'N-01',
      beltId: 'belt_ql01_b',
      beltNo: 'T-02',
      batchNo: '2026-X',
      coralCount: 1,
      coverCmTotal: 260,
      status: 'pending',
      reason: '批号 2026-X 在苗圃 N-01 不存在，等苗圃组核定',
      lastAttemptAt: now,
      settledAt: null
    },
    {
      id: 'out_dz01a_n02_b',
      nurseryId: 'nur_02',
      nurseryNo: 'N-02',
      beltId: 'belt_dz01_a',
      beltNo: 'T-01',
      batchNo: '2026-B',
      coralCount: 1,
      coverCmTotal: 900,
      status: 'failed',
      reason: '可供移出量不足：需扣减 900 cm，批次 2026-B 仅剩 500 cm',
      lastAttemptAt: now,
      settledAt: null
    }
  ]

  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.nurseries, db.outplants],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset
      })

      await db.reefs.bulkPut(reefs.map((reef, index) => ({ ...reef, ...stamp(index) })))
      await db.sites.bulkPut(sites.map((site, index) => ({ ...site, ...stamp(100 + index) })))
      await db.belts.bulkPut(
        belts.map((belt, index) => {
          const { corals, fishes, ...rest } = belt
          void corals
          void fishes
          return { ...rest, ...stamp(200 + index) }
        })
      )
      await db.corals.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.corals.map((coral, coralIndex) => ({
            // 旧数据没记来源；新播种的自然记录显式标 natural，回播记录带 nursery
            source: 'natural',
            nurseryId: '',
            batchNo: '',
            ...coral,
            ...stamp(300 + beltIndex * 100 + coralIndex)
          }))
        )
      )
      await db.fishes.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.fishes.map((fish, fishIndex) => ({ ...fish, ...stamp(400 + beltIndex * 100 + fishIndex) }))
        )
      )
      await db.nurseries.bulkPut(nurseries)
      await db.outplants.bulkPut(outplants.map((item, index) => ({ ...item, ...stamp(500 + index) })))
    }
  )
}

/** 打开数据库并幂等播种：仅当礁区表为空时灌入演示数据；随后对账一次回播台账 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.reefs.count()
  if (count === 0) {
    await seedDemoData()
  }
  // 升级 / 首屏后按现有移栽珊瑚重算苗圃侧台账与可供移出量（幂等，外业数据不动）
  await reconcileOutplantsQuietly()
  stampDbVersion()
}

/** 回播对账失败不阻断外业打开（外业照旧），仅打印原因供排查 */
async function reconcileOutplantsQuietly(): Promise<void> {
  try {
    const { reconcileOutplants } = await import('@/utils/outplant')
    await reconcileOutplants()
  } catch (error) {
    console.warn('[gbcoralbelt] 回播台账初始化对账失败，外业数据不受影响：', error)
  }
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.nurseries, db.outplants],
    async () => {
      await Promise.all([
        db.reefs.clear(),
        db.sites.clear(),
        db.belts.clear(),
        db.corals.clear(),
        db.fishes.clear(),
        db.nurseries.clear(),
        db.outplants.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
  await reconcileOutplantsQuietly()
}

/** 统计各表行数，供页脚概览与覆盖度页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [reefs, sites, belts, corals, fishes, nurseries, outplants] = await Promise.all([
    db.reefs.count(),
    db.sites.count(),
    db.belts.count(),
    db.corals.count(),
    db.fishes.count(),
    db.nurseries.count(),
    db.outplants.count()
  ])
  return { reefs, sites, belts, corals, fishes, nurseries, outplants }
}

/** 写入结构版本号到 localStorage，便于覆盖度页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastReefId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastReefId)
  } catch {
    return null
  }
}

export function writeLastReefId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastReefId)
    else localStorage.setItem(LS_KEYS.lastReefId, id)
  } catch {
    // 忽略
  }
}
