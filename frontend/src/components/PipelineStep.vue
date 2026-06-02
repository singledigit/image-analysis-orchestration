<template>
  <div>
    <div class="step" :data-status="step.status">
      <div class="step-indicator" />
      <div class="step-body">
        <div class="step-name">{{ step.name }}</div>
        <div class="step-desc">{{ step.desc }}</div>
      </div>
      <div class="step-badge">{{ step.badge }}</div>
    </div>
    <div v-if="showConnector" class="step-connector" />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  step: { key: string; name: string; desc: string; status: string; badge: string }
  showConnector: boolean
}>()
</script>

<style scoped>
.step {
  display: flex; align-items: center; gap: 1rem;
  padding: 1rem; border: 1px solid var(--border); border-radius: 3px;
  background: var(--bg-panel); transition: border-color .25s, background .25s;
}
.step[data-status="running"] { border-color: var(--amber); background: var(--amber-dim); }
.step[data-status="done"]    { border-color: rgba(76,175,125,.3); background: var(--green-dim); }
.step[data-status="failed"]  { border-color: rgba(224,85,85,.3); }

.step-connector { width: 1px; height: 1.2rem; background: var(--border); margin-left: calc(1rem + 8px); }

.step-indicator {
  width: 16px; height: 16px; border-radius: 50%;
  border: 1px solid var(--border-mid); flex-shrink: 0;
  transition: background .25s, border-color .25s;
}
.step[data-status="running"] .step-indicator { border-color: var(--amber); background: var(--amber); animation: ping 1.2s ease-in-out infinite; }
.step[data-status="done"]    .step-indicator { border-color: var(--green); background: var(--green); }
.step[data-status="failed"]  .step-indicator { border-color: var(--red);   background: var(--red); }

.step-body { flex: 1; }
.step-name { font-size: 12px; font-weight: 500; color: var(--text); letter-spacing: .02em; }
.step[data-status="running"] .step-name { color: var(--amber); }
.step[data-status="done"]    .step-name { color: var(--green); }
.step-desc { font-size: 11px; color: var(--text-muted); margin-top: 1px; }
.step-badge { font-size: 10px; letter-spacing: .06em; color: var(--text-dim); white-space: nowrap; }
</style>
