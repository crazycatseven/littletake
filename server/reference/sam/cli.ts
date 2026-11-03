/** Python geometry bridge. Same SAM implementation as the web/Vercel endpoint. */
import { readFileSync } from 'node:fs';
import { loadEnv } from 'vite';
import { AIError } from '../../ai/provider.ts';
import { segmentImage, type SamReceipt } from './service.ts';

let receipt: SamReceipt | undefined;
try {
  const input = JSON.parse(readFileSync(0, 'utf8')) as { imagePath: string; prompt: string; threshold: number };
  const result = await segmentImage({ imageDataUrl: 'data:image/png;base64,' + readFileSync(input.imagePath).toString('base64'),
    prompt: input.prompt, threshold: input.threshold, provider: 'cloud' }, { ...loadEnv('development', process.cwd(), ''), ...process.env }, { onReceipt: value => { receipt = value; } });
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: error instanceof AIError ? error.code : 'segmentation_failed',
    message: error instanceof AIError ? error.message : 'SAM segmentation could not finish.' }, receipt }));
  process.exitCode = 1;
}
