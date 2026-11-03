import { execFile, spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const geometry = join(root, 'server/reference/geometry');
const python = join(geometry, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const geometryRunner = ['run', '--no-sync', '--project', geometry, 'python', join(geometry, 'run.py')];
const executeFile = promisify(execFile);
const help = `LittleTake local development
  setup.bat               Install web dependencies; create .env.local only if absent
  setup.bat vggt          Prepare the Python environment and local VGGT files
  setup.bat sam           Prepare optional local SAM; keep the selected provider
  setup.bat all           Prepare both local models
  run.bat [port]          Start the editor and local VGGT API (default 4176)
  run.bat --no-open       Start without opening a browser
  run.bat check           Check configuration and cached files, without inference
  run.bat geometry ...    Run the existing geometry CLI with .env.local settings

Edit .env.local for MODEL_API_KEY, SAM_PROVIDER, VGGT_MODEL_REPO,
VGGT_DEVICE and LOCAL_MODEL_MIN_FREE_VRAM_GB. CLI options override model settings.
Preparing files never runs inference. Model use must be requested explicitly.`;

function environment() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24) throw new Error('Node.js 24 or newer is required for local project storage.');
  process.chdir(root);
  if (existsSync(join(root, '.env.local'))) {
    try { process.loadEnvFile(join(root, '.env.local')); }
    catch { throw new Error('.env.local could not be loaded. Check its format; existing contents were preserved.'); }
  }
}

function command(tool, args) {
  return new Promise((resolvePromise, reject) => {
    const child = tool === 'npm' && process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm install --no-audit --no-fund'], { cwd: root, stdio: 'inherit', windowsHide: true })
      : spawn(tool, args, { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
    child.once('error', error => reject(new Error(error.code === 'ENOENT' ? `Install ${tool} and reopen this terminal before continuing.` : `${tool} could not be started.`)));
    child.once('exit', (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${tool} stopped (${signal || code}). Nothing will retry automatically.`)));
  });
}

async function ensureConfiguration() {
  try {
    await copyFile(join(root, '.env.example'), join(root, '.env.local'), constants.COPYFILE_EXCL);
    console.log('Created .env.local. Add MODEL_API_KEY there to enable Muse and cloud SAM.');
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  environment();
}

function modelOptions(args) {
  const options = [...args], operation = options[0];
  const add = (flag, value) => { if (!options.some(option => option === flag || option.startsWith(flag + '='))) options.push(flag, value); };
  if (operation === 'prepare') add('--vggt-repo', process.env.VGGT_MODEL_REPO || 'facebook/VGGT-1B');
  if (['depth', 'all'].includes(operation)) add('--depth-device', process.env.VGGT_DEVICE || 'cuda');
  if (['segment', 'depth', 'all'].includes(operation)) add('--min-free-vram-gb', process.env.LOCAL_MODEL_MIN_FREE_VRAM_GB || '16');
  return options;
}

async function setup(args) {
  const target = args[0];
  if (args.length > 1 || (target && !['vggt', 'sam', 'all'].includes(target))) throw new Error('Use setup.bat, setup.bat vggt, setup.bat sam, or setup.bat all.');
  await ensureConfiguration();
  if (!target) {
    await command('npm', ['install', '--no-audit', '--no-fund']);
    console.log('Web setup complete. Start with run.bat; local models are optional.');
    return;
  }
  await command('uv', ['--version']); await command('git', ['--version']);
  console.log('Preparing local dependencies and cached model files. No GPU inference will run.');
  let reuseEnvironment = false;
  if (existsSync(python)) try {
    const { stdout } = await executeFile(python, [join(geometry, 'run.py'), 'status', ...(target === 'vggt' ? [] : ['--include-sam'])], { cwd: root, windowsHide: true });
    reuseEnvironment = JSON.parse(stdout).dependencies.ready;
    if (reuseEnvironment) await executeFile('uv', ['pip', 'check', '--python', python], { cwd: root, windowsHide: true });
  } catch { reuseEnvironment = false; }
  if (reuseEnvironment) console.log('Reusing the compatible existing Python/CUDA environment; no reinstall.');
  else await command('uv', ['sync', '--locked', '--inexact', '--project', geometry, '--python', '3.12', ...(target === 'vggt' ? [] : ['--extra', 'sam'])]);
  await command('uv', [...geometryRunner, ...modelOptions(['prepare', '--model', target === 'sam' ? 'sam3' : target])]);
  console.log('Model setup complete. SAM_PROVIDER was not changed. Inspect with run.bat check.');
}

export async function start(args = []) {
  environment();
  if (args.some(arg => arg !== '--no-open' && !/^\d+$/.test(arg)) || args.filter(arg => /^\d+$/.test(arg)).length > 1) throw new Error('Use run.bat [port] [--no-open].');
  if (!existsSync(join(root, 'node_modules/vite/bin/vite.js'))) throw new Error('Web dependencies are missing. Run setup.bat first.');
  const explicit = args.find(arg => /^\d+$/.test(arg)) || process.env.LITTLETAKE_PORT;
  const port = Number(explicit || 4176);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a port between 1 and 65535.');
  const { createServer } = await import('vite');
  const server = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: Boolean(explicit), open: !args.includes('--no-open') } });
  await server.listen();
  console.log('LittleTake and the local VGGT API are running. Agent depth requests load the model on demand.');
  server.printUrls();
  server.bindCLIShortcuts({ print: true });
  return server;
}

async function run(args) {
  environment();
  if (args[0] === 'check') {
    if (args.length !== 1) throw new Error('Use run.bat check.');
    console.log(`Node: ${process.versions.node}\nProject: ${root}\nWeb dependencies: ${existsSync(join(root, 'node_modules/vite/bin/vite.js')) ? 'installed' : 'run setup.bat'}\n.env.local: ${existsSync(join(root, '.env.local')) ? 'present' : 'run setup.bat'}\nMODEL_API_KEY: ${process.env.MODEL_API_KEY?.trim() ? 'configured (hidden)' : 'not configured'}\nSAM_PROVIDER: ${process.env.SAM_PROVIDER || 'cloud'}\nVGGT_DEVICE: ${process.env.VGGT_DEVICE || 'cuda'}\nLOCAL_MODEL_MIN_FREE_VRAM_GB: ${process.env.LOCAL_MODEL_MIN_FREE_VRAM_GB || '16'}`);
    if (existsSync(python)) await command('uv', [...geometryRunner, 'status']);
    else console.log('Local Python environment: not installed. Use setup.bat vggt only if local depth is needed.');
  } else if (args[0] === 'geometry') {
    if (!existsSync(python)) throw new Error('The local Python environment is missing. Run setup.bat vggt first.');
    await command('uv', [...geometryRunner, ...modelOptions(args.slice(1))]);
  } else await start(args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  (async () => {
    if (args.includes('--help') && (action !== 'run' || args[0] !== 'geometry')) { console.log(help); return; }
    if (action === 'setup') await setup(args);
    else if (action === 'run') await run(args);
    else throw new Error(help);
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
