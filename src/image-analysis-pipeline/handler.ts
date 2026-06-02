import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { AnalysisPipelineEvent, ImageRegion, RegionFinding, AnalysisSynthesis, AnalysisResult } from './types';
import { invokeNova, invokeNovaText, parseImageFormat } from './bedrock';
import { publish } from './events';

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const RESULTS_TABLE = process.env.RESULTS_TABLE!;

const channel = (executionId: string) => `/pipeline/${executionId}`;

// ─── Helpers ──────────────────────────────────────────────────────

function buildRegions(gridSize: number): ImageRegion[] {
  const regions: ImageRegion[] = [];
  let index = 0;
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const pct = Math.round(100 / gridSize);
      regions.push({
        index, row, col, gridSize,
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
  const imageFormat = parseImageFormat(event.imageMediaType ?? 'image/jpeg');

  context.logger.info('Pipeline started', { imageId: event.imageId, executionId });

  // ── Step 1: preprocess — build grid metadata only (no image bytes) ──
  const preprocessed = await context.step('preprocess', async () => {
    const gridSize = Number(event.gridSize ?? 3);
    return { regions: buildRegions(gridSize), gridSize };
  });

  await publish(ch, [{ type: 'step', step: 'preprocess', status: 'done', regionCount: preprocessed.regions.length }]);
  context.logger.info('Regions extracted', { count: preprocessed.regions.length });

  // ── Step 2: parallel map — each region fetches image from S3 itself ──
  await publish(ch, [{ type: 'step', step: 'analyze', status: 'running', total: preprocessed.regions.length }]);

  const mapResults = await context.map(
    'analyze-regions',
    preprocessed.regions,
    async (ctx: DurableContext, region: ImageRegion, index: number) => {
      return await ctx.step(`analyze-region-${index}`, async () => {
        const imageBase64 = await fetchImageBase64(event);
        const finding = await analyzeRegion(imageBase64, imageFormat, region);
        await publish(ch, [{ type: 'region', index, status: 'done', finding }]);
        // Only checkpoint what synthesize needs — analysis capped at 500 chars
        return {
          regionIndex: finding.regionIndex,
          regionLabel: finding.regionLabel,
          analysis: finding.analysis.slice(0, 500),
        } as RegionFinding;
      });
    },
    { maxConcurrency: 5 }
  );

  const successfulFindings = mapResults.succeeded().map(item => item.result as RegionFinding);

  if (mapResults.failureCount > 0) {
    mapResults.failed().forEach(item =>
      context.logger.error('Region failed', { index: item.index, error: String(item.error) })
    );
  }
  await publish(ch, [{ type: 'step', step: 'analyze', status: 'done',
    successful: mapResults.successCount, failed: mapResults.failureCount }]);
  context.logger.info('Region analysis complete', {
    total: mapResults.totalCount, successful: mapResults.successCount, failed: mapResults.failureCount,
  });

  // ── Step 3: synthesize ─────────────────────────────────────────────
  await publish(ch, [{ type: 'step', step: 'synthesize', status: 'running' }]);

  const synthesis = await context.step('synthesize', async () =>
    synthesizeFindings(successfulFindings)
  );

  await publish(ch, [{ type: 'step', step: 'synthesize', status: 'done', synthesis }]);

  // ── Step 4: store ──────────────────────────────────────────────────
  await publish(ch, [{ type: 'step', step: 'store', status: 'running' }]);

  const storedAt = await context.step('store', async () => {
    const now = new Date().toISOString();

    // Generate a 7-day presigned GET URL for the thumbnail
    const thumbnailUrl = event.imageS3Key
      ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: event.imageBucket, Key: event.imageS3Key }), { expiresIn: 604800 })
      : undefined;

    const record = {
      imageId: event.imageId,
      executionId,
      storedAt: now,
      imageS3Key: event.imageS3Key,
      thumbnailUrl,
      regionCount: preprocessed.regions.length,
      successfulRegions: successfulFindings.length,
      synthesis,
      // Store only slim findings in DDB to keep item under 400KB
      findings: successfulFindings.map(f => ({
        regionIndex: f.regionIndex,
        regionLabel: f.regionLabel,
        analysis: f.analysis.slice(0, 400),
      })),
    };

    await ddb.send(new PutCommand({ TableName: RESULTS_TABLE, Item: record }));
    context.logger.info('Stored result', { imageId: event.imageId });

    return { storedAt: now, thumbnailUrl };
  });

  const finalResult: AnalysisResult = {
    imageId: event.imageId,
    regionCount: preprocessed.regions.length,
    successfulRegions: successfulFindings.length,
    findings: successfulFindings,
    synthesis,
    storedAt: storedAt.storedAt,
    thumbnailUrl: storedAt.thumbnailUrl,
  };

  await publish(ch, [{ type: 'complete', result: finalResult }]);

  // Notify the dashboard channel so the board updates live
  await publish('/pipeline/dashboard', [{ type: 'new-result', result: {
    imageId: finalResult.imageId,
    storedAt: finalResult.storedAt,
    thumbnailUrl: finalResult.thumbnailUrl,
    sceneType: finalResult.synthesis.sceneType,
    regionCount: finalResult.regionCount,
    successfulRegions: finalResult.successfulRegions,
  }}]);

  context.logger.info('Pipeline complete', { imageId: event.imageId, sceneType: synthesis.sceneType });
  return finalResult;
});
