<template>
  <div class="jarvis-root">

    <!-- Controls -->
    <div v-if="!running && visibleObjects.length > 0" class="hud-controls">
      <button
        class="hud-toggle"
        :class="{ active: showPrimary }"
        @click.stop="showPrimary = !showPrimary"
      >Primary</button>
      <button
        class="hud-toggle"
        :class="{ active: showSecondary }"
        @click.stop="showSecondary = !showSecondary"
      >Secondary</button>
    </div>

    <!-- Scan sweep line -->
    <div class="scan-sweep" :class="{ sweeping }" />

    <!-- Per-object targeting brackets + labels -->
    <template v-for="(obj, i) in filteredObjects" :key="`${obj.label}-${i}`">
      <svg
        class="bracket-svg"
        :class="obj.primary ? 'primary' : 'secondary'"
        :style="bracketStyle(obj)"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <polyline points="18,5 5,5 5,18" class="bracket" />
        <polyline points="82,5 95,5 95,18" class="bracket" />
        <polyline points="5,82 5,95 18,95" class="bracket" />
        <polyline points="95,82 95,95 82,95" class="bracket" />
        <template v-if="obj.primary">
          <circle cx="50" cy="50" r="2.5" class="center-dot" />
          <line x1="42" y1="50" x2="35" y2="50" class="crosshair-line" />
          <line x1="58" y1="50" x2="65" y2="50" class="crosshair-line" />
          <line x1="50" y1="42" x2="50" y2="35" class="crosshair-line" />
          <line x1="50" y1="58" x2="50" y2="65" class="crosshair-line" />
        </template>
      </svg>

      <!-- Label — primary always shows; secondary shows on hover via CSS -->
      <div
        class="hud-label"
        :class="[obj.primary ? 'primary' : 'secondary', { 'anchor-right': isRightHalf(obj) }]"
        :style="labelStyle(obj, i)"
      >
        <span class="label-bracket">[</span>
        <span class="label-text">{{ obj.label }}</span>
        <span class="label-bracket">]</span>
        <span v-if="obj.primary && obj.confidence !== 'low'" class="label-conf" :class="obj.confidence">
          {{ obj.confidence === 'high' ? '●●●' : '●●○' }}
        </span>
      </div>
    </template>

    <!-- Region flash on finding arrival -->
    <div
      v-for="(region, i) in activeRegions"
      :key="`region-${i}`"
      class="region-scan"
      :style="regionStyle(region)"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

interface DetectedObject {
  label: string
  x1: number; y1: number; x2: number; y2: number
  confidence: 'high' | 'medium' | 'low'
  primary: boolean
}

interface RegionFinding {
  regionIndex: number
  regionLabel: string
  detectedObjects?: DetectedObject[]
}

interface ActiveRegion {
  x: number; y: number; w: number; h: number
}

const props = defineProps<{
  findings: RegionFinding[]
  gridSize: number
  running: boolean
}>()

const sweeping      = ref(false)
const showPrimary   = ref(true)
const showSecondary = ref(true)
const visibleObjects = ref<DetectedObject[]>([])
const activeRegions  = ref<ActiveRegion[]>([])

const filteredObjects = computed(() =>
  visibleObjects.value.filter(o =>
    o.primary ? showPrimary.value : showSecondary.value
  )
)

watch(() => props.findings.length, (newLen, oldLen) => {
  const f = props.findings[newLen - 1]
  if (newLen > oldLen && f) revealFinding(f)
})

watch(() => props.running, (r) => {
  if (r) {
    sweeping.value = true
    visibleObjects.value = []
    activeRegions.value = []
    showPrimary.value = true
    showSecondary.value = true
  } else {
    sweeping.value = false
  }
})

function iou(a: DetectedObject, b: DetectedObject): number {
  const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1)
  const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2)
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1)
  if (inter === 0) return 0
  const aArea = (a.x2 - a.x1) * (a.y2 - a.y1)
  const bArea = (b.x2 - b.x1) * (b.y2 - b.y1)
  return inter / (aArea + bArea - inter)
}

function mergeOrAdd(incoming: DetectedObject) {
  const sameLabel = visibleObjects.value.filter(
    o => o.label.toLowerCase() === incoming.label.toLowerCase()
  )
  const overlap = sameLabel.find(o => iou(o, incoming) > 0.3)
  if (overlap) {
    // Expand the existing box to cover both
    overlap.x1 = Math.min(overlap.x1, incoming.x1)
    overlap.y1 = Math.min(overlap.y1, incoming.y1)
    overlap.x2 = Math.max(overlap.x2, incoming.x2)
    overlap.y2 = Math.max(overlap.y2, incoming.y2)
    // Keep higher confidence
    if (incoming.confidence === 'high') overlap.confidence = 'high'
    else if (incoming.confidence === 'medium' && overlap.confidence === 'low') overlap.confidence = 'medium'
    return
  }
  visibleObjects.value.push(incoming)
}

function revealFinding(finding: RegionFinding) {
  if (!finding.detectedObjects?.length) return
  const pct = 1 / props.gridSize
  const region: ActiveRegion = {
    x: (finding.regionIndex % props.gridSize) * pct,
    y: Math.floor(finding.regionIndex / props.gridSize) * pct,
    w: pct, h: pct,
  }
  activeRegions.value.push(region)

  finding.detectedObjects.forEach((obj, i) => {
    setTimeout(() => {
      mergeOrAdd({ ...obj, primary: obj.primary ?? true })
      if (i === finding.detectedObjects!.length - 1) {
        setTimeout(() => {
          activeRegions.value = activeRegions.value.filter(r => r !== region)
        }, 600)
      }
    }, i * 120 + 80)
  })
}

function bracketStyle(obj: DetectedObject) {
  const pad = 0.008
  return {
    left:   `${(obj.x1 - pad) * 100}%`,
    top:    `${(obj.y1 - pad) * 100}%`,
    width:  `${(obj.x2 - obj.x1 + pad * 2) * 100}%`,
    height: `${(obj.y2 - obj.y1 + pad * 2) * 100}%`,
  }
}

function isRightHalf(obj: DetectedObject) {
  return ((obj.x1 + obj.x2) / 2) > 0.5
}

function labelStyle(obj: DetectedObject, index: number) {
  const onRight = isRightHalf(obj)
  return {
    left:  !onRight ? `${obj.x1 * 100}%` : 'auto',
    right:  onRight ? `${(1 - obj.x2) * 100}%` : 'auto',
    top:   `calc(${obj.y1 * 100}% + 4px)`,
    animationDelay: `${index * 40}ms`,
  }
}

function regionStyle(r: ActiveRegion) {
  return {
    left: `${r.x * 100}%`, top: `${r.y * 100}%`,
    width: `${r.w * 100}%`, height: `${r.h * 100}%`,
  }
}

onMounted(() => {
  props.findings.forEach(f => revealFinding(f))
})
</script>

<style scoped>
.jarvis-root {
  position: absolute; inset: 0;
  pointer-events: none;
  overflow: hidden;
}

/* ── Controls ─────────────────────────────────────────────────── */
.hud-controls {
  position: absolute; bottom: .6rem; left: 50%;
  transform: translateX(-50%);
  display: flex; gap: .4rem;
  z-index: 20;
  pointer-events: all;
  animation: fadeUp .3s ease;
}
.hud-toggle {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px; font-weight: 500; letter-spacing: .1em;
  text-transform: uppercase;
  padding: .3rem .7rem;
  background: rgba(10,10,10,.85);
  border: 1px solid var(--border-mid);
  border-radius: 2px;
  color: var(--text-muted);
  cursor: pointer;
  transition: color .15s, border-color .15s;
}
.hud-toggle.active { color: var(--amber); border-color: rgba(245,166,35,.5); }
.hud-toggle:hover  { color: var(--text); }

/* ── Scan sweep ───────────────────────────────────────────────── */
.scan-sweep {
  position: absolute; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg, transparent 0%, var(--amber) 50%, transparent 100%);
  opacity: 0; top: 0;
}
.scan-sweep.sweeping { animation: sweep 2.4s cubic-bezier(.4,0,.6,1) infinite; }
@keyframes sweep {
  0%   { top: 0%;   opacity: 0; }
  5%   { opacity: .8; }
  95%  { opacity: .8; }
  100% { top: 100%; opacity: 0; }
}

/* ── Brackets ─────────────────────────────────────────────────── */
.bracket-svg {
  position: absolute;
  animation: bracketIn .25s ease forwards;
  opacity: 0;
  transition: opacity .2s;
}
.bracket-svg.secondary {
  opacity: 0;
  animation: bracketInDim .25s ease forwards;
}
@keyframes bracketIn    { from { opacity:0; transform:scale(.92); } to { opacity:1;    transform:scale(1); } }
@keyframes bracketInDim { from { opacity:0; transform:scale(.95); } to { opacity:0.35; transform:scale(1); } }

.bracket {
  fill: none; stroke: var(--amber); stroke-width: 4; stroke-linecap: square;
  filter: drop-shadow(0 0 3px rgba(245,166,35,.7));
}
.bracket-svg.secondary .bracket {
  stroke: rgba(245,166,35,.5);
  filter: none;
}

.center-dot {
  fill: var(--amber);
  filter: drop-shadow(0 0 4px var(--amber));
  animation: dotPulse 1.8s ease-in-out infinite;
}
@keyframes dotPulse { 0%,100% { opacity:1; r:2.5; } 50% { opacity:.5; r:1.5; } }

.crosshair-line { stroke: rgba(245,166,35,.5); stroke-width: 1.5; }

/* ── Region flash ─────────────────────────────────────────────── */
.region-scan {
  position: absolute;
  background: rgba(245,166,35,.07);
  border: 1px solid rgba(245,166,35,.3);
  animation: regionFlash .4s ease forwards;
}
@keyframes regionFlash { 0% { opacity:0; } 30% { opacity:1; } 100% { opacity:0; } }

/* ── HUD labels ───────────────────────────────────────────────── */
.hud-label {
  position: absolute;
  display: flex; align-items: center; gap: 3px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px; font-weight: 500; letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--amber);
  background: rgba(10,10,10,.82);
  padding: 2px 6px;
  border: 1px solid rgba(245,166,35,.4);
  border-radius: 2px;
  white-space: nowrap;
  text-shadow: 0 0 8px rgba(245,166,35,.6);
  z-index: 10;
  animation: labelIn .2s ease forwards;
  opacity: 0;
}
.hud-label.anchor-right { animation-name: labelInRight; }

/* Secondary labels: dimmer, no border, smaller */
.hud-label.secondary {
  font-size: 9px;
  color: rgba(245,166,35,.45);
  background: rgba(10,10,10,.65);
  border-color: rgba(245,166,35,.15);
  text-shadow: none;
  animation: labelInDim .2s ease forwards;
}

@keyframes labelIn     { from { opacity:0; transform:translateX(-4px); } to { opacity:1; transform:translateX(0); } }
@keyframes labelInRight{ from { opacity:0; transform:translateX(4px);  } to { opacity:1; transform:translateX(0); } }
@keyframes labelInDim  { from { opacity:0; } to { opacity:.7; } }

.label-bracket { opacity: .5; font-size: 9px; }
.label-conf    { font-size: 8px; }
.label-conf.high   { color: var(--green); }
.label-conf.medium { color: var(--amber); }
</style>
