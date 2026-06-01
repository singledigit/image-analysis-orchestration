import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';
import { AnalysisPipelineEvent, ImageRegion, RegionFinding, AnalysisSynthesis, AnalysisResult } from './types';
import { invokeNova, invokeNovaText, parseImageFormat } from './bedrock';
import { publish } from './events';

const channel = (executionId: string) => `/pipeline/${executionId}`;

// ─── Step 1: preprocess ───────────────────────────────────────────

function buildRegions(gridSize: number): ImageRegion[] {
  const regions: ImageRegion[] = [];
  let index = 0;
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const pct = Math.round(100 / gridSize);
      regions.push({
        index,
        row,
        col,
        gridSize,
        label: `region-${row}-${col} (rows ${row * pct}–${row * pct + pct}%, cols ${col * pct}–${col * pct + pct}%)`,
      });
      index++;
    }
  }
  return regions;
}

// ─── Step 2: per-region Bedrock inference ─────────────────────────

async function analyzeRegion(
  imageBase64: string,
  imageFormat: 'jpeg' | 'png' | 'gif' | 'webp',
  region: ImageRegion
): Promise<RegionFinding> {
  const prompt =
    `You are analyzing ${region.label} of an image (a ${region.gridSize}×${region.gridSize} grid). ` +
    `Describe: 1) specific objects/entities visible, 2) visual features (textures, edges, colors), ` +
    `3) anything noteworthy for computer vision. Be concise (3-5 sentences).`;

  const analysis = await invokeNova(prompt, imageBase64, imageFormat);

  const objectMatch = analysis.match(/objects?[^:]*:\s*([^\n.]+)/i);
  const featureMatch = analysis.match(/features?[^:]*:\s*([^\n.]+)/i);

  return {
    regionIndex: region.index,
    regionLabel: region.label,
    objects: objectMatch ? objectMatch[1].split(',').map(s => s.trim()) : [],
    features: featureMatch ? featureMatch[1].split(',').map(s => s.trim()) : [],
    analysis,
  };
}

// ─── Step 3: synthesize ───────────────────────────────────────────

async function synthesizeFindings(findings: RegionFinding[]): Promise<AnalysisSynthesis> {
  const n = Math.round(Math.sqrt(findings.length));
  const summary = findings.map(f => `${f.regionLabel}: ${f.analysis}`).join('\n\n');
  const prompt =
    `You analyzed a ${n}×${n} grid of image regions:\n\n${summary}\n\n` +
    `Now synthesize the full image. Return JSON with exactly these keys:\n` +
    `{ "overallDescription": string, "dominantObjects": string[], "sceneType": string, "cvInsights": string[] }\n` +
    `cvInsights should be 3-5 observations relevant to computer vision.`;

  const raw = await invokeNovaText(prompt);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Synthesis did not return valid JSON');
  return JSON.parse(jsonMatch[0]) as AnalysisSynthesis;
}

// ─── Main handler ─────────────────────────────────────────────────

export const handler = withDurableExecution(async (event: AnalysisPipelineEvent, context: DurableContext) => {
  const executionId = event.executionId ?? event.imageId;
  const ch = channel(executionId);

  context.logger.info('Pipeline started', { imageId: event.imageId, executionId });

  // ── Step 1: preprocess ────────────────────────────────────────────
  const regions = await context.step('preprocess', async () => {
    const gridSize = event.gridSize ?? 3;
    const imageFormat = parseImageFormat(event.imageMediaType ?? 'image/jpeg');
    return { regions: buildRegions(gridSize), imageFormat };
  });

  await publish(ch, [{ type: 'step', step: 'preprocess', status: 'done', regionCount: regions.regions.length }]);
  context.logger.info('Regions extracted', { count: regions.regions.length });

  // ── Step 2: parallel map ──────────────────────────────────────────
  await publish(ch, [{ type: 'step', step: 'analyze', status: 'running', total: regions.regions.length }]);

  const mapResults = await context.map(
    'analyze-regions',
    regions.regions,
    async (ctx: DurableContext, region: ImageRegion, index: number) => {
      const finding = await ctx.step(`analyze-region-${index}`, async () =>
        analyzeRegion(event.imageBase64, regions.imageFormat, region)
      );
      // publish each region result as it completes
      await publish(ch, [{ type: 'region', index, status: 'done', finding }]);
      return finding;
    },
    { maxConcurrency: 5 }
  );

  const successfulFindings = mapResults.succeeded().map(item => item.result as RegionFinding);

  if (mapResults.failureCount > 0) {
    mapResults.failed().forEach(item => {
      context.logger.error('Region analysis failed', { index: item.index, error: String(item.error) });
    });
    await publish(ch, [{ type: 'step', step: 'analyze', status: 'done',
      successful: mapResults.successCount, failed: mapResults.failureCount }]);
  } else {
    await publish(ch, [{ type: 'step', step: 'analyze', status: 'done',
      successful: mapResults.successCount, failed: 0 }]);
  }

  context.logger.info('Region analysis complete', {
    total: mapResults.totalCount, successful: mapResults.successCount, failed: mapResults.failureCount,
  });

  // ── Step 3: synthesize ────────────────────────────────────────────
  await publish(ch, [{ type: 'step', step: 'synthesize', status: 'running' }]);

  const synthesis = await context.step('synthesize', async () =>
    synthesizeFindings(successfulFindings)
  );

  await publish(ch, [{ type: 'step', step: 'synthesize', status: 'done', synthesis }]);

  // ── Step 4: store ─────────────────────────────────────────────────
  await publish(ch, [{ type: 'step', step: 'store', status: 'running' }]);

  const storedAt = await context.step('store', async () => {
    console.log('[store] persisting result for imageId:', event.imageId);
    return new Date().toISOString();
  });

  const finalResult: AnalysisResult = {
    imageId: event.imageId,
    regionCount: regions.regions.length,
    successfulRegions: successfulFindings.length,
    findings: successfulFindings,
    synthesis,
    storedAt,
  };

  await publish(ch, [{ type: 'complete', result: finalResult }]);
  context.logger.info('Pipeline complete', { imageId: event.imageId, sceneType: synthesis.sceneType });

  return finalResult;
});
