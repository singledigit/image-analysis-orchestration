import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const lambda = new LambdaClient({});
const s3     = new S3Client({});
const ddb    = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PIPELINE_FUNCTION_ARN = process.env.PIPELINE_FUNCTION_ARN!;
const IMAGE_BUCKET          = process.env.IMAGE_BUCKET!;
const RESULTS_TABLE         = process.env.RESULTS_TABLE!;
const REALTIME_ENDPOINT     = process.env.REALTIME_ENDPOINT!;
const REALTIME_WS_ENDPOINT  = process.env.REALTIME_WS_ENDPOINT!;
const REALTIME_API_KEY      = process.env.REALTIME_API_KEY!;

export async function handler(event: AWSLambda.APIGatewayProxyEventV2) {
  const method = event.requestContext.http.method;
  const path   = event.requestContext.http.path;

  if (method === 'OPTIONS') return cors(204, '');

  // ── GET /results — list all results newest first ──────────────
  if (method === 'GET' && path === '/results') {
    const res = await ddb.send(new ScanCommand({ TableName: RESULTS_TABLE }));
    const items = (res.Items ?? []).sort((a, b) =>
      (b.storedAt ?? '').localeCompare(a.storedAt ?? '')
    );
    return cors(200, JSON.stringify(items));
  }

  // ── GET /results/:imageId — single result ─────────────────────
  if (method === 'GET' && path.startsWith('/results/')) {
    const imageId = decodeURIComponent(path.split('/results/')[1]);
    const res = await ddb.send(new GetCommand({ TableName: RESULTS_TABLE, Key: { imageId } }));
    if (!res.Item) return cors(404, JSON.stringify({ error: 'Not found' }));
    return cors(200, JSON.stringify(res.Item));
  }

  // ── POST /upload → presigned PUT URL ─────────────────────────
  if (method === 'POST' && path === '/upload') {
    let body: Record<string, string>;
    try { body = JSON.parse(event.body ?? '{}'); }
    catch { return cors(400, JSON.stringify({ error: 'Invalid JSON' })); }

    const { imageMediaType = 'image/jpeg' } = body;
    const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ext = imageMediaType.split('/')[1] ?? 'jpg';
    const s3Key = `uploads/${executionId}.${ext}`;

    const presignedUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: IMAGE_BUCKET, Key: s3Key, ContentType: imageMediaType }),
      { expiresIn: 300 }
    );

    return cors(200, JSON.stringify({ presignedUrl, s3Key, executionId }));
  }

  // ── POST /analyze → async pipeline trigger ────────────────────
  if (method === 'POST' && path === '/analyze') {
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body ?? '{}'); }
    catch { return cors(400, JSON.stringify({ error: 'Invalid JSON' })); }

    const { imageId, executionId, s3Key, imageMediaType, gridSize } = body as Record<string, string>;
    if (!s3Key || !executionId) return cors(400, JSON.stringify({ error: 's3Key and executionId are required' }));

    const payload = { imageId, executionId, imageS3Key: s3Key, imageBucket: IMAGE_BUCKET, imageMediaType, gridSize };
    await lambda.send(new InvokeCommand({
      FunctionName: PIPELINE_FUNCTION_ARN,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    }));

    return cors(200, JSON.stringify({
      executionId,
      channel: `/pipeline/${executionId}`,
      realtimeEndpoint: REALTIME_ENDPOINT,
      realtimeWsEndpoint: REALTIME_WS_ENDPOINT,
      apiKey: REALTIME_API_KEY,
    }));
  }

  return cors(404, JSON.stringify({ error: 'Not found' }));
}

function cors(statusCode: number, body: string) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body,
  };
}
