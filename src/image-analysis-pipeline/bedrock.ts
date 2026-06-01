import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

export const MODEL_ID = process.env.MODEL_ID ?? 'amazon.nova-lite-v1:0';

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp';

export function parseImageFormat(mediaType: string): ImageFormat {
  const part = mediaType.split('/')[1];
  if (part === 'jpg') return 'jpeg';
  if (part === 'png' || part === 'gif' || part === 'webp') return part;
  return 'jpeg';
}

export async function invokeNova(
  prompt: string,
  imageBase64: string,
  imageFormat: ImageFormat
): Promise<string> {
  const response = await client.send(new ConverseCommand({
    modelId: MODEL_ID,
    messages: [{
      role: 'user',
      content: [
        {
          image: {
            format: imageFormat,
            source: { bytes: new Uint8Array(Buffer.from(imageBase64, 'base64')) }
          }
        },
        { text: prompt }
      ]
    }],
    inferenceConfig: { maxTokens: 512 }
  }));

  const text = response.output?.message?.content?.[0]?.text;
  if (!text) throw new Error('Empty response from Nova');
  return text;
}

export async function invokeNovaText(prompt: string): Promise<string> {
  const response = await client.send(new ConverseCommand({
    modelId: MODEL_ID,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 1024 }
  }));

  const text = response.output?.message?.content?.[0]?.text;
  if (!text) throw new Error('Empty response from Nova');
  return text;
}
