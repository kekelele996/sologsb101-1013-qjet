<script setup lang="ts">
/**
 * <SourceTag> 珊瑚来源标签：自然珊瑚 / 苗圃回播。
 * 被珊瑚计数页、覆盖度汇总页与苗圃台账页消费。
 * 移栽记录额外展示批号与挂起状态，方便两边对账。
 */
import { computed } from 'vue'
import type { CoralSource } from '@/types/coralRecord'
import { CORAL_SOURCE_LABEL } from '@/types/coralRecord'

const props = withDefaults(
  defineProps<{
    source: CoralSource
    /** 培育批次号 */
    batchNo?: string
    /** 苗圃编号 */
    nurseryNo?: string
    /** 挂起（未带批号 / 对账不上）时以警示样式渲染 */
    pending?: boolean
    size?: 'default' | 'small'
  }>(),
  {
    batchNo: '',
    nurseryNo: '',
    pending: false,
    size: 'default'
  }
)

const isNursery = computed(() => props.source === 'nursery')
const tip = computed(() => {
  if (!isNursery.value) return '自然珊瑚（外业普查）：计入覆盖率与白化评定'
  const batch = props.batchNo ? `批号 ${props.batchNo}` : '未带批号'
  const nursery = props.nurseryNo ? `苗圃 ${props.nurseryNo}` : '未挂苗圃'
  if (props.pending) return `苗圃回播 · ${nursery} · ${batch}，对账不上已挂起，暂不进覆盖率`
  return `苗圃回播 · ${nursery} · ${batch}：进礁区覆盖率，但不参与白化评定`
})
</script>

<template>
  <el-tooltip :content="tip" placement="top">
    <span
      class="source-tag"
      :class="[`is-${size}`, isNursery ? (pending ? 'is-pending' : 'is-nursery') : 'is-natural']"
    >
      <span class="source-tag__dot" />
      <span class="source-tag__text">{{ CORAL_SOURCE_LABEL[source] }}</span>
      <span v-if="isNursery && batchNo" class="source-tag__batch">{{ batchNo }}</span>
      <span v-else-if="isNursery" class="source-tag__batch">待核定</span>
    </span>
  </el-tooltip>
</template>

<style scoped>
.source-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 9px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
}

.source-tag.is-small {
  padding: 0 7px;
  font-size: 11px;
  line-height: 18px;
}

.source-tag__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.source-tag__batch {
  font-weight: 600;
  opacity: 0.92;
}

.source-tag.is-natural {
  color: #3f9ec4;
  background: #e9f5fb;
  border-color: #b6dcef;
}

.source-tag.is-nursery {
  color: #7d5b12;
  background: #fbf4e0;
  border-color: #e8d297;
}

.source-tag.is-pending {
  color: #c0392b;
  background: #fdecea;
  border-color: #f2b6ad;
}
</style>
