/** Local HTTP requests use the same offline SAM runner as the geometry CLI. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { PNG } from 'pngjs';
import type { AIEnvironment } from '../../ai/index.ts';
import { AIError } from '../../ai/provider.ts';
import { SAM_MODEL, type SamReceipt, type SamResult } from './service.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const geometry = join(root, 'server/reference/geometry');
const data = join(root, '.littletake/geometry');
const python = join(geometry, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
let running = false;

export function localAvailable(env: AIEnvironment) {
  if (env.VERCEL || !existsSync(python) || !existsSync(join(data, 'vendor/sam3/sam3/model_builder.py'))) return false;
  try { return Boolean(JSON.parse(readFileSync(join(data, 'models.json'), 'utf8')).sam3); }
  catch { return false; }
}

export async function segmentLocalImage(input: { bytes: Buffer; width: number; height: number; prompt: string; threshold: number }, env: AIEnvironment,
  options: { signal?: AbortSignal; onReceipt?(receipt: SamReceipt): void }): Promise<SamResult> {
  if (!localAvailable(env)) throw new AIError('local_unavailable', 'Prepare the local SAM Python environment and weights on this server. Vercel supports cloud SAM.', 503);
  if (running) throw new AIError('local_busy', 'Local SAM is already running. Retry explicitly after it finishes.', 409);
  options.signal?.throwIfAborted();
  running = true;
  const started = performance.now(), id = 'sam-http-' + randomUUID(), run = join(data, 'runs', id);
  const receipt: SamReceipt = { model: SAM_MODEL, prompt: input.prompt, status: 'running', elapsedSeconds: 0, rawOutput: '', responseId: id };
  try {
    await mkdir(run, { recursive: true });
    await writeFile(join(run, 'frame.png'), input.bytes);
    await writeFile(join(run, 'original.png'), input.bytes);
    await writeFile(join(run, 'frame.json'), JSON.stringify({ format: 'LittleTake.reference-frame', version: 1, id,
      source: { kind: 'image', origin: 'segmentation-api' }, originalSize: [input.width, input.height], width: input.width, height: input.height,
      crop: [0, 0, input.width, input.height], frameBounds: [0, 0, 1, 1] }));
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' };
    delete childEnv.MODEL_API_KEY;
    const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
      // Windows venv Python can launch a second interpreter. Cancel the owned
      // process tree so a disconnected request cannot leave CUDA work behind.
      const child = execFile(python, [join(geometry, 'run.py'), 'segment', '--sam-provider', 'local', '--run', run,
        '--threshold', String(input.threshold), '--concepts', input.prompt],
      { cwd: root, env: childEnv, maxBuffer: 4_000_000, windowsHide: true },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', stop);
        resolve({ error, stdout, stderr });
      });
      let stopping = false;
      const stop = () => {
        if (stopping || !child.pid || child.exitCode !== null) return;
        stopping = true;
        if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else child.kill('SIGTERM');
      };
      const timer = setTimeout(stop, 150_000);
      options.signal?.addEventListener('abort', stop, { once: true });
      if (options.signal?.aborted) stop();
    });
    await writeFile(join(run, 'local-process.log'), result.stdout + '\n' + result.stderr);
    if (result.error) throw new AIError(options.signal?.aborted ? 'cancelled' : 'local_inference_failed', 'Local SAM could not finish. Check the saved run diagnostics, prepared dependencies and free VRAM.', 503);
    const saved = JSON.parse(await readFile(join(run, 'segmentation.json'), 'utf8'));
    if (saved.frameId !== id || saved.status !== 'complete' || saved.width !== input.width || saved.height !== input.height) {
      throw new AIError('coordinate_mismatch', 'Local SAM did not return a completed segmentation of this frame.');
    }
    const instances: SamResult['instances'] = [];
    for (const item of saved.instances) {
      const [left, top, right, bottom] = item.box as number[];
      const full = PNG.sync.read(await readFile(join(run, item.mask)));
      if (full.width !== input.width || full.height !== input.height || !(0 <= left && left < right && right <= input.width && 0 <= top && top < bottom && bottom <= input.height)) {
        throw new AIError('coordinate_mismatch', 'Local SAM masks differ from the source frame.');
      }
      const cropped = new PNG({ width: right - left, height: bottom - top });
      PNG.bitblt(full, cropped, left, top, cropped.width, cropped.height, 0, 0);
      instances.push({ objectId: String(item.samId), box: item.box, score: item.score, pixels: item.pixels,
        mask: { width: cropped.width, height: cropped.height, pngBase64: PNG.sync.write(cropped, { colorType: 0 }).toString('base64') } });
    }
    receipt.status = 'completed';
    return { source: { provider: 'local', model: SAM_MODEL, ...saved.model }, width: input.width, height: input.height,
      prompt: input.prompt, threshold: input.threshold, instances, diagnostics: [], receipt };
  } catch (error) {
    receipt.status = error instanceof AIError ? error.code : options.signal?.aborted ? 'cancelled' : 'local_inference_failed';
    if (error instanceof AIError) throw error;
    throw new AIError(receipt.status, 'Local SAM could not finish. No provider substitution was made.', 503);
  } finally {
    receipt.elapsedSeconds = (performance.now() - started) / 1000;
    running = false;
    options.onReceipt?.(receipt);
  }
}
