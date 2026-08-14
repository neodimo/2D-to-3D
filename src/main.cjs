'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');
const { app, BrowserWindow, dialog, ipcMain, shell, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const { PNG } = require('pngjs');
const { defaultColorSpaceFor, loadImage, makePreviewPngDataUrl } = require('./lib/image-loader.cjs');
const { clamp01 } = require('./lib/color.cjs');
const {
  PIXAL3D_REPO_URL,
  PIXAL3D_UPSTREAM_SHA,
  PIXAL3D_INTEGRATION_REVISION,
  PIXAL3D_REMBG_MODEL,
  PIXAL3D_REMBG_REVISION,
  PIXAL3D_LICENSE_SUMMARY,
  pixal3dInstallMarkerName,
  resolvePixal3DProfile,
  buildPixal3DInferenceArgs,
  assertNativeUpstreamContract,
  hasPixal3DWindowsPatch,
  patchPixal3DWindowsSource: applyPixal3DWindowsPatch,
} = require('./lib/pixal3d.cjs');

let mainWindow;
let activeProcess = null;
let updateDownloaded = false;
let superSplatViewerReady = null;
let superSplatServerReady = null;

// Force ANGLE/D3D11 on Windows so Electron's Chromium uses the D3D11 backend for WebGL.
// Without this, the integrated Intel GPU often wins and WebGL fails to create a context.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'd3d11');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  // Prevent the GPU process from blacklisting the high-performance discrete GPU.
  app.commandLine.appendSwitch('ignore-gpu-blacklist', 'true');
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  app.commandLine.appendSwitch('enable-features', 'Vulkan,UnsafeWebGPU');
  // Disable Viz display compositor which can interfere with WebGL context creation on some systems
  app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#101217',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}


function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdateState({ status: 'checking', message: 'Checking for updates…' }));
  autoUpdater.on('update-available', (info) => sendUpdateState({ status: 'available', message: `Update ${info.version} available.`, info }));
  autoUpdater.on('update-not-available', (info) => sendUpdateState({ status: 'none', message: `You're up to date (${info.version || app.getVersion()}).`, info }));
  autoUpdater.on('download-progress', (progress) => sendUpdateState({
    status: 'downloading',
    message: `Downloading update… ${Math.round(progress.percent || 0)}%`,
    progress,
  }));
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    sendUpdateState({ status: 'downloaded', message: 'Update ready. Restart the app to finish.', info });
  });
  autoUpdater.on('error', (err) => sendUpdateState({ status: 'error', message: err.message || String(err) }));
}

app.whenReady().then(() => {
  setupAutoUpdater();
  createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function sendLog(line) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('job-log', String(line));
}

function sendJobState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('job-state', state);
}

function sendUpdateState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-state', state);
}

function runProbe(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 5000,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

function detectNvidiaGpus() {
  const query = runProbe('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (!query) return [];
  return query.split(/\r?\n/).map((line) => {
    const [name, memoryTotalMb, driverVersion] = line.split(',').map((part) => part.trim());
    return { vendor: 'NVIDIA', name, memoryTotalMb: Number(memoryTotalMb) || null, driverVersion };
  }).filter((gpu) => gpu.name);
}

function detectWindowsDisplayGpus() {
  if (process.platform !== 'win32') return [];
  const output = runProbe('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress'
  ], { timeout: 8000 });
  if (!output) return [];
  try {
    const parsed = JSON.parse(output);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map((item) => ({
      vendor: /nvidia/i.test(item.Name || '') ? 'NVIDIA' : (/amd|radeon/i.test(item.Name || '') ? 'AMD' : (/intel/i.test(item.Name || '') ? 'Intel' : 'GPU')),
      name: item.Name || 'Unknown GPU',
      memoryTotalMb: item.AdapterRAM ? Math.round(Number(item.AdapterRAM) / 1024 / 1024) : null,
      driverVersion: item.DriverVersion || '',
    })).filter((gpu) => gpu.name);
  } catch (_) {
    return [];
  }
}

function hardwareStatus() {
  const cudaGpus = detectNvidiaGpus();
  const displayGpus = detectWindowsDisplayGpus();
  const inferenceGpu = cudaGpus[0] || null;
  const viewerGpu = displayGpus.find((gpu) => /nvidia|radeon|amd/i.test(`${gpu.vendor} ${gpu.name}`)) || displayGpus[0] || inferenceGpu || null;
  return {
    platform: process.platform,
    inference: {
      backend: inferenceGpu ? 'CUDA' : 'CPU',
      gpu: inferenceGpu,
      gpus: cudaGpus,
    },
    viewer: {
      backend: 'Electron WebGPU/WebGL',
      gpu: viewerGpu,
      gpus: displayGpus,
      features: app.getGPUFeatureStatus(),
    },
  };
}

function compareVersions(a, b) {
  const pa = String(a || '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b || '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function isPackagedWin() {
  return app.isPackaged && process.platform === 'win32';
}

function appRoot() {
  return app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
}

function resourcesRoot() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', 'vendor');
}

function runtimeRoot() {
  return path.join(app.getPath('userData'), 'sharp-runtime');
}

function legacyRuntimeRoot() {
  return path.join(appRoot(), 'sharp-runtime');
}

function previousProductUserDataRoot() {
  return path.join(app.getPath('appData'), 'ML-Sharp GUI');
}

function migrateDirIfNeeded(source, target, label) {
  if (source === target || fs.existsSync(target) || !fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(source, target);
    sendLog(`Migrated ${label} to 2D to 3D user-data location: ${target}`);
  } catch (err) {
    sendLog(`Could not move legacy ${label} automatically: ${err.message || err}`);
    sendLog(`If needed, copy ${source} to ${target}`);
  }
}

function migrateLegacyRuntimeIfNeeded() {
  const current = runtimeRoot();
  const legacy = legacyRuntimeRoot();
  const previous = previousProductUserDataRoot();
  migrateDirIfNeeded(path.join(previous, 'sharp-runtime'), current, 'sharp-runtime');
  migrateDirIfNeeded(path.join(previous, 'pixal3d-experimental'), pixal3dRoot(), 'Pixal3D backend');
  migrateDirIfNeeded(path.join(previous, 'sharp-360-backend'), panorama360Root(), '360 backend');
  migrateDirIfNeeded(path.join(previous, 'infinidepth-experimental'), infinidepthRoot(), 'InfiniDepth backend');
  migrateDirIfNeeded(legacy, current, 'sharp-runtime');
}

function mlSharpSourcePath() {
  return path.join(resourcesRoot(), 'ml-sharp');
}

function writableMlSharpSourcePath() {
  return path.join(runtimeRoot(), 'install-sources', 'ml-sharp');
}

function prepareWritableMlSharpSource() {
  const source = mlSharpSourcePath();
  const target = writableMlSharpSourcePath();
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    filter: (entry) => !/([/\\])(__pycache__|\.pytest_cache|sharp\.egg-info)([/\\]|$)/.test(entry),
  });
  return target;
}

function uvPath() {
  if (process.platform === 'win32') {
    const bundled = path.join(resourcesRoot(), 'uv', 'uv.exe');
    if (fs.existsSync(bundled)) return bundled;
    return 'uv.exe';
  }
  const bundled = path.join(resourcesRoot(), 'uv', 'uv');
  if (fs.existsSync(bundled)) return bundled;
  return 'uv';
}

function venvPythonPath() {
  if (process.platform === 'win32') return path.join(runtimeRoot(), 'venv', 'Scripts', 'python.exe');
  return path.join(runtimeRoot(), 'venv', 'bin', 'python');
}

function sharpExePath() {
  if (process.platform === 'win32') return path.join(runtimeRoot(), 'venv', 'Scripts', 'sharp.exe');
  return path.join(runtimeRoot(), 'venv', 'bin', 'sharp');
}

function runtimePythonEnv(extra = {}) {
  const venvDir = path.join(runtimeRoot(), 'venv');
  const binDir = process.platform === 'win32' ? path.join(venvDir, 'Scripts') : path.join(venvDir, 'bin');
  return {
    UV_PYTHON_INSTALL_DIR: path.join(runtimeRoot(), 'uv-python'),
    UV_CACHE_DIR: path.join(runtimeRoot(), 'uv-cache'),
    UV_LINK_MODE: 'copy',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    VIRTUAL_ENV: venvDir,
    PATH: binDir + path.delimiter + (process.env.PATH || ''),
    ...extra,
  };
}

function parsePyvenvConfig(venvDir = path.join(runtimeRoot(), 'venv')) {
  const cfg = path.join(venvDir, 'pyvenv.cfg');
  if (!fs.existsSync(cfg)) return {};
  const values = {};
  for (const line of fs.readFileSync(cfg, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (match) values[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return values;
}

function resolvedVenvPythonPath(venvDir = path.join(runtimeRoot(), 'venv')) {
  const shim = venvPythonPath();
  const cfg = parsePyvenvConfig(venvDir);
  const candidates = [];
  if (cfg.executable) candidates.push(cfg.executable);
  if (cfg['base-executable']) candidates.push(cfg['base-executable']);
  if (cfg.home) candidates.push(path.join(cfg.home, process.platform === 'win32' ? 'python.exe' : 'python'));
  candidates.push(shim);
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || shim;
}

function canRunPythonSync(command, env = runtimePythonEnv()) {
  if (!command || !fs.existsSync(command)) return false;
  const result = spawnSync(command, ['-c', 'import sys; print(sys.executable)'], {
    cwd: appRoot(),
    env: { ...process.env, ...env },
    windowsHide: true,
    shell: false,
    timeout: 15000,
    encoding: 'utf8',
  });
  return result.status === 0;
}

function sharpCommand() {
  return {
    command: venvPythonPath(),
    argsPrefix: ['-c', 'from sharp.cli import main_cli; main_cli()'],
  };
}

function panorama360Root() {
  return path.join(app.getPath('userData'), 'sharp-360-backend');
}

function panorama360RepoPath() {
  return path.join(panorama360Root(), 'SHARP_360_to_Splat');
}

function panorama360InstallMarkerPath() {
  return path.join(panorama360Root(), 'install-v1.json');
}

function infinidepthRoot() {
  return path.join(app.getPath('userData'), 'infinidepth-experimental');
}

function infinidepthRepoPath() {
  return path.join(infinidepthRoot(), 'InfiniDepth');
}

function infinidepthVenvPath() {
  return path.join(infinidepthRoot(), 'venv');
}

function infinidepthPythonPath() {
  if (process.platform === 'win32') return path.join(infinidepthVenvPath(), 'Scripts', 'python.exe');
  return path.join(infinidepthVenvPath(), 'bin', 'python');
}

function infinidepthInstallMarkerPath() {
  return path.join(infinidepthRoot(), 'install-v1.json');
}

function pixal3dRoot() {
  return path.join(app.getPath('userData'), 'pixal3d-experimental');
}

function pixal3dRepoPath() {
  return path.join(pixal3dRoot(), 'Pixal3D');
}

function pixal3dVenvPath() {
  return path.join(pixal3dRoot(), 'venv');
}

function pixal3dPythonPath() {
  if (process.platform === 'win32') return path.join(pixal3dVenvPath(), 'Scripts', 'python.exe');
  return path.join(pixal3dVenvPath(), 'bin', 'python');
}

function pixal3dInstallMarkerPath() {
  return path.join(pixal3dRoot(), pixal3dInstallMarkerName());
}

function pixal3dCurrentRevision(repo = pixal3dRepoPath()) {
  if (!fs.existsSync(path.join(repo, '.git'))) return '';
  return runProbe('git', ['rev-parse', 'HEAD'], { cwd: repo, timeout: 8000 }) || '';
}

function readPixal3DInstallMarker() {
  const marker = pixal3dInstallMarkerPath();
  if (!fs.existsSync(marker)) return null;
  try {
    return JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch (_) {
    return null;
  }
}

const PIXAL3D_WINDOWS_WHEELS_BASE = 'https://raw.githubusercontent.com/visualbruno/ComfyUI-Trellis2/86d13d9eac4a2bd4395954c7184d3aa4fa81a9d8/wheels/Windows/Torch270';
const PIXAL3D_WINDOWS_WHEELS = [
  ['cumesh-1.0-cp311-cp311-win_amd64.whl', 'f6ec70f31fa24ebef0026ea5d622fce4314e22e2c56979219598fdd6e4df3b28'],
  ['flex_gemm-0.0.1-cp311-cp311-win_amd64.whl', '3a1b8ef109735cc8f19729a007abb48b9a91815f350bc10cc513f5c7e27608f2'],
  ['nvdiffrast-0.4.0-cp311-cp311-win_amd64.whl', '6d273cc912143a306389ec7b5e0fa44efbe45ea7577f86d8f13ce6b209c56c3e'],
  ['nvdiffrec_render-0.0.0-cp311-cp311-win_amd64.whl', 'c0e4bf4ea6622ddff0eea0ca8b9be75a48318db62a7184891bcb0f1da65d1f8c'],
  ['o_voxel-0.0.1-cp311-cp311-win_amd64.whl', 'da17f251f05ea31c1d0ad2fa3e4b7e025463cb9a12a66fb8ddb3b28634ad1636'],
];

function pixal3dWindowsWheelRequirements() {
  return PIXAL3D_WINDOWS_WHEELS.map(([fileName, sha256]) => `${PIXAL3D_WINDOWS_WHEELS_BASE}/${fileName}#sha256=${sha256}`);
}

const PIXAL3D_WINDOWS_INFERENCE_DEPS = [
  'transformers==4.57.3',
  'kornia==0.8.2',
  'timm==1.0.22',
  'imageio==2.37.2',
  'imageio-ffmpeg==0.6.0',
  'einops==0.8.1',
];

function pixal3dExecutionEnv(extra = {}) {
  const profile = extra.PIXAL3D_PROFILE || process.env.PIXAL3D_PROFILE || 'compat';
  const rembgModel = extra.PIXAL3D_REMBG_MODEL || process.env.PIXAL3D_REMBG_MODEL || PIXAL3D_REMBG_MODEL;
  const rembgRevision = extra.PIXAL3D_REMBG_REVISION
    || process.env.PIXAL3D_REMBG_REVISION
    || (rembgModel === PIXAL3D_REMBG_MODEL ? PIXAL3D_REMBG_REVISION : '');
  const cudaAllocConf = profile === 'aggressive'
    ? 'expandable_segments:True,max_split_size_mb:256,garbage_collection_threshold:0.8'
    : (extra.PYTORCH_CUDA_ALLOC_CONF || process.env.PYTORCH_CUDA_ALLOC_CONF || '');
  const env = {
    ...extra,
    ATTN_BACKEND: process.platform === 'win32' ? 'sdpa' : (extra.ATTN_BACKEND || process.env.ATTN_BACKEND || 'flash_attn'),
    SPARSE_ATTN_BACKEND: process.platform === 'win32' ? 'sdpa' : (extra.SPARSE_ATTN_BACKEND || process.env.SPARSE_ATTN_BACKEND || 'flash_attn'),
    HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
    PYTHONUNBUFFERED: '1',
    CUDA_MODULE_LOADING: extra.CUDA_MODULE_LOADING || process.env.CUDA_MODULE_LOADING || 'LAZY',
    TORCH_ALLOW_TF32_CUBLAS_OVERRIDE: profile === 'aggressive' || profile === 'full' ? '1' : (extra.TORCH_ALLOW_TF32_CUBLAS_OVERRIDE || process.env.TORCH_ALLOW_TF32_CUBLAS_OVERRIDE || ''),
    NVIDIA_TF32_OVERRIDE: profile === 'aggressive' || profile === 'full' ? '1' : (extra.NVIDIA_TF32_OVERRIDE || process.env.NVIDIA_TF32_OVERRIDE || ''),
    PIXAL3D_PROFILE: profile,
    PIXAL3D_WINDOWS_CAT_GUARD: process.platform === 'win32' && profile !== 'full' ? '1' : '0',
    PIXAL3D_REMBG_MODEL: process.platform === 'win32' ? rembgModel : (extra.PIXAL3D_REMBG_MODEL || process.env.PIXAL3D_REMBG_MODEL || ''),
    PIXAL3D_REMBG_REVISION: process.platform === 'win32' ? rembgRevision : (extra.PIXAL3D_REMBG_REVISION || process.env.PIXAL3D_REMBG_REVISION || ''),
  };
  if (cudaAllocConf) env.PYTORCH_CUDA_ALLOC_CONF = cudaAllocConf;
  return env;
}

function patchPixal3DWindowsSource(repo) {
  if (process.platform === 'win32') {
    const result = applyPixal3DWindowsPatch(repo, sendLog);
    if (!hasPixal3DWindowsPatch(repo)) {
      throw new Error('Pixal3D Windows patch verification failed after applying the pinned integration.');
    }
    return result;
  }
  assertNativeUpstreamContract(repo);
  return { upstreamSha: PIXAL3D_UPSTREAM_SHA, integrationRevision: PIXAL3D_INTEGRATION_REVISION };
}
function ensureDirs() {
  migrateLegacyRuntimeIfNeeded();
  fs.mkdirSync(runtimeRoot(), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot(), 'converted-inputs'), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot(), 'logs'), { recursive: true });
}

function quoteForLog(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || appRoot(),
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
      shell: false,
    });
    activeProcess = child;
    const commandLine = [command, ...args].map(quoteForLog).join(' ');
    const recentOutput = [];
    const rememberOutput = (chunk) => {
      const text = chunk.toString().trimEnd();
      if (!text) return;
      sendLog(text);
      for (const line of text.split(/\r?\n/)) {
        recentOutput.push(line);
        if (recentOutput.length > 40) recentOutput.shift();
      }
    };
    sendLog(`> ${commandLine}`);
    child.stdout.on('data', rememberOutput);
    child.stderr.on('data', rememberOutput);
    child.on('error', (err) => {
      activeProcess = null;
      err.message = `${err.message}\nCommand: ${commandLine}`;
      reject(err);
    });
    child.on('close', (code) => {
      activeProcess = null;
      if (code === 0) resolve();
      else {
        const tail = recentOutput.length ? `\n\nLast output:\n${recentOutput.join('\n')}` : '';
        reject(new Error(`Command exited with code ${code}\nCommand: ${commandLine}${tail}`));
      }
    });
  });
}

async function checkRuntimeStatus() {
  migrateLegacyRuntimeIfNeeded();
  const root = runtimeRoot();
  const py = venvPythonPath();
  const sharp = sharpExePath();
  const ml = mlSharpSourcePath();
  const uv = uvPath();
  const resolvedPython = resolvedVenvPythonPath();
  const pythonRunnable = canRunPythonSync(py);
  return {
    runtimeRoot: root,
    mlSharpSource: ml,
    uv,
    uvExists: uv === 'uv' || uv === 'uv.exe' ? false : fs.existsSync(uv),
    python: py,
    resolvedPython,
    pythonExists: fs.existsSync(py),
    pythonRunnable,
    sharp: sharp,
    sharpExists: fs.existsSync(sharp),
    ready: pythonRunnable && fs.existsSync(sharp),
  };
}

async function installRuntime() {
  ensureDirs();
  const ml = mlSharpSourcePath();
  if (!fs.existsSync(path.join(ml, 'requirements.txt'))) {
    throw new Error(`Bundled ml-sharp source not found at ${ml}`);
  }
  sendJobState({ busy: true, label: 'Installing SHARP runtime' });
  sendLog('Installing/checking Python + Apple SHARP runtime. First run can take a while because PyTorch is large.');

  const uv = uvPath();
  const venvDir = path.join(runtimeRoot(), 'venv');
  const env = runtimePythonEnv();

  const py = venvPythonPath();
  if (fs.existsSync(py) && canRunPythonSync(py, env)) {
    sendLog(`Reusing existing Python virtual environment: ${venvDir}`);
  } else {
    const venvArgs = ['venv', venvDir, '--python', '3.13', '--python-preference', 'managed'];
    if (fs.existsSync(venvDir)) {
      sendLog(`Existing SHARP virtual environment cannot run Python; recreating: ${venvDir}`);
      venvArgs.push('--clear');
    }
    await runProcess(uv, venvArgs, { env });
    if (!canRunPythonSync(py, env)) {
      sendLog('Recreated venv still cannot run Python; clearing uv-managed Python and rebuilding once.');
      fs.rmSync(venvDir, { recursive: true, force: true });
      fs.rmSync(path.join(runtimeRoot(), 'uv-python'), { recursive: true, force: true });
      await runProcess(uv, ['venv', venvDir, '--python', '3.13', '--python-preference', 'managed'], { env });
      if (!canRunPythonSync(py, env)) {
        throw new Error('SHARP runtime Python was rebuilt, but it still cannot execute. The bundled uv runtime may be damaged.');
      }
    }
  }

  // Apple's requirements.txt contains `-e .`. Copy ml-sharp out of Program Files
  // first because setuptools writes egg-info beside pyproject.toml while building.
  const installMl = prepareWritableMlSharpSource();
  sendLog(`Prepared writable SHARP install source: ${installMl}`);
  const filteredRequirements = path.join(runtimeRoot(), 'requirements-no-editable.txt');
  const reqText = fs.readFileSync(path.join(installMl, 'requirements.txt'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('-e '))
    .join('\n');
  fs.writeFileSync(filteredRequirements, reqText);
  await runProcess(uv, ['pip', 'install', '--python', py, '-r', filteredRequirements], {
    cwd: installMl,
    env,
  });
  await runProcess(uv, ['pip', 'install', '--python', py, installMl], { cwd: installMl, env });
  await runProcess(py, ['-c', 'from sharp.cli import main_cli; print("SHARP import check OK")'], { cwd: installMl, env });

  sendLog('Runtime install complete.');
  sendJobState({ busy: false, label: 'Runtime ready' });
  return checkRuntimeStatus();
}

function isImagePath(inputPath) {
  return ['.exr', '.png', '.jpg', '.jpeg'].includes(path.extname(inputPath || '').toLowerCase());
}

function sanitizeStem(inputPath) {
  return path.basename(inputPath, path.extname(inputPath)).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function writePngFromImage(image, outputPath) {
  const png = new PNG({ width: image.width, height: image.height, colorType: 6 });
  const count = image.width * image.height;
  for (let i = 0; i < count; i++) {
    const j = i * 4;
    png.data[j] = Math.round(clamp01(image.rgba[j]) * 255);
    png.data[j + 1] = Math.round(clamp01(image.rgba[j + 1]) * 255);
    png.data[j + 2] = Math.round(clamp01(image.rgba[j + 2]) * 255);
    png.data[j + 3] = Math.round(clamp01(image.rgba[j + 3]) * 255);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, PNG.sync.write(png));
}

async function prepareInferenceInput(inputPath, opts) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext !== '.exr') return { inferencePath: inputPath, converted: false };

  sendLog('Converting EXR for SHARP inference: ACEScg/linear input → tone-mapped sRGB PNG. Original EXR is preserved.');
  const image = await loadImage(inputPath, opts || {});
  const out = path.join(runtimeRoot(), 'converted-inputs', `${sanitizeStem(inputPath)}_sharp_input.png`);
  writePngFromImage(image, out);
  return { inferencePath: out, converted: true, convertedPath: out };
}

function findNewestByExt(outputDir, extension) {
  if (!fs.existsSync(outputDir)) return null;
  const wanted = String(extension || '').toLowerCase();
  const files = fs.readdirSync(outputDir)
    .filter((name) => name.toLowerCase().endsWith(wanted))
    .map((name) => {
      const filePath = path.join(outputDir, name);
      const stat = fs.statSync(filePath);
      return { filePath, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] || null;
}

function findNewestPly(outputDir) {
  return findNewestByExt(outputDir, '.ply');
}

function findNewestGlb(outputDir) {
  return findNewestByExt(outputDir, '.glb');
}

function isPanoramaLike(width, height) {
  if (!width || !height) return false;
  return Math.abs((width / height) - 2) <= 0.06;
}

function checkPanorama360Status() {
  const root = panorama360Root();
  const repo = panorama360RepoPath();
  const script = path.join(repo, 'insp_to_splat.py');
  const marker = panorama360InstallMarkerPath();
  return {
    root,
    repo,
    script,
    repoExists: fs.existsSync(script),
    marker,
    markerExists: fs.existsSync(marker),
    ready: fs.existsSync(script) && fs.existsSync(marker),
  };
}

function bridgeScriptPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'scripts', 'infinidepth_360_bridge.py');
  return path.join(appRoot(), 'scripts', 'infinidepth_360_bridge.py');
}

function patchPanorama360ExternalDepth(repo) {
  const script = path.join(repo, 'insp_to_splat.py');
  if (!fs.existsSync(script)) throw new Error('SHARP_360 insp_to_splat.py was not found.');
  let source = fs.readFileSync(script, 'utf8').replace(/\r\n/g, '\n');
  if (source.includes('--external-depth-panorama')) return;

  source = source.replace(
    '    parser.add_argument(\n        "--da360-checkpoint",\n        type=Path,\n        default=None,\n        help="Optional DA360 checkpoint path. Defaults to checkpoints/DA360_large.pth.",\n    )',
    '    parser.add_argument(\n        "--da360-checkpoint",\n        type=Path,\n        default=None,\n        help="Optional DA360 checkpoint path. Defaults to checkpoints/DA360_large.pth.",\n    )\n    parser.add_argument(\n        "--external-depth-panorama",\n        type=Path,\n        default=None,\n        help="Optional external panorama disparity/depth .npy used instead of running DA360.",\n    )'
  );
  source = source.replace(
    '            da360_checkpoint_path = resolve_da360_checkpoint_path(args, config) if da360_alignment_enabled else None',
    '            external_depth_panorama_path = getattr(args, "external_depth_panorama", None)\n            da360_checkpoint_path = None if external_depth_panorama_path else (resolve_da360_checkpoint_path(args, config) if da360_alignment_enabled else None)'
  );
  source = source.replace(
    '                "checkpoint": describe_path_for_cache(da360_checkpoint_path),',
    '                "checkpoint": describe_path_for_cache(da360_checkpoint_path),\n                "external_depth_panorama": describe_path_for_cache(external_depth_panorama_path),'
  );
  source = source.replace(
    '                    if da360_checkpoint_path is None:\n                        raise ValueError("DA360 alignment is enabled, but no DA360 checkpoint path was resolved.")\n                    LOGGER.info(\n                        "Running DA360 panorama depth inference using checkpoint %s "\n                        "(grid=%dx%d, detail=%.0f%%)",\n                        da360_checkpoint_path, grid_res, grid_res, detail_wt * 100,\n                    )\n                    da360_predictor = build_da360_predictor(da360_checkpoint_path, device)\n                    reference_depth_panorama = predict_da360_disparity_panorama(da360_predictor, panorama, device)\n                    reference_depth_views = {\n                        view.name: extract_perspective_scalar_view(reference_depth_panorama, image_width, image_height, focal_px, focal_y_px, view)\n                        for view in extraction_layout.views\n                    }\n                    save_cached_depth_arrays(reference_depth_panorama, reference_depth_views, depth_cache_dir)\n                    del da360_predictor\n                    if device.type == "cuda":\n                        torch.cuda.empty_cache()',
    '                    if external_depth_panorama_path:\n                        LOGGER.info("Loading external panorama depth reference from %s", external_depth_panorama_path)\n                        reference_depth_panorama = np.load(external_depth_panorama_path).astype(np.float32)\n                        reference_depth_views = {\n                            view.name: extract_perspective_scalar_view(reference_depth_panorama, image_width, image_height, focal_px, focal_y_px, view)\n                            for view in extraction_layout.views\n                        }\n                        save_cached_depth_arrays(reference_depth_panorama, reference_depth_views, depth_cache_dir)\n                    else:\n                        if da360_checkpoint_path is None:\n                            raise ValueError("DA360 alignment is enabled, but no DA360 checkpoint path was resolved.")\n                        LOGGER.info(\n                            "Running DA360 panorama depth inference using checkpoint %s "\n                            "(grid=%dx%d, detail=%.0f%%)",\n                            da360_checkpoint_path, grid_res, grid_res, detail_wt * 100,\n                        )\n                        da360_predictor = build_da360_predictor(da360_checkpoint_path, device)\n                        reference_depth_panorama = predict_da360_disparity_panorama(da360_predictor, panorama, device)\n                        reference_depth_views = {\n                            view.name: extract_perspective_scalar_view(reference_depth_panorama, image_width, image_height, focal_px, focal_y_px, view)\n                            for view in extraction_layout.views\n                        }\n                        save_cached_depth_arrays(reference_depth_panorama, reference_depth_views, depth_cache_dir)\n                        del da360_predictor\n                        if device.type == "cuda":\n                            torch.cuda.empty_cache()'
  );
  fs.writeFileSync(script, source);
  sendLog('Patched SHARP 360 backend to accept external panorama depth references.');
}

async function installPanorama360() {
  ensureDirs();
  const runtime = await checkRuntimeStatus();
  if (!runtime.ready) await installRuntime();

  const root = panorama360Root();
  const repo = panorama360RepoPath();
  fs.mkdirSync(root, { recursive: true });
  sendJobState({ busy: true, label: 'Installing 360 panorama backend' });
  sendLog('Installing/checking SHARP 360 panorama backend. It stays isolated under app user-data.');

  if (!fs.existsSync(path.join(repo, '.git'))) {
    await runProcess('git', ['clone', '--depth', '1', '--recurse-submodules', 'https://github.com/Enndee/SHARP_360_to_Splat.git', repo], { cwd: root });
  } else {
    await runProcess('git', ['fetch', '--depth', '1', 'origin', 'main'], { cwd: repo });
    await runProcess('git', ['checkout', 'FETCH_HEAD'], { cwd: repo });
    await runProcess('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: repo });
    await runProcess('git', ['submodule', 'update', '--init', '--recursive'], { cwd: repo });
  }
  patchPanorama360ExternalDepth(repo);

  const py = venvPythonPath();
  const uv = uvPath();
  const env = runtimePythonEnv();
  sendLog('Installing 360 backend Python extras into the existing SHARP runtime.');
  await runProcess(uv, ['pip', 'install', '--python', py, 'pillow', 'numpy', 'scipy', 'opencv-python', 'pillow-heif'], { cwd: repo, env });
  await runProcess(venvPythonPath(), ['-c', 'import PIL, numpy, scipy; import insp_to_splat; print("SHARP 360 import check OK")'], { cwd: repo, env });

  fs.writeFileSync(marker, JSON.stringify({
    installedAt: new Date().toISOString(),
    repo,
    python: py,
  }, null, 2));
  sendLog('SHARP 360 panorama backend ready.');
  sendJobState({ busy: false, label: '360 backend ready' });
  return checkPanorama360Status();
}

function checkInfiniDepthStatus() {
  const root = infinidepthRoot();
  const repo = infinidepthRepoPath();
  const py = infinidepthPythonPath();
  const depthModel = path.join(repo, 'checkpoints', 'depth', 'infinidepth.ckpt');
  const mogeModel = path.join(repo, 'checkpoints', 'moge-2-vitl-normal', 'model.pt');
  const marker = infinidepthInstallMarkerPath();
  return {
    root,
    repo,
    repoExists: fs.existsSync(path.join(repo, 'inference_depth.py')),
    python: py,
    pythonExists: fs.existsSync(py),
    depthModel,
    depthModelExists: fs.existsSync(depthModel),
    mogeModel,
    mogeModelExists: fs.existsSync(mogeModel),
    marker,
    markerExists: fs.existsSync(marker),
    ready: fs.existsSync(path.join(repo, 'inference_depth.py')) && fs.existsSync(py) && fs.existsSync(depthModel) && fs.existsSync(mogeModel) && fs.existsSync(marker),
  };
}

async function installInfiniDepth() {
  const root = infinidepthRoot();
  const repo = infinidepthRepoPath();
  fs.mkdirSync(root, { recursive: true });
  sendJobState({ busy: true, label: 'Installing InfiniDepth backend' });
  sendLog('Installing/checking InfiniDepth experimental depth backend. This is separate from SHARP and can be large.');
  if (!fs.existsSync(path.join(repo, '.git'))) {
    await runProcess('git', ['clone', '--depth', '1', 'https://github.com/zju3dv/InfiniDepth.git', repo], { cwd: root });
  } else {
    await runProcess('git', ['fetch', '--depth', '1', 'origin', 'main'], { cwd: repo });
    await runProcess('git', ['checkout', 'FETCH_HEAD'], { cwd: repo });
    await runProcess('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: repo });
  }

  const uv = uvPath();
  const py = infinidepthPythonPath();
  const env = {
    UV_CACHE_DIR: path.join(root, 'uv-cache'),
    UV_LINK_MODE: 'copy',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
  };
  if (!fs.existsSync(py)) {
    await runProcess(uv, ['venv', infinidepthVenvPath(), '--python', '3.10', '--python-preference', 'managed'], { env });
  }
  sendLog('Installing InfiniDepth Python dependencies. PyTorch/CUDA packages are large.');
  await runProcess(uv, ['pip', 'install', '--python', py, '--extra-index-url', 'https://download.pytorch.org/whl/cu128', 'torch', 'torchvision', 'torchaudio'], { cwd: repo, env });
  await runProcess(uv, ['pip', 'install', '--python', py, '-r', path.join(repo, 'requirements.txt')], { cwd: repo, env });
  const status = checkInfiniDepthStatus();
  if (!status.depthModelExists || !status.mogeModelExists) {
    sendLog('InfiniDepth code is installed, but checkpoints are still needed: checkpoints/depth/infinidepth.ckpt and checkpoints/moge-2-vitl-normal/model.pt.');
    sendLog('Download links are documented in InfiniDepth INSTALL.md.');
  }
  fs.writeFileSync(infinidepthInstallMarkerPath(), JSON.stringify({
    installedAt: new Date().toISOString(),
    repo,
    python: py,
  }, null, 2));
  sendJobState({ busy: false, label: 'InfiniDepth backend ready' });
  return checkInfiniDepthStatus();
}

async function buildInfiniDepthPanoramaReference(inputPath) {
  const status = checkInfiniDepthStatus();
  if (!status.ready) await installInfiniDepth();
  const ready = checkInfiniDepthStatus();
  if (!ready.depthModelExists || !ready.mogeModelExists) {
    throw new Error('InfiniDepth checkpoints are missing. Place infinidepth.ckpt under checkpoints/depth/ and MoGe model.pt under checkpoints/moge-2-vitl-normal/ in the InfiniDepth backend folder.');
  }
  if (!fs.existsSync(bridgeScriptPath())) {
    throw new Error('InfiniDepth 360 bridge script was not packaged with the app.');
  }
  const output = path.join(runtimeRoot(), 'converted-inputs', sanitizeStem(inputPath) + '_infinidepth_panorama.npy');
  await runProcess(infinidepthPythonPath(), [
    bridgeScriptPath(),
    '--repo', infinidepthRepoPath(),
    '--input', inputPath,
    '--output', output,
    '--depth-model', ready.depthModel,
    '--moge-model', ready.mogeModel,
  ], { cwd: infinidepthRepoPath() });
  return output;
}

async function runPanorama360(request = {}) {
  if (!request.inputPath || !fs.existsSync(request.inputPath)) throw new Error('Input panorama file does not exist.');
  if (!request.outputFolder) throw new Error('Choose an output folder first.');
  const ext = path.extname(request.inputPath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
    throw new Error('360 panorama mode currently supports stitched PNG/JPEG inputs. Convert HEIC/WEBP/EXR to PNG first.');
  }

  const status = checkPanorama360Status();
  if (!status.ready) await installPanorama360();

  fs.mkdirSync(request.outputFolder, { recursive: true });
  const outputPly = path.join(request.outputFolder, sanitizeStem(request.inputPath) + '_360_merged.ply');
  const sideCount = Math.max(2, Math.min(12, Number.parseInt(request.panoramaSideCount || 4, 10) || 4));
  const requestedAlignment = request.panoramaAlignmentMode === 'infinidepth' ? 'infinidepth' : (request.panoramaAlignmentMode === 'da360' ? 'da360' : 'overlap');
  const externalDepthPanorama = requestedAlignment === 'infinidepth' ? await buildInfiniDepthPanoramaReference(request.inputPath) : null;
  const alignmentMode = requestedAlignment === 'infinidepth' ? 'da360' : requestedAlignment;
  const args = [
    '-u',
    path.join(panorama360RepoPath(), 'insp_to_splat.py'),
    '-i',
    request.inputPath,
    '-o',
    outputPly,
    '--side-count',
    String(sideCount),
    '--format',
    'ply',
    '--device',
    request.device || 'default',
    '--alignment-mode',
    alignmentMode,
    '--config',
    path.join(panorama360RepoPath(), alignmentMode === 'overlap' ? 'insp_settings_starter.json' : 'insp_settings.json'),
    '--verbose',
  ];
  if (request.panoramaKeepIntermediates) args.push('--keep-intermediates');
  else args.push('--delete-temp-files');
  if (externalDepthPanorama) args.push('--external-depth-panorama', externalDepthPanorama);

  sendJobState({ busy: true, label: 'Running 360 panorama SHARP' });
  sendLog('Running 360 panorama pipeline: ' + sideCount + ' views, ' + requestedAlignment + ' alignment, ' + (request.device || 'default') + ' device.');
  if ((request.device || 'default') === 'cpu') sendLog('CPU mode is supported as a fallback but will be slow.');
  await runProcess(venvPythonPath(), args, { cwd: panorama360RepoPath(), env: runtimePythonEnv() });

  const newest = fs.existsSync(outputPly) ? { filePath: outputPly, size: fs.statSync(outputPly).size } : findNewestPly(request.outputFolder);
  if (!newest) throw new Error('360 panorama pipeline finished but no .ply was found in the output folder.');
  sendLog('360 PLY written: ' + newest.filePath);
  sendJobState({ busy: false, label: '360 panorama complete' });
  return { ok: true, outputPly: newest.filePath, outputFolder: request.outputFolder, sizeBytes: newest.size, provider: 'sharp-360' };
}

function _oldFindNewestPly(outputDir) {
  if (!fs.existsSync(outputDir)) return null;
  const files = fs.readdirSync(outputDir)
    .filter((name) => name.toLowerCase().endsWith('.ply'))
    .map((name) => {
      const filePath = path.join(outputDir, name);
      const stat = fs.statSync(filePath);
      return { filePath, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] || null;
}

function checkPixal3DStatus() {
  const root = pixal3dRoot();
  const repo = pixal3dRepoPath();
  const py = pixal3dPythonPath();
  const marker = pixal3dInstallMarkerPath();
  const repoExists = fs.existsSync(path.join(repo, 'inference.py'));
  const pythonExists = fs.existsSync(py);
  const markerData = readPixal3DInstallMarker();
  const currentRevision = repoExists ? pixal3dCurrentRevision(repo) : '';
  const sourceRevisionMatches = currentRevision === PIXAL3D_UPSTREAM_SHA;
  const patchValid = !repoExists || process.platform !== 'win32' || hasPixal3DWindowsPatch(repo);
  const markerMatches = !!markerData
    && markerData.upstreamSha === PIXAL3D_UPSTREAM_SHA
    && markerData.integrationRevision === PIXAL3D_INTEGRATION_REVISION;
  return {
    root,
    repo,
    repoExists,
    python: py,
    pythonExists,
    installMarker: marker,
    installMarkerExists: fs.existsSync(marker),
    upstreamSha: PIXAL3D_UPSTREAM_SHA,
    currentRevision,
    sourceRevisionMatches,
    patchValid,
    markerMatches,
    updateRequired: repoExists && (!sourceRevisionMatches || !markerMatches || !patchValid),
    ready: repoExists && pythonExists && sourceRevisionMatches && markerMatches && patchValid,
    license: PIXAL3D_LICENSE_SUMMARY,
  };
}

async function installPixal3D(request = {}) {
  if (process.platform === 'win32') {
    sendLog('Warning: Pixal3D upstream is Linux-first. Windows install uses community CUDA wheels, native SDPA, and a Windows NAF fallback.');
  }
  const root = pixal3dRoot();
  const repo = pixal3dRepoPath();
  fs.mkdirSync(root, { recursive: true });
  sendJobState({ busy: true, label: 'Installing Pixal3D experimental backend' });
  sendLog('Pixal3D experimental backend is isolated from the bundled SHARP runtime.');
  sendLog(`Pixal3D source pin: ${PIXAL3D_UPSTREAM_SHA}`);
  sendLog(PIXAL3D_LICENSE_SUMMARY);

  if (!fs.existsSync(path.join(repo, '.git'))) {
    if (fs.existsSync(repo) && fs.readdirSync(repo).length > 0) {
      throw new Error(`Pixal3D runtime folder is incomplete and cannot be updated safely: ${repo}`);
    }
    await runProcess('git', ['clone', '--filter=blob:none', '--no-checkout', '--depth', '1', PIXAL3D_REPO_URL, repo], { cwd: root });
  }
  await runProcess('git', ['fetch', '--depth', '1', 'origin', PIXAL3D_UPSTREAM_SHA], { cwd: repo });
  await runProcess('git', ['checkout', '--detach', '--force', PIXAL3D_UPSTREAM_SHA], { cwd: repo });
  await runProcess('git', ['reset', '--hard', PIXAL3D_UPSTREAM_SHA], { cwd: repo });
  const checkedOutRevision = pixal3dCurrentRevision(repo);
  if (checkedOutRevision !== PIXAL3D_UPSTREAM_SHA) {
    throw new Error(`Pixal3D checkout mismatch: expected ${PIXAL3D_UPSTREAM_SHA}, got ${checkedOutRevision || 'unknown'}.`);
  }

  patchPixal3DWindowsSource(repo);

  const uv = uvPath();
  const env = {
    UV_CACHE_DIR: path.join(root, 'uv-cache'),
    UV_LINK_MODE: 'copy',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
  };
  const pythonVersion = process.platform === 'win32' ? '3.11' : '3.10';
  const py = pixal3dPythonPath();
  const pyvenvCfg = path.join(pixal3dVenvPath(), 'pyvenv.cfg');
  const existingVenvText = fs.existsSync(pyvenvCfg) ? fs.readFileSync(pyvenvCfg, 'utf8') : '';
  const wrongWindowsPython = process.platform === 'win32' && existingVenvText && !existingVenvText.includes('version_info = 3.11');
  if (process.platform === 'win32' && fs.existsSync(pixal3dVenvPath()) && (!fs.existsSync(py) || wrongWindowsPython)) {
    sendLog('Removing incompatible/incomplete previous Pixal3D Windows venv before recreating it.');
    fs.rmSync(pixal3dVenvPath(), { recursive: true, force: true });
  }
  if (fs.existsSync(py)) {
    sendLog(`Reusing existing Pixal3D Python runtime: ${py}`);
  } else {
    await runProcess(uv, ['venv', pixal3dVenvPath(), '--python', pythonVersion, '--python-preference', 'managed'], { env });
  }
  const requirements = fs.existsSync(path.join(repo, 'requirements-hfdemo.txt')) && process.platform !== 'win32'
    ? 'requirements-hfdemo.txt'
    : 'requirements.txt';
  const sourceRequirementsPath = path.join(repo, requirements);
  const filteredRequirementsPath = path.join(root, `requirements-${process.platform}-no-natten.txt`);
  const filteredRequirements = fs.readFileSync(sourceRequirementsPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim().toLowerCase();
      if (!trimmed || trimmed.startsWith('#')) return true;
      if (trimmed.startsWith('natten')) return false;
      if (trimmed.startsWith('torch==') || trimmed.startsWith('torchvision==')) return false;
      if (trimmed.startsWith('triton==') && process.platform === 'win32') return false;
      return true;
    })
    .join('\n');
  fs.writeFileSync(filteredRequirementsPath, filteredRequirements);

  sendLog('Pre-installing CUDA PyTorch for Pixal3D. This is large.');
  if (process.platform === 'win32') {
    await runProcess(uv, ['pip', 'install', '--python', py, '--index-url', 'https://download.pytorch.org/whl/cu128', 'torch==2.7.0', 'torchvision==0.22.0'], { cwd: repo, env });
    sendLog('Installing Python build helpers required by MoGe transitive Git dependencies.');
    await runProcess(uv, ['pip', 'install', '--python', py, 'setuptools>=70', 'wheel', 'packaging'], { cwd: repo, env });
    sendLog('Installing Pixal3D inference dependencies missing from upstream requirements.txt.');
    await runProcess(uv, ['pip', 'install', '--python', py, ...PIXAL3D_WINDOWS_INFERENCE_DEPS], { cwd: repo, env });
    sendLog('Skipping NATTEN on Windows: official 0.21.0 wheels are Linux-only. Patched Pixal3D/NAF to use SDPA plus interpolation fallback instead.');
    sendLog('Installing pinned community Windows CUDA wheels for Pixal3D mesh/texturing extensions (cumesh, flex_gemm, nvdiffrast, nvdiffrec_render, o_voxel).');
    await runProcess(uv, ['pip', 'install', '--python', py, ...pixal3dWindowsWheelRequirements()], { cwd: repo, env });
  } else {
    await runProcess(uv, ['pip', 'install', '--python', py, '--extra-index-url', 'https://download.pytorch.org/whl/cu126', 'torch==2.7.0', 'torchvision==0.22.0'], { cwd: repo, env });
    await runProcess(uv, ['pip', 'install', '--python', py, 'natten==0.21.0+torch270cu126', '-f', 'https://whl.natten.org'], { cwd: repo, env });
  }

  sendLog(`Installing remaining Pixal3D dependencies from filtered ${requirements}. This can still be large and CUDA-specific.`);
  await runProcess(uv, ['pip', 'install', '--python', py, '--no-build-isolation', '-r', filteredRequirementsPath], { cwd: repo, env });
  await runProcess(uv, ['pip', 'install', '--python', py, 'https://github.com/LDYang694/Storages/releases/download/20260430/utils3d-0.0.2-py3-none-any.whl'], { cwd: repo, env });
  if (process.platform === 'win32') {
    sendLog('Verifying Pixal3D import surface before marking install ready.');
    await runProcess(py, ['-c', 'import transformers, timm, kornia, imageio, einops, cumesh, flex_gemm, o_voxel; import nvdiffrast.torch; from pixal3d.pipelines import Pixal3DImageTo3DPipeline; print("Pixal3D import check OK")'], {
      cwd: repo,
      env: pixal3dExecutionEnv(env),
    });
  }
  fs.writeFileSync(pixal3dInstallMarkerPath(), JSON.stringify({
    platform: process.platform,
    pythonVersion,
    attentionBackend: process.platform === 'win32' ? 'sdpa' : 'flash_attn',
    upstreamSha: PIXAL3D_UPSTREAM_SHA,
    integrationRevision: PIXAL3D_INTEGRATION_REVISION,
    installedAt: new Date().toISOString(),
  }, null, 2));
  sendLog('Pixal3D experimental install complete.');
  sendJobState({ busy: false, label: 'Pixal3D ready' });
  return checkPixal3DStatus();
}

async function runPixal3D(request = {}) {
  if (!request.inputPath || !fs.existsSync(request.inputPath)) throw new Error('Input file does not exist.');
  if (!request.outputFolder) throw new Error('Choose an output folder first.');
  const status = checkPixal3DStatus();
  if (!status.ready) await installPixal3D(request);
  fs.mkdirSync(request.outputFolder, { recursive: true });
  sendJobState({ busy: true, label: 'Running Pixal3D experimental GLB' });
  sendLog('Running Pixal3D as an external experimental provider: image → GLB mesh/material output.');
  sendLog('First Pixal3D run can sit quietly while Hugging Face downloads model weights; watch disk/network activity if the log pauses during model loading.');
  const hw = hardwareStatus();
  const profile = resolvePixal3DProfile(request, hw.inference.gpu && hw.inference.gpu.memoryTotalMb);
  const pixalEnv = { PIXAL3D_PROFILE: profile.name };
  if (hw.inference.gpu) sendLog(`Inference GPU: ${hw.inference.gpu.name}${hw.inference.gpu.memoryTotalMb ? ` (${hw.inference.gpu.memoryTotalMb} MB VRAM)` : ''}`);
  else sendLog('Inference GPU: no CUDA GPU detected; model inference will use CPU/fallback paths where supported.');
  if (process.platform === 'win32') {
    sendLog(`Pixal3D profile: ${profile.name} (native low_vram=${profile.lowVram ? 'on' : 'off'})`);
    const resolvedPixalEnv = pixal3dExecutionEnv(pixalEnv);
    sendLog(`Using Pixal3D background-removal model: ${resolvedPixalEnv.PIXAL3D_REMBG_MODEL}${resolvedPixalEnv.PIXAL3D_REMBG_REVISION ? ` @ ${resolvedPixalEnv.PIXAL3D_REMBG_REVISION}` : ''}`);
    if (profile.name === 'full') sendLog('Pixal3D Standard mode keeps models resident on CUDA; upstream estimates about 18GB peak VRAM.');
    if (profile.name === 'aggressive') sendLog('Pixal3D 8GB Experimental mode combines native low-VRAM staging with allocator/TF32 tuning and the projected-feature guard. Upstream still documents 10–12GB peak, so OOM remains possible.');
    if (profile.name === 'compat') sendLog('Pixal3D Low VRAM mode uses upstream staging and Windows-safe fallbacks; upstream documents about 10–12GB peak VRAM.');
  }
  const outputGlb = path.join(request.outputFolder, `${sanitizeStem(request.inputPath)}_pixal3d.glb`);
  const args = buildPixal3DInferenceArgs(request, outputGlb, profile);
  const effectiveResolution = request.pixalResolution && request.pixalResolution !== 'auto'
    ? Number(request.pixalResolution)
    : (profile.lowVram ? 1024 : 1536);
  sendLog(`Pixal3D resolution: ${effectiveResolution}; FOV: ${request.pixalFovDegrees || 'automatic MoGe-2 estimate'}.`);
  await runProcess(pixal3dPythonPath(), args, { cwd: pixal3dRepoPath(), env: pixal3dExecutionEnv(pixalEnv) });
  const newest = fs.existsSync(outputGlb) ? { filePath: outputGlb, size: fs.statSync(outputGlb).size } : findNewestGlb(request.outputFolder);
  if (!newest) throw new Error('Pixal3D finished but no .glb was found in the output folder.');
  sendLog(`GLB written: ${newest.filePath}`);
  sendJobState({ busy: false, label: 'Pixal3D complete' });
  return { outputGlb: newest.filePath, sizeBytes: newest.size, provider: 'pixal3d-experimental' };
}

function sigmoid(v) {
  if (!Number.isFinite(v)) return 0.5;
  return 1 / (1 + Math.exp(-v));
}

function clampByte(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

function propertyByteSize(type) {
  return ({
    char: 1, uchar: 1, int8: 1, uint8: 1,
    short: 2, ushort: 2, int16: 2, uint16: 2,
    int: 4, uint: 4, int32: 4, uint32: 4,
    float: 4, float32: 4, double: 8, float64: 8,
  })[type] || 4;
}

function readProperty(buffer, offset, type, littleEndian) {
  switch (type) {
    case 'char': case 'int8': return buffer.readInt8(offset);
    case 'uchar': case 'uint8': return buffer.readUInt8(offset);
    case 'short': case 'int16': return littleEndian ? buffer.readInt16LE(offset) : buffer.readInt16BE(offset);
    case 'ushort': case 'uint16': return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    case 'int': case 'int32': return littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset);
    case 'uint': case 'uint32': return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    case 'double': case 'float64': return littleEndian ? buffer.readDoubleLE(offset) : buffer.readDoubleBE(offset);
    case 'float': case 'float32': default: return littleEndian ? buffer.readFloatLE(offset) : buffer.readFloatBE(offset);
  }
}

function parsePlyHeader(buffer) {
  const marker = Buffer.from('end_header');
  const markerAt = buffer.indexOf(marker);
  if (markerAt < 0) throw new Error('Invalid PLY: missing end_header.');
  let dataOffset = markerAt + marker.length;
  if (buffer[dataOffset] === 13 && buffer[dataOffset + 1] === 10) dataOffset += 2;
  else if (buffer[dataOffset] === 10) dataOffset += 1;
  const headerText = buffer.slice(0, markerAt + marker.length).toString('utf8');
  const lines = headerText.split(/\r?\n/);
  let format = 'ascii';
  let vertexCount = 0;
  const props = [];
  let inVertex = false;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'format') format = parts[1];
    else if (parts[0] === 'element') {
      inVertex = parts[1] === 'vertex';
      if (inVertex) vertexCount = Number(parts[2] || 0);
    } else if (inVertex && parts[0] === 'property' && parts[1] !== 'list') {
      props.push({ type: parts[1], name: parts[2], size: propertyByteSize(parts[1]) });
    }
  }
  if (!vertexCount || !props.length) throw new Error('Invalid PLY: no vertex properties found.');
  return { format, vertexCount, props, dataOffset };
}

function colorFromProperties(values) {
  if ('red' in values && 'green' in values && 'blue' in values) {
    return [clampByte(values.red), clampByte(values.green), clampByte(values.blue)];
  }
  if ('r' in values && 'g' in values && 'b' in values) {
    return [clampByte(values.r), clampByte(values.g), clampByte(values.b)];
  }
  if ('f_dc_0' in values && 'f_dc_1' in values && 'f_dc_2' in values) {
    const shC0 = 0.28209479177387814;
    return [
      clampByte((0.5 + shC0 * values.f_dc_0) * 255),
      clampByte((0.5 + shC0 * values.f_dc_1) * 255),
      clampByte((0.5 + shC0 * values.f_dc_2) * 255),
    ];
  }
  const a = 'opacity' in values ? sigmoid(values.opacity) : 1;
  const shade = clampByte(150 + 105 * a);
  return [shade, shade, shade];
}

function loadPlyPreview(filePath, maxPoints = 140000) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('PLY file does not exist.');
  const buffer = fs.readFileSync(filePath);
  const header = parsePlyHeader(buffer);
  const stride = header.props.reduce((sum, prop) => sum + prop.size, 0);
  const sampleStep = Math.max(1, Math.ceil(header.vertexCount / maxPoints));
  const count = Math.ceil(header.vertexCount / sampleStep);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  let written = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  if (header.format === 'ascii') {
    const text = buffer.slice(header.dataOffset).toString('utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < header.vertexCount && i < lines.length; i += sampleStep) {
      const fields = lines[i].trim().split(/\s+/).map(Number);
      if (fields.length < header.props.length) continue;
      const values = {};
      header.props.forEach((prop, idx) => { values[prop.name] = fields[idx]; });
      const x = Number(values.x), y = Number(values.y), z = Number(values.z);
      if (![x, y, z].every(Number.isFinite)) continue;
      const p = written * 3;
      positions[p] = x; positions[p + 1] = y; positions[p + 2] = z;
      colors.set(colorFromProperties(values), p);
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
      written++;
    }
  } else if (header.format === 'binary_little_endian' || header.format === 'binary_big_endian') {
    const littleEndian = header.format === 'binary_little_endian';
    for (let i = 0; i < header.vertexCount; i += sampleStep) {
      let offset = header.dataOffset + i * stride;
      if (offset + stride > buffer.length) break;
      const values = {};
      for (const prop of header.props) {
        values[prop.name] = readProperty(buffer, offset, prop.type, littleEndian);
        offset += prop.size;
      }
      const x = Number(values.x), y = Number(values.y), z = Number(values.z);
      if (![x, y, z].every(Number.isFinite)) continue;
      const p = written * 3;
      positions[p] = x; positions[p + 1] = y; positions[p + 2] = z;
      colors.set(colorFromProperties(values), p);
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
      written++;
    }
  } else {
    throw new Error(`Unsupported PLY format '${header.format}'.`);
  }

  if (!written) throw new Error('PLY contained no readable vertices.');
  return {
    fileUrl: pathToFileURL(filePath).href,
    vertexCount: header.vertexCount,
    shownCount: written,
    positions: Array.from(positions.slice(0, written * 3)),
    colors: Array.from(colors.slice(0, written * 3)),
    bounds: { minX, minY, minZ, maxX, maxY, maxZ },
  };
}

function defaultSuperSplatSettings() {
  return {
    version: 2,
    tonemapping: 'none',
    highPrecisionRendering: false,
    background: { color: [0.03, 0.035, 0.045] },
    postEffectSettings: {
      sharpness: { enabled: false, amount: 0 },
      bloom: { enabled: false, intensity: 1, blurLevel: 2 },
      grading: { enabled: false, brightness: 0, contrast: 1, saturation: 1, tint: [1, 1, 1] },
      vignette: { enabled: false, intensity: 0.5, inner: 0.3, outer: 0.75, curvature: 1 },
      fringing: { enabled: false, intensity: 0.5 },
    },
    animTracks: [],
    cameras: [
      {
        initial: {
          position: [0, 1, -1],
          target: [0, 0, 0],
          fov: 60,
        },
      },
    ],
    annotations: [],
    startMode: 'default',
  };
}

async function ensureSuperSplatViewerFiles() {
  if (superSplatViewerReady) return superSplatViewerReady;
  superSplatViewerReady = (async () => {
    const viewerDir = path.join(app.getPath('userData'), 'supersplat-viewer');
    fs.mkdirSync(viewerDir, { recursive: true });
    const viewer = await import('@playcanvas/supersplat-viewer');
    fs.writeFileSync(path.join(viewerDir, 'index.html'), viewer.html);
    fs.writeFileSync(path.join(viewerDir, 'index.css'), viewer.css);
    fs.writeFileSync(path.join(viewerDir, 'index.js'), viewer.js);
    fs.writeFileSync(path.join(viewerDir, 'settings.json'), JSON.stringify(defaultSuperSplatSettings()));
    return viewerDir;
  })();
  return superSplatViewerReady;
}

function sendStaticFile(response, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': contentType || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(response);
}

async function ensureSuperSplatServer() {
  if (superSplatServerReady) return superSplatServerReady;
  superSplatServerReady = (async () => {
    const viewerDir = await ensureSuperSplatViewerFiles();
    const server = http.createServer((request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/viewer/index.html') return sendStaticFile(response, path.join(viewerDir, 'index.html'), 'text/html; charset=utf-8');
        if (url.pathname === '/viewer/index.css') return sendStaticFile(response, path.join(viewerDir, 'index.css'), 'text/css; charset=utf-8');
        if (url.pathname === '/viewer/index.js') return sendStaticFile(response, path.join(viewerDir, 'index.js'), 'text/javascript; charset=utf-8');
        if (url.pathname === '/settings.json') return sendStaticFile(response, path.join(viewerDir, 'settings.json'), 'application/json; charset=utf-8');
        if (url.pathname.startsWith('/content/')) {
          const filePath = url.searchParams.get('path');
          if (!filePath || !fs.existsSync(filePath)) {
            response.writeHead(404);
            response.end('PLY file not found');
            return;
          }
          return sendStaticFile(response, filePath, 'model/ply');
        }
        response.writeHead(404);
        response.end('Not found');
      } catch (err) {
        response.writeHead(500);
        response.end(String(err && err.message ? err.message : err));
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    app.once('before-quit', () => server.close());
    return { port: server.address().port };
  })();
  return superSplatServerReady;
}


ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    return { ok: false, status: 'dev', message: 'Updates are only available in the installed Windows build.' };
  }
  const result = await autoUpdater.checkForUpdates();
  const latestVersion = result && result.updateInfo && result.updateInfo.version;
  if (!latestVersion || compareVersions(latestVersion, app.getVersion()) <= 0) {
    const state = { ok: true, status: 'none', message: `You're up to date (${app.getVersion()}).`, info: result && result.updateInfo };
    sendUpdateState(state);
    return state;
  }
  return { ok: true, status: 'checking', message: 'Checking for updates…', result: !!result };
});

ipcMain.handle('download-update', async () => {
  if (!app.isPackaged) {
    return { ok: false, status: 'dev', message: 'Updates are only available in the installed Windows build.' };
  }
  await autoUpdater.downloadUpdate();
  return { ok: true, status: 'downloading' };
});

ipcMain.handle('restart-and-install-update', async () => {
  if (!updateDownloaded) return { ok: false, message: 'No downloaded update is ready yet.' };
  autoUpdater.quitAndInstall(true, true);
  return { ok: true };
});

ipcMain.handle('get-app-version', async () => app.getVersion());
ipcMain.handle('get-gpu-feature-status', async () => app.getGPUFeatureStatus());
ipcMain.handle('get-hardware-status', async () => hardwareStatus());

ipcMain.handle('select-input', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose one frame for SHARP',
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['exr', 'png', 'jpg', 'jpeg'] },
      { name: 'OpenEXR', extensions: ['exr'] },
      { name: 'PNG/JPEG', extensions: ['png', 'jpg', 'jpeg'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const inputPath = result.filePaths[0];
  if (!isImagePath(inputPath)) throw new Error('Use EXR, PNG, JPG, or JPEG.');
  return { inputPath, defaultColorSpace: defaultColorSpaceFor(inputPath) };
});

ipcMain.handle('select-output-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose SHARP output folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('inspect-input', async (_event, inputPath, opts) => {
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error('Input file does not exist.');
  const image = await loadImage(inputPath, opts || {});
  const ext = path.extname(inputPath).toLowerCase();
  const previewDataUrl = makePreviewPngDataUrl(image, 1400);
  return {
    width: image.width,
    height: image.height,
    isPanorama: isPanoramaLike(image.width, image.height) && ['.png', '.jpg', '.jpeg'].includes(ext),
    source: image.source,
    sourceColorSpace: image.sourceColorSpace,
    previewDataUrl,
  };
});

ipcMain.handle('check-runtime', checkRuntimeStatus);
ipcMain.handle('check-panorama360', async () => checkPanorama360Status());
ipcMain.handle('check-infinidepth', async () => checkInfiniDepthStatus());
ipcMain.handle('install-infinidepth', async () => {
  try {
    return await installInfiniDepth();
  } catch (err) {
    sendJobState({ busy: false, label: 'InfiniDepth install failed' });
    throw err;
  }
});
ipcMain.handle('install-panorama360', async () => {
  try {
    return await installPanorama360();
  } catch (err) {
    sendJobState({ busy: false, label: '360 backend install failed' });
    throw err;
  }
});
ipcMain.handle('run-panorama360', async (_event, request) => {
  try {
    return await runPanorama360(request || {});
  } catch (err) {
    sendJobState({ busy: false, label: '360 panorama failed' });
    throw err;
  }
});
ipcMain.handle('check-pixal3d', async () => checkPixal3DStatus());
ipcMain.handle('install-pixal3d', async (_event, request) => {
  try {
    return await installPixal3D(request || {});
  } catch (err) {
    sendJobState({ busy: false, label: 'Pixal3D install failed' });
    throw err;
  }
});
ipcMain.handle('run-pixal3d', async (_event, request) => {
  try {
    return await runPixal3D(request || {});
  } catch (err) {
    sendJobState({ busy: false, label: 'Pixal3D failed' });
    throw err;
  }
});

ipcMain.handle('install-runtime', async () => {
  try {
    return await installRuntime();
  } catch (err) {
    sendJobState({ busy: false, label: 'Install failed' });
    throw err;
  }
});

ipcMain.handle('run-sharp', async (_event, request) => {
  if (!request || !request.inputPath || !fs.existsSync(request.inputPath)) throw new Error('Input file does not exist.');
  if (!request.outputFolder) throw new Error('Choose an output folder first.');
  ensureDirs();
  fs.mkdirSync(request.outputFolder, { recursive: true });

  sendJobState({ busy: true, label: 'Running SHARP' });
  try {
    const status = await checkRuntimeStatus();
    if (!status.ready) await installRuntime();

    const prepared = await prepareInferenceInput(request.inputPath, request);
    const sharp = sharpCommand();
    const args = [...sharp.argsPrefix, 'predict', '-i', prepared.inferencePath, '-o', request.outputFolder, '--device', request.device || 'default'];
    if (request.verbose) args.push('-v');
    await runProcess(sharp.command, args, { cwd: mlSharpSourcePath(), env: runtimePythonEnv() });
    const newest = findNewestPly(request.outputFolder);
    if (!newest) throw new Error('SHARP finished but no .ply was found in the output folder.');
    sendLog(`PLY written: ${newest.filePath}`);
    sendJobState({ busy: false, label: 'Done' });
    return { ok: true, outputPly: newest.filePath, outputFolder: request.outputFolder, converted: prepared.converted, convertedPath: prepared.convertedPath || null, sizeBytes: newest.size };
  } catch (err) {
    sendJobState({ busy: false, label: 'Failed' });
    throw err;
  }
});

ipcMain.handle('cancel-job', async () => {
  if (activeProcess) {
    activeProcess.kill();
    activeProcess = null;
    sendLog('Cancelled active process.');
    sendJobState({ busy: false, label: 'Cancelled' });
    return true;
  }
  return false;
});

ipcMain.handle('show-in-folder', async (_event, filePath) => {
  if (!filePath) return false;
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('open-path', async (_event, filePath) => {
  if (!filePath) return false;
  await shell.openPath(filePath);
  return true;
});

ipcMain.handle('load-ply-preview', async (_event, filePath) => loadPlyPreview(filePath));
ipcMain.handle('prepare-supersplat-preview', async (_event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('PLY file does not exist.');
  const { port } = await ensureSuperSplatServer();
  const viewerUrl = new URL(`http://127.0.0.1:${port}/viewer/index.html`);
  const contentPath = `/content/${encodeURIComponent(path.basename(filePath))}?path=${encodeURIComponent(filePath)}`;
  viewerUrl.searchParams.set('content', contentPath);
  viewerUrl.searchParams.set('settings', '/settings.json');
  viewerUrl.searchParams.set('aa', '1');
  viewerUrl.searchParams.set('budget', '3');
  viewerUrl.searchParams.set('noui', '1');
  viewerUrl.searchParams.set('webgpu', '1');
  return { viewerUrl: viewerUrl.href };
});
ipcMain.handle('load-ply-preview-as-data-url', async (_event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('PLY file does not exist.');
  const buffer = fs.readFileSync(filePath);
  return `data:model/ply;base64,${buffer.toString('base64')}`;
});

ipcMain.handle('load-ply-bytes', async (_event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('PLY file does not exist.');
  return {
    name: path.basename(filePath),
    base64: fs.readFileSync(filePath).toString('base64'),
  };
});

ipcMain.handle('load-glb-preview', async (_event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('GLB file does not exist.');
  const data = fs.readFileSync(filePath);
  return `data:model/gltf-binary;base64,${data.toString('base64')}`;
});

ipcMain.handle('open-external', async (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

ipcMain.handle('copy-text', async (_event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('get-last-output-folder', async () => {
  try {
    const data = fs.readFileSync(path.join(app.getPath('userData'), 'last-output-folder.json'), 'utf8');
    const parsed = JSON.parse(data);
    return parsed.path || '';
  } catch {
    return '';
  }
});

ipcMain.handle('set-last-output-folder', async (_event, folderPath) => {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), 'last-output-folder.json'), JSON.stringify({ path: folderPath }));
    return true;
  } catch {
    return false;
  }
});
