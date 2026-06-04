<template>
  <div class="dashboard-layout">

    <!-- ── Header ─────────────────────────────────────────────── -->
    <header>
      <div class="header-left">
        <span class="logo-mark">◈</span>
        <span class="site-title">Image Analysis Orchestration</span>
      </div>
      <div class="header-right">
        <span class="live-dot" :class="{ active: connected }" />
        <span class="live-label">{{ connected ? 'LIVE' : 'CONNECTING' }}</span>
        <a class="blog-btn" href="https://edjgeek.com/blog/9-tiles-to-900-cv-pipelines/" target="_blank" rel="noopener">Read the blog</a>
        <a class="scan-btn" href="/capture">+ Capture</a>
        <button class="logout-btn" @click="handleLogout">Sign out</button>
      </div>
    </header>

    <div class="body">

      <!-- ── Left: QR + CTA ──────────────────────────────────── -->
      <aside class="cta-panel">

        <!-- QR + call to action -->
        <div class="qr-wrap">
          <canvas ref="qrCanvas" class="qr-code" />
        </div>
        <p class="cta-headline">Scan to analyse<br>your own image</p>

        <!-- Live stats -->
        <div class="cta-stats">
          <div class="stat">
            <div class="stat-value">{{ results.length }}</div>
            <div class="stat-label">Images</div>
          </div>
          <div class="stat-divider" />
          <div class="stat">
            <div class="stat-value">{{ totalRegions }}</div>
            <div class="stat-label">Regions</div>
          </div>
          <div class="stat-divider" />
          <div class="stat">
            <div class="stat-value">{{ avgRegions }}</div>
            <div class="stat-label">Avg / image</div>
          </div>
        </div>

        <!-- Why regions explainer -->
        <div class="explainer">
          <div class="explainer-title">Why break images into regions?</div>
          <ul class="explainer-list">
            <li>
              <span class="explainer-icon">⊞</span>
              <span><strong>Localisation</strong> — know <em>where</em> objects are, not just <em>what</em> they are</span>
            </li>
            <li>
              <span class="explainer-icon">⚡</span>
              <span><strong>Parallelism</strong> — every region runs as an independent Lambda invocation simultaneously</span>
            </li>
            <li>
              <span class="explainer-icon">↺</span>
              <span><strong>Fault isolation</strong> — if one region fails, only that region retries — the rest keep their results</span>
            </li>
            <li>
              <span class="explainer-icon">◈</span>
              <span><strong>Checkpointed</strong> — each step is persisted; kill the pipeline mid-run and it resumes exactly where it stopped</span>
            </li>
          </ul>
        </div>

        <div class="powered-by">
          <span class="tag">AWS Lambda Durable Functions</span>
          <span class="tag">Amazon Bedrock Nova</span>
        </div>
      </aside>

      <!-- ── Right: Results grid ─────────────────────────────── -->
      <main class="grid-area">
        <p v-if="loading" class="empty-msg">Loading…</p>
        <p v-else-if="results.length === 0" class="empty-msg">
          No analyses yet — scan the QR code to be first.
        </p>
        <TransitionGroup v-else name="card-in" tag="div" class="results-grid">
          <div
            v-for="r in results"
            :key="r.imageId"
            class="result-card"
            @click="selected = r"
          >
            <div class="card-img">
              <img
                v-if="r.thumbnailUrl"
                :src="r.thumbnailUrl"
                :alt="r.imageId"
                loading="lazy"
                @error="(e) => (e.target as HTMLImageElement).style.display = 'none'"
              />
              <div class="card-img-placeholder">◈</div>
              <div class="card-badge">{{ r.successfulRegions }}/{{ r.regionCount }}</div>
              <button
                v-if="isAdmin"
                class="delete-btn"
                title="Delete"
                @click.stop="deleteResult(r.imageId)"
              >✕</button>
            </div>
            <div class="card-body">
              <div class="card-scene">{{ r.synthesis?.sceneType ?? r.sceneType ?? '—' }}</div>
              <div class="card-time">{{ formatTime(r.storedAt) }}</div>
            </div>
          </div>
        </TransitionGroup>
      </main>

    </div>

    <!-- ── Detail panel ────────────────────────────────────────── -->
    <Transition name="slide-up">
      <div v-if="selected" class="detail-overlay" @click.self="selected = null">
        <div class="detail-panel">
          <button class="detail-close" @click="selected = null">✕</button>

          <div class="detail-top">
            <div class="detail-img">
              <img v-if="selected.thumbnailUrl" :src="selected.thumbnailUrl" :alt="selected.imageId" />
              <div v-else class="card-img-placeholder large">◈</div>
              <JarvisOverlay
                v-if="selectedFindings.length"
                :findings="selectedFindings"
                :grid-size="Math.round(Math.sqrt(selected.regionCount ?? 9))"
                :running="false"
              />
            </div>
            <div class="detail-meta">
              <div class="result-meta-label">Scene type</div>
              <div class="result-scene-value">{{ selected.synthesis?.sceneType ?? selected.sceneType }}</div>
              <p class="result-description">{{ selected.synthesis?.overallDescription }}</p>
              <div class="detail-stats">
                <span>{{ selected.successfulRegions }}/{{ selected.regionCount }} regions</span>
                <span>{{ formatTime(selected.storedAt) }}</span>
              </div>
            </div>
          </div>

          <!-- Detected objects — primary + secondary -->
          <div v-if="detectedPrimary.length || detectedSecondary.length" class="detail-section">
            <div class="result-meta-label">Detected Objects</div>
            <div class="objects-group" v-if="detectedPrimary.length">
              <span class="objects-group-label">Primary</span>
              <div class="object-tags">
                <span v-for="obj in detectedPrimary" :key="obj" class="object-tag primary">{{ obj }}</span>
              </div>
            </div>
            <div class="objects-group" v-if="detectedSecondary.length" style="margin-top:.6rem">
              <span class="objects-group-label">Secondary</span>
              <div class="object-tags">
                <span v-for="obj in detectedSecondary" :key="obj" class="object-tag secondary">{{ obj }}</span>
              </div>
            </div>
          </div>

          <div v-if="selected.synthesis?.cvInsights?.length" class="detail-section">
            <div class="result-meta-label">CV Insights</div>
            <ul class="insights-list">
              <li v-for="(i, idx) in selected.synthesis.cvInsights" :key="idx">{{ i }}</li>
            </ul>
          </div>

          <div v-if="selectedFindings.length" class="detail-section">
            <div class="result-meta-label">Region Findings</div>
            <div class="region-findings">
              <div v-for="f in selectedFindings" :key="f.regionIndex" class="region-card">
                <div class="region-card-label">{{ f.regionLabel?.split(' ')[0] }}</div>
                <div class="region-card-text">{{ f.analysis }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import QRCode from 'qrcode'
import JarvisOverlay from '../components/JarvisOverlay.vue'
import { appSyncEvents } from '../services/appSyncEvents'
import { getToken, logout } from '../services/auth'

const API_BASE        = (import.meta.env.VITE_API_BASE as string).replace(/\/$/, '')
const captureUrl      = `${location.origin}/capture`
const captureUrlShort = captureUrl.replace(/^https?:\/\//, '')
const router          = useRouter()
const isAdmin         = true // always admin when logged in

function handleLogout() {
  logout()
  router.push('/login')
}

const qrCanvas   = ref<HTMLCanvasElement>()
const results    = ref<any[]>([])
const selected   = ref<any>(null)
const loading    = ref(true)
const connected  = ref(false)

const totalRegions = computed(() =>
  results.value.reduce((s, r) => s + (r.successfulRegions ?? 0), 0)
)

const avgRegions = computed(() => {
  if (!results.value.length) return 0
  return Math.round(totalRegions.value / results.value.length)
})

const selectedFindings = computed(() => selected.value?.findings ?? [])

const detectedPrimary = computed(() => {
  const seen = new Set<string>()
  return selectedFindings.value
    .flatMap((f: any) => f.detectedObjects ?? [])
    .filter((o: any) => o.primary !== false)
    .map((o: any) => o.label as string)
    .filter((l: string) => l && !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()))
})

const detectedSecondary = computed(() => {
  const seen = new Set<string>()
  const primarySet = new Set(detectedPrimary.value.map((l: string) => l.toLowerCase()))
  return selectedFindings.value
    .flatMap((f: any) => f.detectedObjects ?? [])
    .filter((o: any) => o.primary === false)
    .map((o: any) => o.label as string)
    .filter((l: string) => l && !primarySet.has(l.toLowerCase()) && !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()))
})

// ── Load initial results ───────────────────────────────────────
async function loadResults() {
  try {
    const res = await fetch(`${API_BASE}/results`)
    results.value = await res.json()
  } catch (e) {
    console.error('Failed to load results', e)
  } finally {
    loading.value = false
  }
}

// ── Fetch full detail when selecting a card ────────────────────
async function fetchDetail(imageId: string) {
  try {
    const res = await fetch(`${API_BASE}/results/${encodeURIComponent(imageId)}`)
    if (res.ok) selected.value = await res.json()
  } catch {}
}

// Watch for selection changes to load full findings
const _watch = computed(() => selected.value?.imageId)
let lastId = ''
setInterval(() => {
  const id = _watch.value
  if (id && id !== lastId && !selected.value?.findings?.length) {
    lastId = id
    fetchDetail(id)
  }
}, 200)

// ── AppSync subscription for live dashboard updates ────────────
async function subscribeToBoard() {
  // Use a separate config call to get realtime details
  // We piggyback on the /upload endpoint to get connection info
  try {
    const res = await fetch(`${API_BASE}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageMediaType: 'image/jpeg' }),
    })
    if (!res.ok) return
    const { } = await res.json() // just need the side-effect of the call

    // Re-use the static API key from VITE env (injected at build)
    const wsEndpoint  = import.meta.env.VITE_REALTIME_WS_ENDPOINT as string
    const httpEndpoint = import.meta.env.VITE_REALTIME_ENDPOINT as string
    const apiKey       = import.meta.env.VITE_REALTIME_API_KEY as string

    if (!wsEndpoint || !apiKey) return

    appSyncEvents.configure(httpEndpoint, wsEndpoint, apiKey)
    await appSyncEvents.connect()
    connected.value = true

    appSyncEvents.subscribe('/pipeline/dashboard', (event: any) => {
      if (event.type === 'new-result') {
        results.value.unshift(event.result)
      }
    })
  } catch (e) {
    console.warn('Realtime subscription failed', e)
  }
}

// ── QR code ────────────────────────────────────────────────────
async function renderQR() {
  if (!qrCanvas.value) return
  await QRCode.toCanvas(qrCanvas.value, captureUrl, {
    width: 220,
    margin: 2,
    color: { dark: '#f5a623', light: '#0a0a0a' },
  })
}

async function deleteResult(imageId: string) {
  if (!confirm(`Delete this image?`)) return
  try {
    const res = await fetch(`${API_BASE}/results/${encodeURIComponent(imageId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    })
    if (res.ok) {
      results.value = results.value.filter(r => r.imageId !== imageId)
      if (selected.value?.imageId === imageId) selected.value = null
    } else {
      alert('Delete failed: ' + (await res.text()))
    }
  } catch (e: any) {
    alert('Delete error: ' + e.message)
  }
}

function formatTime(iso: string) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch { return iso }
}

onMounted(async () => {
  await loadResults()
  renderQR()
  subscribeToBoard()
})

onUnmounted(() => appSyncEvents.disconnect())
</script>

<style scoped>
.dashboard-layout {
  display: flex; flex-direction: column;
  min-height: 100vh; background: var(--bg);
}

/* Allow the page to scroll naturally on desktop */
@media (min-width: 900px) {
  .dashboard-layout { overflow: visible; }
  html, body, #app { height: auto; overflow: visible; }
}

header {
  display: flex; align-items: center; justify-content: space-between;
  padding: .75rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  position: sticky; top: 0; z-index: 50; flex-shrink: 0;
}
.header-left { display: flex; align-items: center; gap: .6rem; }
.logo-mark { font-size: 1.1rem; color: var(--amber); animation: pulse 3s ease-in-out infinite; }
.site-title { font-family: var(--serif); font-size: 1rem; }
.header-right { display: flex; align-items: center; gap: .75rem; }

.live-dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted);
  transition: background .3s;
}
.live-dot.active { background: var(--green); box-shadow: 0 0 6px var(--green); }
.live-label { font-size: 10px; letter-spacing: .12em; color: var(--text-muted); }

.scan-btn {
  font-size: 11px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase;
  padding: .35rem .8rem; background: var(--amber); color: #0a0a0a;
  border-radius: 3px; text-decoration: none; white-space: nowrap;
  transition: opacity .2s;
}
.scan-btn:hover { opacity: .85; }

.logout-btn {
  font-size: 10px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase;
  padding: .3rem .7rem; background: transparent;
  border: 1px solid var(--border-mid); border-radius: 3px;
  color: var(--text-muted); cursor: pointer; transition: color .15s, border-color .15s;
}
.logout-btn:hover { color: var(--text); border-color: var(--text-dim); }

.blog-btn {
  font-size: 10px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase;
  padding: .3rem .7rem; border: 1px solid var(--border-mid); border-radius: 3px;
  color: var(--text-dim); text-decoration: none; white-space: nowrap;
  transition: color .15s, border-color .15s;
}
.blog-btn:hover { color: var(--amber); border-color: var(--amber); }

/* Body split */
.body {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

/* CTA sidebar */
.cta-panel {
  display: flex; flex-direction: column; align-items: center;
  gap: 1.1rem; padding: 1.5rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  flex-shrink: 0;
  width: 100%; box-sizing: border-box; overflow: hidden;
}
.qr-wrap {
  padding: .75rem; background: #0a0a0a;
  border: 1px solid var(--border-mid); border-radius: 6px;
  flex-shrink: 0;
}
.qr-code { display: block; border-radius: 3px; }
.cta-headline {
  font-family: var(--serif); font-size: 1.4rem; line-height: 1.25;
  text-align: center; color: var(--text);
}
.cta-url {
  font-size: .85rem; font-weight: 500; letter-spacing: .01em;
  color: var(--amber); text-align: center;
  word-break: break-all; width: 100%; padding: 0 .25rem;
}
.cta-stats {
  display: flex; align-items: center; justify-content: center;
  gap: .75rem; width: 100%;
}
.stat { text-align: center; flex: 1; min-width: 0; }
.stat-value { font-family: var(--serif); font-size: 2rem; color: var(--amber); line-height: 1; }
.stat-label {
  font-size: 9px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--text-muted); margin-top: .2rem;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  width: 100%;
}
.stat-divider { width: 1px; height: 2rem; background: var(--border); flex-shrink: 0; }
.powered-by { display: flex; gap: .5rem; flex-wrap: wrap; justify-content: center; }
.tag {
  font-size: 9px; font-weight: 500; letter-spacing: .07em; text-transform: uppercase;
  padding: .2rem .5rem; border: 1px solid var(--border-mid); color: var(--text-muted); border-radius: 3px;
}

/* Explainer */
.explainer {
  width: 100%;
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: 4px; padding: .9rem 1rem;
}
.explainer-title {
  font-size: 10px; font-weight: 500; letter-spacing: .1em; text-transform: uppercase;
  color: var(--text-muted); margin-bottom: .75rem;
}
.explainer-list {
  list-style: none; display: flex; flex-direction: column; gap: .65rem;
}
.explainer-list li {
  display: flex; align-items: flex-start; gap: .6rem;
  font-size: 11px; line-height: 1.5; color: var(--text-dim);
}
.explainer-list li strong { color: var(--text); }
.explainer-list li em { color: var(--amber); font-style: normal; }
.explainer-icon {
  color: var(--amber); font-size: 12px; flex-shrink: 0; margin-top: 1px;
}

/* Grid */
.grid-area { flex: 1; padding: 1.5rem; overflow-y: auto; }

.empty-msg {
  color: var(--text-dim); font-size: 15px; text-align: center;
  padding: 4rem 2rem;
}

.results-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
}

.result-card {
  background: var(--bg-raised);
  border: 1px solid var(--border-mid);
  border-left: 3px solid var(--border-mid);
  border-radius: 4px;
  overflow: hidden; cursor: pointer;
  transition: border-color .2s, border-left-color .2s, transform .15s;
}
.result-card:hover {
  border-color: var(--amber);
  border-left-color: var(--amber);
  transform: translateY(-3px);
}

.card-img {
  position: relative; aspect-ratio: 1;
  background: var(--bg-panel); overflow: hidden;
}
.card-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.card-img-placeholder {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  font-size: 2.5rem; color: var(--text-muted);
}
.card-img-placeholder.large { font-size: 3rem; }
.card-badge {
  position: absolute; bottom: .4rem; right: .4rem;
  background: rgba(10,10,10,.9); border: 1px solid rgba(245,166,35,.4);
  border-radius: 2px; font-size: 11px; font-weight: 500; padding: .2rem .5rem;
  color: var(--amber);
}
.delete-btn {
  position: absolute; top: .4rem; left: .4rem; z-index: 10;
  width: 26px; height: 26px; border-radius: 50%;
  background: rgba(224,85,85,.85); border: none;
  color: #fff; font-size: 11px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity .15s;
}
.result-card:hover .delete-btn { opacity: 1; }
.card-body { padding: .65rem .75rem; }
.card-scene {
  font-family: var(--serif); font-size: 1rem; font-weight: 400;
  color: var(--text); line-height: 1.3;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.card-time { font-size: 11px; color: #888; margin-top: .3rem; }

/* Detail overlay */
.detail-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.7);
  display: flex; align-items: flex-end; justify-content: center;
  z-index: 200; padding: 0;
}
.detail-panel {
  width: 100%; max-width: 760px; max-height: 90vh;
  background: var(--bg-panel); border: 1px solid var(--border-mid);
  border-radius: 8px 8px 0 0; padding: 1.25rem;
  overflow-y: auto; position: relative;
  display: flex; flex-direction: column; gap: 1.25rem;
}
.detail-close {
  position: absolute; top: 1rem; right: 1rem;
  background: var(--bg-raised); border: 1px solid var(--border-mid);
  color: var(--text-dim); border-radius: 50%; width: 28px; height: 28px;
  font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: color .15s;
}
.detail-close:hover { color: var(--text); }
.detail-top { display: flex; flex-direction: column; gap: 1rem; }
.detail-img {
  border-radius: 4px; overflow: hidden;
  background: var(--bg-raised); position: relative;
  /* Shrink-wrap around the image so overlay coords match */
  display: inline-block; max-width: 100%;
  align-self: center;
}
.detail-img img {
  display: block;
  max-width: 100%;
  max-height: 40vh;
  width: auto; height: auto;
}
.detail-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .5rem; }
.detail-stats { display: flex; gap: 1rem; font-size: 10px; color: var(--text-muted); margin-top: auto; }
.detail-section { display: flex; flex-direction: column; gap: .5rem; }

.result-meta-label { font-size: 9px; letter-spacing: .15em; text-transform: uppercase; color: var(--text-muted); }

.objects-group { display: flex; flex-direction: column; gap: .35rem; }
.objects-group-label { font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-muted); }
.object-tags { display: flex; flex-wrap: wrap; gap: .35rem; }
.object-tag {
  font-size: 10px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase;
  padding: .25rem .6rem; border-radius: 2px;
}
.object-tag.primary {
  background: var(--amber-dim); border: 1px solid rgba(245,166,35,.5); color: var(--amber);
}
.object-tag.secondary {
  background: var(--bg-raised); border: 1px solid var(--border-mid); color: var(--text-dim);
}
.result-scene-value { font-family: var(--serif); font-size: 1.3rem; line-height: 1.2; }
.result-description { font-size: 12px; line-height: 1.7; color: var(--text-dim); border-left: 2px solid var(--border-mid); padding-left: .75rem; }
.insights-list { list-style: none; display: flex; flex-direction: column; gap: .35rem; margin-top: .25rem; }
.insights-list li { font-size: 11px; color: var(--text-dim); padding-left: 1.25rem; position: relative; line-height: 1.6; }
.insights-list li::before { content: '→'; position: absolute; left: 0; color: var(--amber); }
.region-findings { display: grid; grid-template-columns: 1fr 1fr; gap: .4rem; }
.region-card { background: var(--bg-raised); border: 1px solid var(--border); border-radius: 3px; padding: .5rem .6rem; }
.region-card-label { font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--amber); margin-bottom: .2rem; }
.region-card-text { font-size: 10px; line-height: 1.6; color: var(--text-dim); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }

/* Transitions */
.card-in-enter-active { animation: fadeUp .35s ease; }
.card-in-move { transition: transform .3s ease; }
.slide-up-enter-active { transition: opacity .25s ease, transform .25s ease; }
.slide-up-leave-active { transition: opacity .2s ease, transform .2s ease; }
.slide-up-enter-from { opacity: 0; transform: translateY(40px); }
.slide-up-leave-to   { opacity: 0; transform: translateY(40px); }

/* Desktop: sidebar sticky left + grid scrolls right */
@media (min-width: 900px) {
  .body { flex-direction: row; overflow: visible; }

  .cta-panel {
    width: 420px; flex-shrink: 0; box-sizing: border-box;
    border-bottom: none; border-right: 1px solid var(--border);
    overflow-x: hidden;
    padding: 2rem 2rem;
    justify-content: flex-start;
    position: sticky;
    top: 0;
    height: calc(100vh - 53px);
    overflow-y: auto;
  }
  .cta-headline { font-size: 2rem; }
  .cta-url { font-size: 1.05rem; letter-spacing: 0; }
  .stat-value { font-size: 3.5rem; }
  .stat-label { font-size: 11px; }
  .explainer-list li { font-size: 12px; }

  .grid-area { overflow-y: visible; padding: 1.75rem; }
  /* 3 columns — bigger cards, readable from across the room */
  .results-grid { grid-template-columns: repeat(3, 1fr); gap: 1.25rem; align-content: start; }

  .detail-overlay { align-items: center; padding: 2rem; }
  .detail-panel { border-radius: 8px; max-height: 80vh; }
}
</style>
