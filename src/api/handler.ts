import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({});
const PIPELINE_FUNCTION_ARN  = process.env.PIPELINE_FUNCTION_ARN!;
const REALTIME_ENDPOINT      = process.env.REALTIME_ENDPOINT!;
const REALTIME_WS_ENDPOINT   = process.env.REALTIME_WS_ENDPOINT!;
const REALTIME_API_KEY       = process.env.REALTIME_API_KEY!;

export async function handler(event: AWSLambda.APIGatewayProxyEventV2) {
  if (event.requestContext.http.method === 'OPTIONS') {
    return cors(204, '');
  }
  if (event.requestContext.http.method !== 'POST') {
    return cors(405, JSON.stringify({ error: 'Method not allowed' }));
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return cors(400, JSON.stringify({ error: 'Invalid JSON' }));
  }

  if (!body.imageBase64) {
    return cors(400, JSON.stringify({ error: 'imageBase64 is required' }));
  }

  const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = { ...body, executionId };

  // Invoke pipeline asynchronously — return connection info immediately
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

function cors(statusCode: number, body: string) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body,
  };
}
