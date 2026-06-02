<template>
  <div class="jarvis-root">
    <!-- Scan sweep line -->
    <div class="scan-sweep" :class="{ sweeping }" />

    <!-- Per-object targeting brackets + labels -->
    <template v-for="(obj, i) in visibleObjects" :key="`${obj.label}-${i}`">
      <svg
        class="bracket-svg"
        :style="bracketStyle(obj)"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <!-- Corner brackets — top-left -->
        <polyline points="18,5 5,5 5,18" class="bracket" />
        <!-- top-right -->
        <polyline points="82,5 95,5 95,18" class="bracket" />
        <!-- bottom-left -->
        <polyline points="5,82 5,95 18,95" class="bracket" />
        <!-- bottom-right -->
        <polyline points="95,82 95,95 82,95" class="bracket" />
        <!-- Center crosshair dot -->
        <circle cx="50" cy="50" r="2.5" class="center-dot" />
        <line x1="42" y1="50" x2="35" y2="50" class="crosshair-line" />
        <line x1="58" y1="50" x2="65" y2="50" class="crosshair-line" />
        <line x1="50" y1="42" x2="50" y2="35" class="crosshair-line" />
        <line x1="50" y1="58" x2="50" y2="65" class="crosshair-line" />
      </svg>

      <!-- HUD label -->
      <div
        class="hud-label"
        :class="{ left: isRightHalf(obj) }"
        :style="labelStyle(obj, i)"
      >
        <span class="label-bracket">[</span>
        <span class="label-text">{{ obj.label }}</span>
        <span class="label-bracket">]</span>
        <span v-if="obj.confidence !== 'low'" class="label-conf" :class="obj.confidence">
          {{ obj.confidence === 'high' ? '●●●' : '●●○' }}
        </span>
      </div>
    </template>

    <!-- Per-region dim overlays while scanning -->
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

const sweeping = ref(false)
const visibleObjects = ref<DetectedObject[]>([])
const activeRegions = ref<ActiveRegion[]>([])

// Trigger scan sweep + reveal objects whenever new findings arrive
watch(() => props.findings.length, (newLen, oldLen) => {
  const f = props.findings[newLen - 1]
  if (newLen > oldLen && f) revealFinding(f)
})

watch(() => props.running, (r) => {
  if (r) {
    sweeping.value = true
    visibleObjects.value = []
    activeRegions.value = []
  } else {
    sweeping.value = false
  }
})

function revealFinding(finding: RegionFinding) {
  if (!finding.detectedObjects?.length) return
  const pct = 1 / props.gridSize
  const region: ActiveRegion = {
    x: (finding.regionIndex % props.gridSize) * pct,
    y: Math.floor(finding.regionIndex / props.gridSize) * pct,
    w: pct,
    h: pct,
  }
  activeRegions.value.push(region)

  // Stagger objects into view
  finding.detectedObjects.forEach((obj, i) => {
    setTimeout(() => {
      visibleObjects.value.push(obj)
      // Remove region dim overlay once objects are shown
      if (i === (finding.detectedObjects!.length - 1)) {
        setTimeout(() => {
          activeRegions.value = activeRegions.value.filter(r => r !== region)
        }, 600)
      }
    }, i * 120 + 80)
  })
}

function bracketStyle(obj: DetectedObject) {
  const pad = 0.01
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
  const onRight = !isRightHalf(obj)
  return {
    left:  onRight ? `${obj.x2 * 100}%` : 'auto',
    right: !onRight ? `${(1 - obj.x1) * 100}%` : 'auto',
    top:   `${obj.y1 * 100}%`,
    animationDelay: `${index * 40}ms`,
  }
}

function regionStyle(r: ActiveRegion) {
  return {
    left:   `${r.x * 100}%`,
    top:    `${r.y * 100}%`,
    width:  `${r.w * 100}%`,
    height: `${r.h * 100}%`,
  }
}

onMounted(() => {
  // Reveal any findings that loaded before mount (e.g. result view)
  props.findings.forEach(f => revealFinding(f))
})
</script>

<style scoped>
.jarvis-root {
  position: absolute; inset: 0;
  pointer-events: none;
  overflow: hidden;
}

/* Scan sweep */
.scan-sweep {
  position: absolute; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent 0%, var(--amber) 50%, transparent 100%);
  opacity: 0;
  top: 0;
}
.scan-sweep.sweeping {
  animation: sweep 2.4s cubic-bezier(.4,0,.6,1) infinite;
}
@keyframes sweep {
  0%   { top: 0%;   opacity: 0; }
  5%   { opacity: .8; }
  95%  { opacity: .8; }
  100% { top: 100%; opacity: 0; }
}

/* Corner bracket SVG */
.bracket-svg {
  position: absolute;
  animation: bracketIn .25s ease forwards;
  opacity: 0;
}
@keyframes bracketIn {
  from { opacity: 0; transform: scale(.92); }
  to   { opacity: 1; transform: scale(1); }
}

.bracket {
  fill: none;
  stroke: var(--amber);
  stroke-width: 4;
  stroke-linecap: square;
  filter: drop-shadow(0 0 3px rgba(245,166,35,.7));
}

.center-dot {
  fill: var(--amber);
  filter: drop-shadow(0 0 4px var(--amber));
  animation: dotPulse 1.8s ease-in-out infinite;
}
@keyframes dotPulse {
  0%,100% { opacity: 1; r: 2.5; }
  50%      { opacity: .5; r: 1.5; }
}

.crosshair-line {
  stroke: rgba(245,166,35,.5);
  stroke-width: 1.5;
}

/* Region scan dim */
.region-scan {
  position: absolute;
  background: rgba(245,166,35,.07);
  border: 1px solid rgba(245,166,35,.3);
  animation: regionFlash .4s ease forwards;
}
@keyframes regionFlash {
  0%   { opacity: 0; }
  30%  { opacity: 1; }
  100% { opacity: 0; }
}

/* HUD labels */
.hud-label {
  position: absolute;
  display: flex; align-items: center; gap: 3px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px; font-weight: 500;
  color: var(--amber);
  background: rgba(10,10,10,.82);
  padding: 2px 6px;
  border: 1px solid rgba(245,166,35,.4);
  border-radius: 2px;
  white-space: nowrap;
  margin-left: 6px;
  animation: labelIn .2s ease forwards;
  opacity: 0;
  text-shadow: 0 0 8px rgba(245,166,35,.6);
  z-index: 10;
}
.hud-label.left {
  margin-left: 0;
  margin-right: 6px;
}
@keyframes labelIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
.hud-label.left { animation-name: labelInLeft; }
@keyframes labelInLeft {
  from { opacity: 0; transform: translateX(4px); }
  to   { opacity: 1; transform: translateX(0); }
}

.label-bracket { opacity: .5; font-size: 10px; }
.label-text { letter-spacing: .04em; text-transform: uppercase; font-size: 10px; }
.label-conf { font-size: 8px; letter-spacing: .02em; }
.label-conf.high   { color: var(--green); }
.label-conf.medium { color: var(--amber); }
</style>
