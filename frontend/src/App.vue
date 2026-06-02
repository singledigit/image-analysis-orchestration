<template>
  <div class="layout">

    <!-- ── Header ──────────────────────────────────────────────── -->
    <header>
      <div class="header-left">
        <span class="logo-mark">◈</span>
        <span class="site-title">Image Analysis Orchestration</span>
      </div>
      <div class="header-right">
        <span class="tag">AWS Lambda Durable Functions</span>
        <span class="tag">Bedrock Nova</span>
      </div>
    </header>

    <main>

      <!-- ── Left: Upload + Grid ──────────────────────────────── -->
      <section class="panel panel-upload">
        <div class="panel-label">01 / INPUT</div>

        <div
          class="drop-zone"
          :class="{ 'drag-over': isDragging, 'has-image': !!imageDataUrl }"
          @click="!imageDataUrl && fileInput?.click()"
          @dragover.prevent="isDragging = true"
          @dragleave="isDragging = false"
          @drop.prevent="onDrop"
        >
          <input ref="fileInput" type="file" accept="image/*" hidden @change="onFileChange" />

          <!-- Empty state -->
          <div v-if="!imageDataUrl" class="drop-inner">
            <div class="drop-icon">⊕</div>
            <p class="drop-headline">Drop image here</p>
            <p class="drop-sub">or <button class="link-btn" @click.stop="fileInput?.click()">browse files</button></p>
            <p class="drop-formats">JPG · PNG · WEBP · GIF</p>
          </div>

          <!-- Image + grid overlay -->
          <div v-else class="image-stage">
            <img :src="imageDataUrl" alt="Preview" />
            <div
              class="grid-overlay"
              :style="{ gridTemplateColumns: `repeat(${gridSize}, 1fr)`, gridTemplateRows: `repeat(${gridSize}, 1fr)` }"
            >
              <div
                v-for="i in gridSize * gridSize"
                :key="i - 1"
                class="grid-cell"
                :class="cellStatus[i - 1]"
              >
                <span class="cell-index">{{ String(i - 1).padStart(2, '0') }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="controls">
          <label class="control-label">
            Grid size
            <span class="control-value">{{ gridSize }} × {{ gridSize }}</span>
          </label>
          <input type="range" min="2" max="4" v-model.number="gridSize" :disabled="running" />
          <button class="run-btn" :disabled="!imageDataUrl || running" @click="runPipeline">
            <span class="run-icon">{{ running ? '◌' : '▶' }}</span>
            {{ running ? 'Running…' : 'Run Pipeline' }}
          </button>
        </div>
      </section>

      <!-- ── Right: Pipeline + Results ───────────────────────── -->
      <section class="panel panel-output">
        <div class="panel-label">02 / PIPELINE</div>

        <div class="pipeline-steps">
          <PipelineStep
            v-for="(step, i) in steps"
            :key="step.key"
            :step="step"
            :show-connector="i < steps.length - 1"
          />
        </div>

        <!-- Error -->
        <div v-if="errorMsg" class="error-banner">
          <span class="error-icon">⚠</span>
          <span>{{ errorMsg }}</span>
        </div>

        <!-- Results -->
        <Transition name="fade-up">
          <div v-if="result" class="results">
            <div class="result-divider"><span>ANALYSIS COMPLETE</span></div>

            <div class="result-scene">
              <div class="result-meta-label">Scene type</div>
              <div class="result-scene-value">{{ result.synthesis.sceneType }}</div>
            </div>

            <p class="result-description">{{ result.synthesis.overallDescription }}</p>

            <div class="result-meta-label" style="margin-top:2rem">CV Insights</div>
            <ul class="insights-list">
              <li v-for="(insight, i) in result.synthesis.cvInsights" :key="i">{{ insight }}</li>
            </ul>

            <div class="result-meta-label" style="margin-top:2rem">Region Findings</div>
            <div class="region-findings">
              <TransitionGroup name="fade-up">
                <div v-for="f in findings" :key="f.regionIndex" class="region-card">
                  <div class="region-card-label">{{ f.regionLabel.split(' ')[0] }}</div>
                  <div class="region-card-text">{{ f.analysis }}</div>
                </div>
              </TransitionGroup>
            </div>

            <div class="result-footer">
              <span>stored {{ formatTime(result.storedAt) }}</span>
              <span>{{ result.successfulRegions }} / {{ result.regionCount }} regions</span>
            </div>
          </div>
        </Transition>

      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import PipelineStep from './components/PipelineStep.vue'
import { appSyncEvents } from './services/appSyncEvents'

const API_BASE = (import.meta.env.VITE_API_BASE as string).replace(/\/analyze$/, '')

// ── State ──────────────────────────────────────────────────────
const fileInput = ref<HTMLInputElement>()
const imageDataUrl = ref<string | null>(null)
const imageBase64 = ref<string | null>(null)
const imageMediaType = ref('image/jpeg')
const isDragging = ref(false)
const gridSize = ref(3)
const running = ref(false)
const errorMsg = ref<string | null>(null)
const cellStatus = ref<Record<number, string>>({})
const findings = ref<any[]>([])
const result = ref<any>(null)

const steps = reactive([
  { key: 'preprocess', name: 'preprocess',    desc: 'extract regions · validate input',          status: 'idle', badge: '' },
  { key: 'analyze',    name: 'context.map( )', desc: 'parallel region inference · Bedrock Nova',  status: 'idle', badge: '' },
  { key: 'synthesize', name: 'synthesize',     desc: 'aggregate findings · scene understanding',  status: 'idle', badge: '' },
  { key: 'store',      name: 'store',          desc: 'checkpoint result · return',                status: 'idle', badge: '' },
])

function getStep(key: string) { return steps.find(s => s.key === key)! }
function setStep(key: string, status: string, badge = '') {
  const s = getStep(key); s.status = status; s.badge = badge
}

// ── Image loading ──────────────────────────────────────────────
function loadFile(file: File) {
  imageMediaType.value = file.type || 'image/jpeg'
  const reader = new FileReader()
  reader.onload = (e) => {
    const url = e.target!.result as string
    imageDataUrl.value = url
    imageBase64.value = url.split(',')[1]
    resetPipeline()
  }
  reader.readAsDataURL(file)
}

function onFileChange(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) loadFile(f)
}
function onDrop(e: DragEvent) {
  isDragging.value = false
  const f = e.dataTransfer?.files[0]
  if (f?.type.startsWith('image/')) loadFile(f)
}

// ── Pipeline ───────────────────────────────────────────────────
function resetPipeline() {
  steps.forEach(s => { s.status = 'idle'; s.badge = '' })
  cellStatus.value = {}
  findings.value = []
  result.value = null
  errorMsg.value = null
}

async function runPipeline() {
  if (!imageBase64.value) return
  appSyncEvents.disconnect()
  resetPipeline()
  running.value = true

  const n = gridSize.value
  // Pre-fill all cells as analyzing
  for (let i = 0; i < n * n; i++) cellStatus.value[i] = 'analyzing'

  try {
    // Step 1: get presigned URL + executionId
    const uploadRes = await fetch(`${API_BASE}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageMediaType: imageMediaType.value }),
    })
    if (!uploadRes.ok) throw new Error(`Upload init failed: ${await uploadRes.text()}`)
    const { presignedUrl, s3Key, executionId } = await uploadRes.json()

    // Step 2: PUT image directly to S3
    const blob = await (await fetch(`data:${imageMediaType.value};base64,${imageBase64.value}`)).blob()
    const s3Res = await fetch(presignedUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': imageMediaType.value } })
    if (!s3Res.ok) throw new Error(`S3 upload failed: ${s3Res.status}`)

    // Step 3: trigger pipeline
    const analyzeRes = await fetch(`${API_BASE}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageId: `demo-${Date.now()}`, executionId, s3Key, imageMediaType: imageMediaType.value, gridSize: n }),
    })
    if (!analyzeRes.ok) throw new Error(`Analyze failed: ${await analyzeRes.text()}`)

    const { channel, realtimeEndpoint, realtimeWsEndpoint, apiKey } = await analyzeRes.json()

    setStep('preprocess', 'running')

    appSyncEvents.configure(realtimeEndpoint, realtimeWsEndpoint, apiKey)
    await appSyncEvents.connect()

    appSyncEvents.subscribe(channel, (event: any) => handleEvent(event))

  } catch (err: any) {
    errorMsg.value = err.message ?? String(err)
    steps.filter(s => s.status === 'running').forEach(s => s.status = 'failed')
    running.value = false
  }
}

function handleEvent(event: any) {
  if (event.type === 'step') {
    const { step, status } = event
    if (step === 'preprocess' && status === 'done') {
      setStep('preprocess', 'done', `${event.regionCount} regions`)
      setStep('analyze', 'running')
      getStep('analyze').badge = `0 / ${event.regionCount}`
    }
    if (step === 'analyze' && status === 'done') {
      setStep('analyze', 'done', `${event.successful} / ${event.successful + (event.failed ?? 0)} ok`)
    }
    if (step === 'synthesize') {
      setStep('synthesize', status === 'running' ? 'running' : 'done')
    }
    if (step === 'store' && status === 'running') {
      setStep('store', 'running')
    }
  }

  if (event.type === 'region' && event.status === 'done') {
    cellStatus.value[event.index] = 'done'
    findings.value.push(event.finding)
    const total = gridSize.value * gridSize.value
    getStep('analyze').badge = `${findings.value.length} / ${total}`
  }

  if (event.type === 'complete') {
    result.value = event.result
    setStep('store', 'done', formatTime(event.result.storedAt))
    appSyncEvents.disconnect()
    running.value = false
  }
}

function formatTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) }
  catch { return iso }
}
</script>

<style scoped>
.layout { display: flex; flex-direction: column; height: 100vh; }

header {
  display: flex; align-items: center; justify-content: space-between;
  padding: .9rem 2rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-shrink: 0;
}
.header-left { display: flex; align-items: center; gap: .75rem; }
.logo-mark { font-size: 1.25rem; color: var(--amber); animation: pulse 3s ease-in-out infinite; }
.site-title { font-family: var(--serif); font-size: 1.05rem; }
.header-right { display: flex; gap: .5rem; }
.tag { font-size: 10px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase;
       padding: .25rem .6rem; border: 1px solid var(--border-mid); color: var(--text-dim); border-radius: 3px; }

main { display: grid; grid-template-columns: 1fr 1fr; flex: 1; overflow: hidden; }

.panel { padding: 2rem; overflow-y: auto; display: flex; flex-direction: column; gap: 1.5rem; }
.panel-upload { border-right: 1px solid var(--border); }
.panel-label { font-size: 10px; font-weight: 500; letter-spacing: .15em; text-transform: uppercase; color: var(--text-muted); }

/* Drop zone */
.drop-zone {
  flex: 1; border: 1px dashed var(--border-mid); border-radius: 3px;
  position: relative; min-height: 280px; height: 0; cursor: pointer;
  transition: border-color .2s, background .2s; overflow: hidden;
}
.drop-zone:hover:not(.has-image), .drop-zone.drag-over {
  border-color: var(--amber); background: var(--amber-glow);
}
.drop-inner {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: .4rem; padding: 2rem;
}
.drop-icon { font-size: 2rem; color: var(--text-muted); margin-bottom: .5rem; transition: color .2s; }
.drop-zone:hover .drop-icon { color: var(--amber); }
.drop-headline { font-family: var(--serif); font-size: 1.1rem; }
.drop-sub { color: var(--text-dim); font-size: 12px; }
.drop-formats { font-size: 10px; letter-spacing: .1em; color: var(--text-muted); margin-top: .25rem; }
.link-btn { background: none; border: none; color: var(--amber); font-family: var(--mono); font-size: inherit;
            cursor: pointer; text-decoration: underline; text-underline-offset: 3px; padding: 0; }

.image-stage { position: absolute; inset: 0; display: flex; }
.image-stage img { width: 100%; height: 100%; object-fit: contain; display: block; background: #000; }
.grid-overlay { position: absolute; inset: 0; display: grid; pointer-events: none; }

.grid-cell { border: 1px solid rgba(245,166,35,.2); position: relative; transition: background .3s, border-color .3s; }
.grid-cell.analyzing { background: rgba(245,166,35,.15); border-color: var(--amber); }
.grid-cell.done { background: rgba(76,175,125,.12); border-color: rgba(76,175,125,.4); }
.grid-cell.failed { background: rgba(224,85,85,.12); border-color: rgba(224,85,85,.4); }
.cell-index {
  position: absolute; top: 4px; left: 6px;
  font-size: 9px; font-weight: 500; letter-spacing: .05em;
  color: rgba(245,166,35,.7); opacity: 0; transition: opacity .2s;
}
.grid-cell.analyzing .cell-index, .grid-cell.done .cell-index { opacity: 1; }

/* Controls */
.controls { display: flex; flex-direction: column; gap: .75rem; }
.control-label { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-dim); letter-spacing: .05em; }
.control-value { color: var(--amber); font-weight: 500; }
.run-btn {
  display: flex; align-items: center; justify-content: center; gap: .6rem;
  padding: .8rem 1.5rem; background: var(--amber); color: #0a0a0a;
  border: none; border-radius: 3px; font-family: var(--mono);
  font-size: 12px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase;
  cursor: pointer; transition: opacity .2s, transform .15s;
}
.run-btn:hover:not(:disabled) { opacity: .9; transform: translateY(-1px); }
.run-btn:disabled { opacity: .3; cursor: not-allowed; }
.run-icon { font-size: 10px; }

/* Pipeline */
.pipeline-steps { display: flex; flex-direction: column; }

/* Results */
.results { display: flex; flex-direction: column; gap: 1rem; }
.result-divider { display: flex; align-items: center; gap: .75rem; color: var(--text-muted); font-size: 9px; letter-spacing: .2em; text-transform: uppercase; }
.result-divider::before, .result-divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.result-meta-label { font-size: 9px; letter-spacing: .15em; text-transform: uppercase; color: var(--text-muted); }
.result-scene-value { font-family: var(--serif); font-size: 1.6rem; line-height: 1.2; margin-top: .25rem; }
.result-description { font-size: 12px; line-height: 1.7; color: var(--text-dim); border-left: 2px solid var(--border-mid); padding-left: .75rem; }
.insights-list { list-style: none; display: flex; flex-direction: column; gap: .4rem; margin-top: .5rem; }
.insights-list li { font-size: 11px; line-height: 1.6; color: var(--text-dim); padding-left: 1.25rem; position: relative; }
.insights-list li::before { content: '→'; position: absolute; left: 0; color: var(--amber); }
.region-findings { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-top: .5rem; }
.region-card { background: var(--bg-raised); border: 1px solid var(--border); border-radius: 3px; padding: .6rem .75rem; }
.region-card-label { font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--amber); margin-bottom: .3rem; }
.region-card-text { font-size: 10px; line-height: 1.6; color: var(--text-dim); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.result-footer { display: flex; justify-content: space-between; font-size: 10px; color: var(--text-muted); padding-top: 1rem; border-top: 1px solid var(--border); margin-top: .5rem; }

.error-banner { display: flex; align-items: flex-start; gap: .75rem; padding: 1rem; border: 1px solid rgba(224,85,85,.3); background: rgba(224,85,85,.06); border-radius: 3px; font-size: 11px; color: var(--red); line-height: 1.6; }
.error-icon { font-size: 1rem; flex-shrink: 0; }

.fade-up-enter-active { animation: fadeUp .4s ease; }
.fade-up-move { transition: transform .3s ease; }
</style>
