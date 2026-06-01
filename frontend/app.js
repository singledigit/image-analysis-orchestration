// ── Config ────────────────────────────────────────────────────────
// Populated at deploy time from CloudFormation ApiUrl output.
const API_ENDPOINT = window.PIPELINE_API_ENDPOINT || '/analyze';

// ── State ─────────────────────────────────────────────────────────
let imageFile   = null;
let imageBase64 = null;
let ws          = null;

// ── DOM refs ──────────────────────────────────────────────────────
const dropZone    = document.getElementById('dropZone');
const dropInner   = document.getElementById('dropInner');
const fileInput   = document.getElementById('fileInput');
const browseBtn   = document.getElementById('browseBtn');
const imageStage  = document.getElementById('imageStage');
const previewImg  = document.getElementById('previewImg');
const gridOverlay = document.getElementById('gridOverlay');
const gridSizeEl  = document.getElementById('gridSize');
const gridLabel   = document.getElementById('gridLabel');
const runBtn      = document.getElementById('runBtn');
const regionBadge = document.getElementById('regionBadge');
const results     = document.getElementById('results');
const errorBanner = document.getElementById('errorBanner');
const errorMsg    = document.getElementById('errorMessage');

const stepEls = {
  preprocess: document.getElementById('step-preprocess'),
  analyze:    document.getElementById('step-analyze'),
  synthesize: document.getElementById('step-synthesize'),
  store:      document.getElementById('step-store'),
};

// ── Grid size slider ──────────────────────────────────────────────
gridSizeEl.addEventListener('input', () => {
  const n = +gridSizeEl.value;
  gridLabel.textContent = `${n} × ${n}`;
  if (imageFile) buildGrid(n);
});

// ── Drop / file pick ──────────────────────────────────────────────
browseBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
dropZone.addEventListener('click', () => { if (!imageFile) fileInput.click(); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadImage(fileInput.files[0]); });

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) loadImage(f);
});

function loadImage(file) {
  imageFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    imageBase64 = dataUrl.split(',')[1];
    previewImg.src = dataUrl;
    dropInner.hidden = true;
    imageStage.hidden = false;
    buildGrid(+gridSizeEl.value);
    runBtn.disabled = false;
    resetPipeline();
  };
  reader.readAsDataURL(file);
}

// ── Grid ──────────────────────────────────────────────────────────
function buildGrid(n) {
  gridOverlay.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  gridOverlay.style.gridTemplateRows    = `repeat(${n}, 1fr)`;
  gridOverlay.innerHTML = '';
  for (let i = 0; i < n * n; i++) {
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    cell.id = `cell-${i}`;
    const idx = document.createElement('div');
    idx.className = 'cell-index';
    idx.textContent = String(i).padStart(2, '0');
    cell.appendChild(idx);
    gridOverlay.appendChild(cell);
  }
}

function setCellStatus(index, status) {
  const cell = document.getElementById(`cell-${index}`);
  if (cell) { cell.classList.remove('analyzing', 'done', 'failed'); if (status) cell.classList.add(status); }
}

// ── Pipeline UI helpers ───────────────────────────────────────────
function setStep(key, status, badge = '') {
  const el = stepEls[key];
  if (!el) return;
  el.dataset.status = status;
  const b = el.querySelector('.step-badge');
  if (b) b.textContent = badge;
}

function resetPipeline() {
  Object.keys(stepEls).forEach(k => setStep(k, 'idle', ''));
  regionBadge.textContent = '';
  results.hidden = true;
  errorBanner.hidden = true;
  document.querySelectorAll('.grid-cell').forEach(c => c.classList.remove('analyzing', 'done', 'failed'));
  document.getElementById('regionFindings').innerHTML = '';
  document.getElementById('insightsList').innerHTML = '';
}

// ── Run ────────────────────────────────────────────────────────────
runBtn.addEventListener('click', runPipeline);

async function runPipeline() {
  if (!imageBase64) return;
  if (ws) { ws.close(); ws = null; }

  resetPipeline();
  runBtn.disabled = true;
  runBtn.classList.add('running');
  runBtn.querySelector('.run-icon').textContent = '◌';

  const n = +gridSizeEl.value;

  try {
    // 1. POST to API — returns executionId + AppSync connection info immediately
    const res = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageId: `demo-${Date.now()}`,
        imageBase64,
        imageMediaType: imageFile.type || 'image/jpeg',
        gridSize: n,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const { executionId, channel, realtimeWsEndpoint, apiKey } = await res.json();

    // 2. Subscribe to AppSync Events WebSocket channel
    setStep('preprocess', 'running');
    openRealtimeChannel(realtimeWsEndpoint, apiKey, channel, n);

  } catch (err) {
    showError(err.message || String(err));
    resetRunBtn();
  }
}

// ── AppSync Events WebSocket ──────────────────────────────────────
// Protocol: https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html
function openRealtimeChannel(wsEndpoint, apiKey, channel, gridN) {
  // Encode the connection init header as base64 JSON
  const header = btoa(JSON.stringify({ 'x-api-key': apiKey }));
  const payload = btoa(JSON.stringify({}));
  const url = `${wsEndpoint}?header=${header}&payload=${payload}`;

  ws = new WebSocket(url, ['aws-appsync-event-ws']);
  let regionsDone = 0;
  let regionsTotal = gridN * gridN;

  ws.onopen = () => {
    // Send connection_init
    ws.send(JSON.stringify({ type: 'connection_init' }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    switch (msg.type) {

      case 'connection_ack':
        // Subscribe to our channel
        ws.send(JSON.stringify({
          type: 'subscribe',
          id: '1',
          channel,
          authorization: { 'x-api-key': apiKey },
        }));
        break;

      case 'subscribe_success':
        // Subscribed — pipeline is already running
        break;

      case 'data': {
        const event = JSON.parse(msg.event ?? '{}');
        handlePipelineEvent(event, gridN, {
          onRegionDone: (idx) => {
            regionsDone++;
            setCellStatus(idx, 'done');
            regionBadge.textContent = `${regionsDone} / ${regionsTotal}`;
          },
          onRegionFailed: (idx) => {
            setCellStatus(idx, 'failed');
          },
          onComplete: () => {
            ws.close(); ws = null;
            resetRunBtn();
          },
        });
        break;
      }

      case 'ka':  // keep-alive — ignore
        break;

      default:
        if (msg.type?.includes('error')) showError(JSON.stringify(msg));
    }
  };

  ws.onerror = (e) => {
    showError('WebSocket error — check console');
    console.error('AppSync WS error', e);
    resetRunBtn();
  };

  ws.onclose = (e) => {
    if (e.code !== 1000 && e.code !== 1001) {
      // Abnormal close
      console.warn('AppSync WS closed unexpectedly', e.code, e.reason);
    }
  };

  // Mark all cells as "analyzing" immediately for visual feedback
  for (let i = 0; i < gridN * gridN; i++) setCellStatus(i, 'analyzing');
}

// ── Handle individual pipeline events ────────────────────────────
function handlePipelineEvent(event, gridN, { onRegionDone, onRegionFailed, onComplete }) {
  if (event.type === 'step') {
    const { step, status, regionCount, successful, failed } = event;

    if (step === 'preprocess' && status === 'done') {
      setStep('preprocess', 'done', `${regionCount} regions`);
      setStep('analyze', 'running');
      regionBadge.textContent = `0 / ${regionCount}`;
    }

    if (step === 'analyze' && status === 'done') {
      setStep('analyze', 'done', `${successful} / ${successful + (failed || 0)} ok`);
    }

    if (step === 'synthesize') {
      if (status === 'running') setStep('synthesize', 'running');
      if (status === 'done') {
        setStep('synthesize', 'done');
        // Render synthesis immediately — don't wait for complete
        if (event.synthesis) renderSynthesis(event.synthesis);
      }
    }

    if (step === 'store') {
      if (status === 'running') setStep('store', 'running');
    }
  }

  if (event.type === 'region') {
    const { index, status, finding } = event;
    if (status === 'done') {
      onRegionDone(index);
      if (finding) appendRegionCard(finding);
    } else {
      onRegionFailed(index);
    }
  }

  if (event.type === 'complete') {
    const { result } = event;
    setStep('store', 'done', formatTime(result.storedAt));

    document.getElementById('resultTimestamp').textContent = `stored ${formatTime(result.storedAt)}`;
    document.getElementById('resultRegionCount').textContent = `${result.successfulRegions} / ${result.regionCount} regions`;

    results.hidden = false;
    onComplete();
  }
}

// ── Render helpers ────────────────────────────────────────────────
function renderSynthesis(synthesis) {
  document.getElementById('resultSceneType').textContent = synthesis.sceneType || '—';
  document.getElementById('resultDescription').textContent = synthesis.overallDescription || '';

  const list = document.getElementById('insightsList');
  list.innerHTML = '';
  (synthesis.cvInsights || []).forEach(insight => {
    const li = document.createElement('li');
    li.textContent = insight;
    list.appendChild(li);
  });

  results.hidden = false;
}

function appendRegionCard(finding) {
  const container = document.getElementById('regionFindings');
  const existing = document.getElementById(`finding-${finding.regionIndex}`);
  if (existing) return; // replay guard

  const card = document.createElement('div');
  card.className = 'region-card';
  card.id = `finding-${finding.regionIndex}`;
  card.style.animationDelay = '0ms';
  card.innerHTML = `
    <div class="region-card-label">${finding.regionLabel.split(' ')[0]}</div>
    <div class="region-card-text">${finding.analysis}</div>
  `;
  container.appendChild(card);
}

// ── Utils ──────────────────────────────────────────────────────────
function resetRunBtn() {
  runBtn.disabled = false;
  runBtn.classList.remove('running');
  runBtn.querySelector('.run-icon').textContent = '▶';
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorBanner.hidden = false;
  Object.entries(stepEls).forEach(([k, el]) => {
    if (el.dataset.status === 'running') setStep(k, 'failed');
  });
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch { return iso; }
}
