/** Owned local Python processes; never install dependencies or download weights. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AIEnvironment } from '../../ai/index.ts';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const geometry = join(root, 'server/reference/geometry');
export const data = join(root, '.littletake/geometry');
export const python = join(geometry, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

export function runPython(args: string[], env: AIEnvironment, signal?: AbortSignal, timeout = 180_000) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' };
  delete childEnv.MODEL_API_KEY; delete childEnv.HF_TOKEN;
  return new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    const child = execFile(python, args, { cwd: root, env: childEnv, maxBuffer: 4_000_000, windowsHide: true }, (error, stdout, stderr) => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      resolve({ error, stdout, stderr });
    });
    let stopping = false;
    const stop = () => {
      if (stopping || !child.pid || child.exitCode !== null) return;
      stopping = true;
      // Windows venv Python can launch another interpreter. Stop this owned tree.
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else child.kill('SIGTERM');
    };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}
