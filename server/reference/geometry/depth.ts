import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PNG } from 'pngjs';
import { AIError } from '../../ai/provider.ts';
import type { AIEnvironment } from '../../ai/index.ts';
import { referenceFrameSchema } from '../../../src/reference/observations.ts';
import { data, geometry, python, runPython } from './process.ts';

const normalizedBox = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
  .refine(box => box[0] < box[2] && box[1] < box[3], 'Use an ordered normalized box.');
export const depthRegionsSchema = z.array(z.strictObject({ label: z.string().trim().min(1).max(100), box: normalizedBox })).max(16).optional().default([]);
export const depthInputSchema = z.strictObject({ sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), frame: referenceFrameSchema, regions: depthRegionsSchema });
export type DepthInput = z.input<typeof depthInputSchema>;
export interface DepthResult {
  measurementId: string; sourceId: string; frameId: string; time: number; shot: number; width: number; height: number; cached: boolean;
  model: { repo: string; revision: string; sourceRevision: string }; device: string; scale: 'relative'; camera: unknown;
  grid: unknown; regions: unknown[]; visualization: unknown; runtime: unknown; limitations: string[]; depthImageDataUrl: string;
}

/** The local API is alive with the editor; Python/CUDA exist only during a request. */
export class LocalDepthService {
  private ready = false;
  private detail = 'Local VGGT has not been checked.';
  private started?: Promise<void>;
  private current?: { key: string; controller: AbortController; promise: Promise<DepthResult> };
  private closed = false;
  constructor(private env: AIEnvironment = process.env, private execute = runPython) {}
  get available() { return this.ready && !this.closed; }
  status() { return { available: this.available, provider: 'local', model: 'VGGT', service: this.closed ? 'stopped' : 'running', busy: Boolean(this.current), loadPolicy: 'on-demand; release after request', device: this.env.VGGT_DEVICE || 'cuda', detail: this.detail }; }
  start() {
    return this.started ??= (async () => {
      if (this.env.VERCEL || !existsSync(python)) { this.detail = 'Local VGGT needs setup.bat vggt on this computer; it is unavailable on Vercel.'; return; }
      const result = await this.execute([join(geometry, 'run.py'), 'status'], this.env);
      if (!result.error) try {
        const status = JSON.parse(result.stdout);
        this.ready = Boolean(status.dependencies?.ready && status.models?.vggt?.ready && (!this.env.VGGT_MODEL_REPO || status.models.vggt.repo === this.env.VGGT_MODEL_REPO));
      } catch { /* A partial environment is reported as unavailable. */ }
      this.detail = this.ready ? 'Ready for on-demand depth. Startup does not load a GPU model.' : 'Local VGGT files or dependencies are missing. Run setup.bat vggt and restart.';
    })();
  }
  async close() {
    this.closed = true;
    this.current?.controller.abort();
    await this.current?.promise.catch(() => {});
  }
  async estimate(raw: DepthInput, signal?: AbortSignal): Promise<DepthResult> {
    await this.start(); signal?.throwIfAborted();
    if (!this.available) throw new AIError('depth_unavailable', this.detail, 503);
    const input = depthInputSchema.parse(raw), bytes = Buffer.from(input.frame.dataUrl.slice(22), 'base64');
    if (bytes.length < 24 || bytes.readUInt32BE(16) !== input.frame.width || bytes.readUInt32BE(20) !== input.frame.height) throw new AIError('invalid_reference', 'Depth pixels differ from the selected reference frame.', 400);
    try { PNG.sync.read(bytes, { checkCRC: true }); } catch { throw new AIError('invalid_reference', 'The reference PNG could not be decoded.', 400); }
    const manifest = JSON.parse(await readFile(join(data, 'models.json'), 'utf8'));
    const device = this.env.VGGT_DEVICE || 'cuda', minFree = this.env.LOCAL_MODEL_MIN_FREE_VRAM_GB || '16';
    if (!['cpu', 'cuda'].includes(device) || !Number.isFinite(Number(minFree)) || Number(minFree) < 0) throw new AIError('depth_configuration', 'Check VGGT_DEVICE and LOCAL_MODEL_MIN_FREE_VRAM_GB in .env.local.', 503);
    // A computation cache, keyed by exact source pixels and the prepared model.
    const measurementId = 'vggt-' + createHash('sha256').update(bytes).update(JSON.stringify([1, input.sourceId, input.frame.id, input.frame.width, input.frame.height, manifest.vggt, device])).digest('hex').slice(0, 32);
    const key = measurementId + JSON.stringify(input.regions);
    signal?.throwIfAborted();
    if (this.closed) throw new AIError('depth_unavailable', 'The local VGGT service stopped.', 503);
    if (this.current) {
      if (this.current.key === key) return this.current.promise;
      throw new AIError('depth_busy', 'Local VGGT is already processing another request. Do not retry automatically.', 409);
    }
    const controller = new AbortController(), stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const promise = this.measure(input, bytes, measurementId, device, minFree, controller.signal);
    this.current = { key, controller, promise };
    try { return await promise; }
    finally { signal?.removeEventListener('abort', stop); this.current = undefined; }
  }
  private async measure(input: z.output<typeof depthInputSchema>, bytes: Buffer, measurementId: string, device: string, minFree: string, signal: AbortSignal): Promise<DepthResult> {
    const run = join(data, 'runs', measurementId), requestId = randomUUID();
    await mkdir(join(run, 'requests'), { recursive: true }); await mkdir(join(run, 'responses'), { recursive: true });
    // Keep the first complete source; requests and errors get separate records.
    if (!existsSync(join(run, 'frame.json'))) {
      await writeFile(join(run, 'frame.png'), bytes);
      await writeFile(join(run, 'original.png'), bytes);
      await writeFile(join(run, 'frame.json'), JSON.stringify({ format: 'LittleTake.reference-frame', version: 1, id: input.frame.id,
        source: { kind: 'image', origin: 'depth-api', sourceId: input.sourceId, time: input.frame.time, shot: input.frame.shot }, width: input.frame.width, height: input.frame.height,
        originalSize: [input.frame.width, input.frame.height], crop: [0, 0, input.frame.width, input.frame.height], frameBounds: [0, 0, 1, 1] }));
    }
    const request = join(run, 'requests', requestId + '.json'), output = join(run, 'responses', requestId + '.json');
    await writeFile(request, JSON.stringify({ sourceId: input.sourceId, frameId: input.frame.id, regions: input.regions }));
    signal.throwIfAborted();
    const result = await this.execute([join(geometry, 'agent.py'), '--run', run, '--request', request, '--output', output, '--device', device, '--min-free-vram-gb', minFree], this.env, signal);
    await writeFile(join(run, 'responses', requestId + '.log'), result.stdout + '\n' + result.stderr);
    if (result.error) {
      const error = new AIError(signal.aborted ? 'cancelled' : 'depth_failed', signal.aborted ? 'Local VGGT was cancelled.' : 'Local VGGT could not finish. Inspect the saved geometry run and available VRAM. No model or CPU substitution was made.', 503);
      await writeFile(output, JSON.stringify({ status: error.code, sourceId: input.sourceId, frameId: input.frame.id, finishedAt: new Date().toISOString(), error: error.message }));
      throw error;
    }
    const saved = JSON.parse(await readFile(output, 'utf8'));
    if (saved.frameId !== input.frame.id || saved.sourceId !== input.sourceId || saved.width !== input.frame.width || saved.height !== input.frame.height) throw new AIError('coordinate_mismatch', 'Depth belongs to a different reference frame.', 503);
    return { ...saved, measurementId, time: input.frame.time, shot: input.frame.shot, depthImageDataUrl: 'data:image/png;base64,' + (await readFile(join(run, 'depth.png'))).toString('base64') };
  }
}
