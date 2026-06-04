import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  AnalysisPipelineEvent,
  ImageRegion,
  RegionFinding,
  DetectedObject,
  AnalysisSynthesis,
  AnalysisResult,
} from './types';
import { invokeNova, invokeNovaText, parseImageFormat, ImageFormat } from './bedrock';
import { publish } from './events';

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const RESULTS_TABLE = process.env.RESULTS_TABLE!;
const CDN_DOMAIN    = process.env.CDN_DOMAIN!;

const channel = (executionId: string) => `/pipeline/${executionId}`;

// ─── Pure helpers (no side effects) ──────────────────────────────

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

async function fetchImageBase64(event: AnalysisPipelineEvent): Promise<string> {
  if (event.imageS3Key && event.imageBucket) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: event.imageBucket, Key: event.imageS3Key }));
    const bytes = await obj.Body!.transformToByteArray();
    return Buffer.from(bytes).toString('base64');
  }
  return event.imageBase64!;
}

async function moderateImage(imageBase64: string, imageFormat: ImageFormat): Promise<void> {
  const prompt =
    'Does this image contain nudity, sexual content, graphic violence, gore, hate symbols, ' +
    'or other content inappropriate for a public conference booth? ' +
    'Reply with ONLY valid JSON: {"safe": true} or {"safe": false, "reason": "brief reason"}.';

  const raw = await invokeNova(prompt, imageBase64, imageFormat);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return; // unparseable → assume safe

  let result: { safe: boolean; reason?: string };
  try {
    result = JSON.parse(match[0]);
  } catch {
    return; // JSON parse failure → assume safe
  }

  if (result.safe === false) {
    throw new Error(`Image blocked: ${result.reason ?? 'inappropriate content'}`);
  }
}

async function analyzeRegion(
  imageBase64: string,
  imageFormat: ImageFormat,
  region: ImageRegion,
): Promise<RegionFinding> {
  const pct    = Math.round(100 / region.gridSize);
  const x1Base = region.col * pct / 100;
  const y1Base = region.row * pct / 100;
  const cellW  = pct / 100;

  const prompt =
    `Analyze ${region.label} of a ${region.gridSize}×${region.gridSize} image grid.\n` +
    `This region covers x:[${x1Base.toFixed(2)},${(x1Base + cellW).toFixed(2)}] ` +
    `y:[${y1Base.toFixed(2)},${(y1Base + cellW).toFixed(2)}] (normalized [0-1] of full image).\n\n` +
    `Return ONLY valid JSON (no markdown):\n` +
    `{\n` +
    `  "analysis": "2-3 sentence description",\n` +
    `  "detectedObjects": [\n` +
    `    {\n` +
    `      "label": "object name",\n` +
    `      "x1": 0.0, "y1": 0.0, "x2": 0.0, "y2": 0.0,\n` +
    `      "confidence": "high|medium|low",\n` +
    `      "primary": true\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `Coords are normalized [0-1] relative to the FULL image. ` +
    `primary=true for dominant subjects, false for background/contextual. ` +
    `Return empty array if nothing distinct is visible.`;

  const raw = await invokeNova(prompt, imageBase64, imageFormat);

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  let parsed: { analysis: string; detectedObjects: DetectedObject[] } = {
    analysis: raw.slice(0, 500),
    detectedObjects: [],
  };

  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch { /* keep defaults */ }
  }

  return {
    regionIndex: region.index,
    regionLabel: region.label,
    analysis: parsed.analysis ?? raw.slice(0, 500),
    detectedObjects: parsed.detectedObjects ?? [],
  };
}

async function synthesizeFindings(findings: RegionFinding[]): Promise<AnalysisSynthesis> {
  const n       = Math.round(Math.sqrt(findings.length));
  const summary = findings.map(f => `${f.regionLabel}: ${f.analysis}`).join('\n\n');
  const prompt  =
    `You analyzed a ${n}×${n} grid of image regions:\n\n${summary}\n\n` +
    `Synthesize the full image. Return ONLY valid JSON:\n` +
    `{ "overallDescription": string, "dominantObjects": string[], "sceneType": string, "cvInsights": string[] }\n` +
    `cvInsights: 3-5 observations relevant to computer vision (segmentation difficulty, lighting, etc.).`;

  const raw = await invokeNovaText(prompt);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Synthesis did not return valid JSON');
  return JSON.parse(jsonMatch[0]) as AnalysisSynthesis;
}

// ─── Main handler ─────────────────────────────────────────────────

export const handler = withDurableExecution(async (event: AnalysisPipelineEvent, context: DurableContext) => {
  const executionId = event.executionId ?? event.imageId;
  const ch          = channel(executionId);
  // imageFormat is deterministic from event — safe to compute outside steps
  const imageFormat = parseImageFormat(event.imageMediaType ?? 'image/jpeg');

  context.logger.info('Pipeline started', { imageId: event.imageId, executionId });

  // ── Step 1: preprocess — moderate image + build region grid ──────
  const preprocessed = await context.step('preprocess', async () => {
    const gridSize    = Number(event.gridSize ?? 3);
    const imageBase64 = await fetchImageBase64(event);
    await moderateImage(imageBase64, imageFormat);
    return { regions: buildRegions(gridSize) };
  });

  // publish() outside a step is intentional: these are fire-and-forget
  // observability events. They re-fire on replay but are idempotent.
  await publish(ch, [{ type: 'step', step: 'preprocess', status: 'done', regionCount: preprocessed.regions.length }]);
  context.logger.info('Regions extracted', { count: preprocessed.regions.length });

  // ── Step 2: context.map — parallel region inference via Bedrock ──
  await publish(ch, [{ type: 'step', step: 'analyze', status: 'running', total: preprocessed.regions.length }]);

  const mapResults = await context.map(
    'analyze-regions',
    preprocessed.regions,
    async (ctx: DurableContext, region: ImageRegion, index: number) => {
      return await ctx.step(`analyze-region-${index}`, async () => {
        // Each step fetches the image independently — bytes never cross a checkpoint
        const imageBase64 = await fetchImageBase64(event);
        const finding     = await analyzeRegion(imageBase64, imageFormat, region);

        await publish(ch, [{ type: 'region', index, status: 'done', finding }]);

        // Return only what synthesize needs — cap size to stay under 256 KB checkpoint limit
        return {
          regionIndex:      finding.regionIndex,
          regionLabel:      finding.regionLabel,
          analysis:         finding.analysis.slice(0, 500),
          detectedObjects:  (finding.detectedObjects ?? []).slice(0, 8).map(o => ({
            label:      o.label,
            x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2,
            confidence: o.confidence,
            primary:    o.primary,
          })),
        } satisfies RegionFinding;
      });
    },
    { maxConcurrency: 5 },
  );

  const successfulFindings = mapResults.succeeded().map(item => item.result as RegionFinding);

  if (mapResults.failureCount > 0) {
    mapResults.failed().forEach(item =>
      context.logger.error('Region failed', { index: item.index, error: String(item.error) })
    );
  }

  await publish(ch, [{
    type: 'step', step: 'analyze', status: 'done',
    successful: mapResults.successCount, failed: mapResults.failureCount,
  }]);
  context.logger.info('Region analysis complete', {
    total: mapResults.totalCount, successful: mapResults.successCount, failed: mapResults.failureCount,
  });

  // ── Step 3: synthesize — aggregate all region findings ───────────
  await publish(ch, [{ type: 'step', step: 'synthesize', status: 'running' }]);

  const synthesis = await context.step('synthesize', () =>
    synthesizeFindings(successfulFindings)
  );

  await publish(ch, [{ type: 'step', step: 'synthesize', status: 'done', synthesis }]);

  // ── Step 4: store — persist to DynamoDB, emit dashboard event ────
  await publish(ch, [{ type: 'step', step: 'store', status: 'running' }]);

  const stored = await context.step('store', async () => {
    const now          = new Date().toISOString();
    const thumbnailUrl = event.imageS3Key && CDN_DOMAIN
      ? `https://${CDN_DOMAIN}/${event.imageS3Key}`
      : undefined;

    await ddb.send(new PutCommand({
      TableName: RESULTS_TABLE,
      Item: {
        imageId:          event.imageId,
        executionId,
        storedAt:         now,
        ttl:              Math.floor(Date.now() / 1000) + 86400, // 24h auto-expiry
        imageS3Key:       event.imageS3Key,
        thumbnailUrl,
        regionCount:      preprocessed.regions.length,
        successfulRegions: successfulFindings.length,
        synthesis,
        findings: successfulFindings.map(f => ({
          regionIndex:     f.regionIndex,
          regionLabel:     f.regionLabel,
          analysis:        f.analysis.slice(0, 400),
          detectedObjects: (f.detectedObjects ?? []).slice(0, 10),
        })),
      },
    }));

    context.logger.info('Stored result', { imageId: event.imageId });
    return { storedAt: now, thumbnailUrl };
  });

  const finalResult: AnalysisResult = {
    imageId:           event.imageId,
    regionCount:       preprocessed.regions.length,
    successfulRegions: successfulFindings.length,
    findings:          successfulFindings,
    synthesis,
    storedAt:          stored.storedAt,
    thumbnailUrl:      stored.thumbnailUrl,
  };

  await publish(ch, [{ type: 'complete', result: finalResult }]);
  await publish('/pipeline/dashboard', [{
    type:             'new-result',
    result: {
      imageId:          finalResult.imageId,
      storedAt:         finalResult.storedAt,
      thumbnailUrl:     finalResult.thumbnailUrl,
      sceneType:        finalResult.synthesis.sceneType,
      regionCount:      finalResult.regionCount,
      successfulRegions: finalResult.successfulRegions,
    },
  }]);

  context.logger.info('Pipeline complete', { imageId: event.imageId, sceneType: synthesis.sceneType });
  return finalResult;
});
