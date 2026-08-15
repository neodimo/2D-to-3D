'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const pkg = JSON.parse(read('package.json'));
const html = read('src/renderer/index.html');
const css = read('src/renderer/styles.css');
const renderer = read('src/renderer/renderer.js');
const preload = read('src/preload.cjs');
const main = read('src/main.cjs');
const pixalIntegration = read('src/lib/pixal3d.cjs');
const pixalDocs = read('EXPERIMENTAL_PIXAL3D.md');
const sam3dIntegration = read('src/lib/sam3d.cjs');
const sam3dBridge = read('scripts/sam3d_objects_server.py');
const sam3dDocs = read('SAM3D_OBJECTS.md');
const notice = read('NOTICE');
const workflow = read('.github/workflows/windows-release.yml');

const failures = [];

function check(name, condition, detail = '') {
  if (!condition) failures.push(detail ? `${name}: ${detail}` : name);
}

function includesAll(label, text, needles) {
  for (const needle of needles) {
    check(label, text.includes(needle), `missing ${JSON.stringify(needle)}`);
  }
}

check('package version is semver', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version);

includesAll('header version badge contract', html, [
  'id="appVersion"',
]);
check('header version badge has visible semver fallback', /id="appVersion"[^>]*>v\d+\.\d+\.\d+</.test(html));
check('header version fallback matches package version', html.includes(`id="appVersion" class="appVersion">v${pkg.version}</span>`));
includesAll('hidden full log sink contract', html, [
  '<pre id="log" class="hidden" aria-hidden="true"></pre>',
]);
check('visible full runtime log rail stays removed', !html.includes('Full runtime log') && !html.includes('logPanel') && !html.includes('rightRail'));
includesAll('panel minimize and stage resize contract', html, [
  'class="panelMinimize"',
  'id="stageResizer"',
  'aria-label="Resize Generate and Preview panels"',
]);
includesAll('viewer canvas contract', html, [
  'id="plyCanvas"',
  'id="plyCanvas2D"',
  'id="glbCanvas"',
]);
includesAll('Pixal3D native option controls', html, [
  'id="pixalQuality"',
  'id="pixalResolution"',
  'id="pixalFovDegrees"',
  'Standard (~18GB)',
  'Low VRAM (~10–12GB)',
  '8GB Experimental',
]);
includesAll('SAM 3D Objects option controls', html, [
  'id="sam3dModeButton"',
  'id="sam3dBackendUrl"',
  'id="sam3dMaskPath"',
  'id="sam3dCheckButton"',
  'id="sam3dRunButton"',
  'at least 32GB VRAM',
  'no low-memory mode',
]);
check('obsolete Pixal3D license checkbox removed', !html.includes('id="pixalAccept"'));
check('obsolete Pixal3D academic-only copy removed', !/academic\/research-only|not for commercial\/production|not intended for EU use/i.test(html));

includesAll('layout style contract', css, [
  '.appVersion',
  '.panelMinimize',
  '.stageResizer',
  '#plyCanvas, #plyCanvas2D, #glbCanvas',
]);
check('workbench has no full-log right rail column', !/\.workbench\s*\{[^}]*grid-template-columns:[^;}]*minmax\(220px,\s*300px\)/s.test(css));

includesAll('renderer element map contract', renderer, [
  "appVersion: $('appVersion')",
  "stageResizer: $('stageResizer')",
  "plyCanvas: $('plyCanvas')",
  "plyCanvas2D: $('plyCanvas2D')",
  'sharpSplat.getAppVersion()',
]);
includesAll('renderer Pixal3D options bridge', renderer, [
  "pixalResolution: $('pixalResolution')",
  "pixalFovDegrees: $('pixalFovDegrees')",
  'pixalResolution: el.pixalResolution',
  'pixalFovDegrees: el.pixalFovDegrees',
]);
includesAll('renderer SAM 3D Objects bridge', renderer, [
  "sam3dModeButton: $('sam3dModeButton')",
  "sam3dBackendUrl: $('sam3dBackendUrl')",
  'sharpSplat.checkSam3D(readOptions())',
  'sharpSplat.runSam3D(readOptions())',
  "setMode('sam3d')",
]);
check('renderer has no obsolete Pixal3D license gate', !renderer.includes('requirePixalLicense') && !renderer.includes('acceptLicense'));
includesAll('PLY fallback visibility contract', renderer, [
  "el.plyCanvas.classList.add('hidden')",
  "el.plyCanvas2D.classList.remove('hidden')",
  'resetViewerCamera();',
]);
check('Babylon Y-flip tolerates Scene.meshes fallback', /typeof scene\.getMeshes === 'function' \? scene\.getMeshes\(\) : scene\.meshes/.test(renderer));
check('PLY fallback avoids requiring both canvases visible for keyboard handling', renderer.includes("el.plyCanvas.classList.contains('hidden') && el.plyCanvas2D.classList.contains('hidden')"));

includesAll('preload app version bridge', preload, [
  'getAppVersion',
  "ipcRenderer.invoke('get-app-version')",
]);
includesAll('preload SAM 3D Objects bridge', preload, [
  'selectSam3DMask',
  'checkSam3D',
  'runSam3D',
]);
includesAll('silent updater contract', main, [
  "ipcMain.handle('get-app-version'",
  'autoUpdater.quitAndInstall(true, true)',
]);
check('installer UI updater regression stays blocked', !main.includes('autoUpdater.quitAndInstall(false, true)'));

includesAll('Pixal3D pinned integration contract', main, [
  'PIXAL3D_UPSTREAM_SHA',
  "['fetch', '--depth', '1', 'origin', PIXAL3D_UPSTREAM_SHA]",
  "['checkout', '--detach', '--force', PIXAL3D_UPSTREAM_SHA]",
  'markerData.upstreamSha === PIXAL3D_UPSTREAM_SHA',
  'markerData.integrationRevision === PIXAL3D_INTEGRATION_REVISION',
  'hasPixal3DWindowsPatch(repo)',
  '!markerMatches || !patchValid',
  'buildPixal3DInferenceArgs(request, outputGlb, profile)',
]);
check('main process has no obsolete Pixal3D env-only low-VRAM hook', !main.includes('PIXAL3D_LOW_VRAM'));
check('main process has no obsolete Pixal3D license gate', !main.includes('acceptLicense') && !/academic-only|not intended for EU use/i.test(main));

includesAll('SAM 3D Objects main-process provider contract', main, [
  'SAM3D_UPSTREAM_SHA',
  'SAM3D_MIN_VRAM_GB',
  'checkSam3DStatus',
  'runSam3D',
  "sam3dEndpoint(backendUrl, 'health')",
  "sam3dEndpoint(backendUrl, 'generate')",
  "ipcMain.handle('run-sam3d'",
  'there is no upstream low-memory mode',
]);

includesAll('SAM 3D Objects helper and bridge contract', `${sam3dIntegration}\n${sam3dBridge}\n${sam3dDocs}`, [
  'f91db411c50efee93d8db7aeb323885650f6f722',
  'http://127.0.0.1:7861',
  'SAM3D_MIN_VRAM_GB = 32',
  '@APP.get("/health")',
  '@APP.post("/generate")',
  'output.get("glb")',
  'no low-memory',
]);

includesAll('Pixal3D helper native CLI contract', pixalIntegration, [
  "const PIXAL3D_UPSTREAM_SHA = 'cdbb2bbffbf4e6f298b5f2af3d1d76a8d823d2af'",
  "const PIXAL3D_REMBG_REVISION = 'e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4'",
  "args.push('--low_vram')",
  "args.push('--resolution', String(resolution))",
  "args.push('--fov'",
  "elif config.ATTN == 'sdpa':",
  'Windows interpolation fallback',
  'PIXAL3D_REMBG_MODEL',
  'PIXAL3D_REMBG_REVISION',
  'code_revision',
  'hasPixal3DWindowsPatch',
]);
check('obsolete Pixal3D sparse-attention rewrite removed', !pixalIntegration.includes('_sdpa_varlen') && !pixalIntegration.includes('sparseConfig = sparseConfig'));
check('obsolete arbitrary RMBG output adapter removed', !pixalIntegration.includes('raw_preds = self.model'));

includesAll('Pixal3D current licensing documentation', `${pixalDocs}\n${notice}`, [
  'MIT',
  'cdbb2bbffbf4e6f298b5f2af3d1d76a8d823d2af',
  'third-party',
  'Hugging Face model metadata',
  'ZhengPeng7/BiRefNet',
  'e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4',
  'nvdiffrast',
]);
check('stale Pixal3D license claims removed from docs', !/academic\/research-only|forbids commercial|not intended for use within the EU/i.test(`${pixalDocs}\n${notice}`));

includesAll('CI release gate contract', workflow, [
  'actions/setup-python@v5',
  "python-version: '3.11'",
  'npm run gate:release:prebuild',
  'npm run test:pixal3d:upstream',
  'npm run gate:release:postbuild',
  'Build Windows installer',
  'Publish GitHub release assets',
  "if: github.ref_type == 'tag'",
]);
check('QA includes local Pixal3D integration tests', pkg.scripts.qa.includes('test:pixal3d'));
check('QA includes SAM 3D Objects integration tests', pkg.scripts.qa.includes('test:sam3d'));

if (failures.length) {
  console.error('Regression gate failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  version: pkg.version,
  checks: [
    'version badge',
    'panel minimize',
    'generate preview resizer',
    'hidden full log sink',
    'split PLY canvases',
    'PLY fallback',
    'silent updater',
    'CI qa gate',
  ],
}, null, 2));
