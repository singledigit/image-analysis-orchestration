import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';
import { AnalysisPipelineEvent, ImageRegion, RegionFinding, AnalysisSynthesis, AnalysisResult } from './types';
import { invokeNova, invokeNovaText, parseImageFormat } from './bedrock';

// ─── Step 1: preprocess ──────────────────────────────────────────────────────

function buildRegions(gridSize: number): ImageRegion[] {
  const regions: ImageRegion[] = [];
  let index = 0;
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const rowPct = Math.round((100 / gridSize));
      const colPct = Math.round((100 / gridSize));
      const rStart = row * rowPct;
      const cStart = col * colPct;
      regions.push({
        index,
        row,
        col,
        gridSize,
        label: `region-${row}-${col} (rows ${rStart}–${rStart + rowPct}%, cols ${cStart}–${cStart + colPct}%)`,
      });
      index++;
    }
  }
  return regions;
}

// ─── Step 2: per-region Bedrock inference (runs in context.map) ──────────────

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

// ─── Step 3: aggregate + synthesize ─────────────────────────────────────────

async function synthesizeFindings(findings: RegionFinding[]): Promise<AnalysisSynthesis> {
  const summary = findings
    .map(f => `${f.regionLabel}: ${f.analysis}`)
    .join('\n\n');

  const prompt =
    `You analyzed a ${Math.sqrt(findings.length).toFixed(0)}×${Math.sqrt(findings.length).toFixed(0)} grid of image regions:\n\n` +
    `${summary}\n\n` +
    `Now synthesize the full image. Return JSON with exactly these keys:\n` +
    `{ "overallDescription": string, "dominantObjects": string[], "sceneType": string, "cvInsights": string[] }\n` +
    `cvInsights should be 3-5 observations relevant to computer vision (segmentation difficulty, lighting, motion blur, etc.)`;

  const raw = await invokeNovaText(prompt);

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Synthesis did not return valid JSON');
  return JSON.parse(jsonMatch[0]) as AnalysisSynthesis;
}

// ─── Step 4: store result ────────────────────────────────────────────────────

async function storeResult(result: AnalysisResult): Promise<void> {
  // In production: write to S3 or DynamoDB.
  // For demo: just log so the booth audience sees the checkpoint fire.
  console.log('[store] persisting result for imageId:', result.imageId);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export const handler = withDurableExecution(async (event: AnalysisPipelineEvent, context: DurableContext) => {
  context.logger.info('Pipeline started', { imageId: event.imageId });

  // ── Step 1: preprocess — extract regions (deterministic, but gated as a step) ──
  const regions = await context.step('preprocess', async () => {
    const gridSize = event.gridSize ?? 3;
    const imageFormat = parseImageFormat(event.imageMediaType ?? 'image/jpeg');
    return { regions: buildRegions(gridSize), imageFormat };
  });

  context.logger.info('Regions extracted', { count: regions.regions.length });

  // ── Step 2: parallel map — analyze each region via Bedrock Nova ──────────────
  const mapResults = await context.map(
    'analyze-regions',
    regions.regions,
    async (ctx: DurableContext, region: ImageRegion, index: number) => {
      return await ctx.step(`analyze-region-${index}`, async () =>
        analyzeRegion(event.imageBase64, regions.imageFormat, region)
      );
    },
    { maxConcurrency: 5 }
  );

  const successfulFindings = mapResults.succeeded().map(item => item.result as RegionFinding);
  if (mapResults.failureCount > 0) {
    mapResults.failed().forEach(item => {
      context.logger.error('Region analysis failed', {
        index: item.index,
        error: String(item.error),
      });
    });
  }
  context.logger.info('Region analysis complete', {
    total: mapResults.totalCount,
    successful: mapResults.successCount,
    failed: mapResults.failureCount,
  });

  // ── Step 3: aggregate + synthesize ──────────────────────────────────────────
  const synthesis = await context.step('synthesize', async () =>
    synthesizeFindings(successfulFindings)
  );

  // ── Step 4: store + return ────────────────────────────────────────────────────
  const storedAt = await context.step('store', async () => {
    const result: AnalysisResult = {
      imageId: event.imageId,
      regionCount: regions.regions.length,
      successfulRegions: successfulFindings.length,
      findings: successfulFindings,
      synthesis,
      storedAt: new Date().toISOString(),
    };
    await storeResult(result);
    return result.storedAt;
  });

  const finalResult: AnalysisResult = {
    imageId: event.imageId,
    regionCount: regions.regions.length,
    successfulRegions: successfulFindings.length,
    findings: successfulFindings,
    synthesis,
    storedAt,
  };

  context.logger.info('Pipeline complete', { imageId: event.imageId, sceneType: synthesis.sceneType });
  return finalResult;
});
