'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  PIXAL3D_REPO_URL,
  PIXAL3D_UPSTREAM_SHA,
  PIXAL3D_INTEGRATION_REVISION,
  PIXAL3D_REMBG_MODEL,
  PIXAL3D_REMBG_REVISION,
  pixal3dInstallMarkerName,
  resolvePixal3DProfile,
  buildPixal3DInferenceArgs,
  assertNativeUpstreamContract,
  patchPixal3DWindowsSource,
  hasPixal3DWindowsPatch,
} = require('../src/lib/pixal3d.cjs');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return String(result.stdout || '').trim();
}

function write(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function makePatchFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixal3d-fixture-'));
  write(root, 'inference.py', `
import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
parser.add_argument("--fov", type=float)
parser.add_argument("--low_vram", action="store_true")
parser.add_argument("--resolution", type=int)
`);
  write(root, 'pixal3d/modules/sparse/config.py', "ALLOWED = ['xformers', 'flash_attn', 'sdpa']\n");
  write(root, 'pixal3d/modules/sparse/attention/full_attn.py', "if False:\n    pass\nelif config.ATTN == 'sdpa':\n    pass\n");
  write(root, 'pixal3d/pipelines/rembg/BiRefNet.py', `
from transformers import AutoModelForImageSegmentation
import torch

class BiRefNet:
    def __init__(self, model_name: str = "ZhengPeng7/BiRefNet"):
        self.model = AutoModelForImageSegmentation.from_pretrained(
            model_name, trust_remote_code=True
        )

    def __call__(self, input_images):
        with torch.no_grad():
            preds = self.model(input_images)[-1].sigmoid().cpu()
        return preds
`);
  write(root, 'pixal3d/pipelines/pixal3d_image_to_3d.py', `
import numpy as np

def preprocess(output_np):
        alpha = output_np[:, :, 3]
        bbox = np.argwhere(alpha > 0.8 * 255)
        bbox = np.min(bbox[:, 1]), np.min(bbox[:, 0]), np.max(bbox[:, 1]), np.max(bbox[:, 0])
        return bbox
`);
  write(root, 'pixal3d/trainers/flow_matching/mixins/image_conditioned_proj.py', `
import os
import torch

class Extractor:
    def _load_naf(self):
        """Lazy-load pretrained NAF model."""
        if self.naf_model is None:
            import torch.hub
            device = next(self.model.parameters()).device
            self.naf_model = torch.hub.load(
                "valeoai/NAF", "naf", pretrained=True, device=device, trust_repo=True
            )
            self.naf_model.eval()
            self.naf_model.requires_grad_(False)

    def to(self, device):
        return self

    def project(self, z_proj_lr, z_proj_hr):
                # Concatenate lr and hr: [B, grid_res³, D*2]
                z_proj = torch.cat([z_proj_lr, z_proj_hr], dim=-1)
                return z_proj
`);
  return root;
}

function snapshotPatchedFiles(root) {
  return [
    'inference.py',
    'pixal3d/pipelines/rembg/BiRefNet.py',
    'pixal3d/pipelines/pixal3d_image_to_3d.py',
    'pixal3d/trainers/flow_matching/mixins/image_conditioned_proj.py',
  ].map((relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')).join('\n---FILE---\n');
}

function testProfilesAndArgs() {
  assert.strictEqual(resolvePixal3DProfile({}, null).name, 'compat');
  assert.strictEqual(resolvePixal3DProfile({}, 7999).name, 'compat');
  assert.strictEqual(resolvePixal3DProfile({}, 8000).name, 'aggressive');
  assert.strictEqual(resolvePixal3DProfile({}, 19999).name, 'aggressive');
  assert.strictEqual(resolvePixal3DProfile({}, 20000).name, 'full');
  assert.strictEqual(resolvePixal3DProfile({ pixalQuality: 'full' }, 8000).name, 'full');
  assert.strictEqual(resolvePixal3DProfile({ pixalQuality: 'compat' }, 24000).name, 'compat');

  const base = { inputPath: 'input.png', seed: 7, pixalResolution: 'auto', pixalFovDegrees: null };
  const fullArgs = buildPixal3DInferenceArgs(base, 'output.glb', { lowVram: false });
  assert(!fullArgs.includes('--low_vram'));
  assert.deepStrictEqual(fullArgs.slice(fullArgs.indexOf('--resolution'), fullArgs.indexOf('--resolution') + 2), ['--resolution', '1536']);

  const lowArgs = buildPixal3DInferenceArgs(base, 'output.glb', { lowVram: true });
  assert(lowArgs.includes('--low_vram'));
  assert.deepStrictEqual(lowArgs.slice(lowArgs.indexOf('--resolution'), lowArgs.indexOf('--resolution') + 2), ['--resolution', '1024']);

  const forced = buildPixal3DInferenceArgs({ ...base, pixalResolution: '1536', pixalFovDegrees: 60 }, 'output.glb', { lowVram: true });
  assert.deepStrictEqual(forced.slice(forced.indexOf('--resolution'), forced.indexOf('--resolution') + 2), ['--resolution', '1536']);
  const fov = Number(forced[forced.indexOf('--fov') + 1]);
  assert(Math.abs(fov - Math.PI / 3) < 1e-12);
  assert.throws(() => buildPixal3DInferenceArgs({ ...base, pixalResolution: '720' }, 'output.glb', { lowVram: true }), /resolution/);
  assert.throws(() => buildPixal3DInferenceArgs({ ...base, pixalFovDegrees: 0 }, 'output.glb', { lowVram: true }), /FOV/);
  assert.throws(() => buildPixal3DInferenceArgs({ ...base, pixalFovDegrees: 180 }, 'output.glb', { lowVram: true }), /FOV/);
}

function testLocalPatchFixture() {
  const root = makePatchFixture();
  try {
    assertNativeUpstreamContract(root);
    patchPixal3DWindowsSource(root);
    const first = snapshotPatchedFiles(root);
    patchPixal3DWindowsSource(root);
    const second = snapshotPatchedFiles(root);
    assert.strictEqual(second, first, 'Pixal3D Windows patch must be idempotent');
    assert(first.includes('PIXAL3D_REMBG_MODEL'));
    assert(first.includes('PIXAL3D_REMBG_REVISION'));
    assert(first.includes('code_revision'));
    assert(first.includes(PIXAL3D_REMBG_REVISION));
    assert(first.includes('Windows RMBG empty mask fallback'));
    assert(first.includes('Windows interpolation fallback'));
    assert(first.includes('PIXAL3D_WINDOWS_CAT_GUARD'));
    assert(first.includes('os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF"'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function checkoutPinnedUpstream() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixal3d-upstream-'));
  run('git', ['init', '-q'], { cwd: root });
  run('git', ['remote', 'add', 'origin', PIXAL3D_REPO_URL], { cwd: root });
  run('git', ['fetch', '--depth', '1', 'origin', PIXAL3D_UPSTREAM_SHA], { cwd: root });
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: root });
  return root;
}

function testRealUpstream(root) {
  const revision = run('git', ['rev-parse', 'HEAD'], { cwd: root });
  assert.strictEqual(revision, PIXAL3D_UPSTREAM_SHA);
  assertNativeUpstreamContract(root);
  patchPixal3DWindowsSource(root);
  const first = snapshotPatchedFiles(root);
  patchPixal3DWindowsSource(root);
  assert.strictEqual(snapshotPatchedFiles(root), first, 'Real upstream patch must be idempotent');
  assert(hasPixal3DWindowsPatch(root), 'Real upstream patch hashes must match the integration contract');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  run(python, [
    '-m', 'py_compile',
    path.join(root, 'inference.py'),
    path.join(root, 'pixal3d', 'pipelines', 'rembg', 'BiRefNet.py'),
    path.join(root, 'pixal3d', 'pipelines', 'pixal3d_image_to_3d.py'),
    path.join(root, 'pixal3d', 'trainers', 'flow_matching', 'mixins', 'image_conditioned_proj.py'),
  ]);
  fs.appendFileSync(path.join(root, 'pixal3d', 'pipelines', 'rembg', 'BiRefNet.py'), '\n# corruption probe\n');
  assert(!hasPixal3DWindowsPatch(root), 'Patch hash validation must reject modified runtime source');
}

function main() {
  assert(/^[0-9a-f]{40}$/.test(PIXAL3D_UPSTREAM_SHA));
  assert(PIXAL3D_INTEGRATION_REVISION);
  assert.strictEqual(PIXAL3D_REMBG_MODEL, 'ZhengPeng7/BiRefNet');
  assert(/^[0-9a-f]{40}$/.test(PIXAL3D_REMBG_REVISION));
  assert(pixal3dInstallMarkerName('win32').includes(PIXAL3D_UPSTREAM_SHA.slice(0, 12)));
  testProfilesAndArgs();
  testLocalPatchFixture();

  const upstreamFlag = process.argv.indexOf('--upstream');
  let upstreamRoot = upstreamFlag >= 0 ? process.argv[upstreamFlag + 1] : null;
  let ownsUpstream = false;
  if (upstreamFlag >= 0 && (!upstreamRoot || upstreamRoot.startsWith('--'))) {
    upstreamRoot = checkoutPinnedUpstream();
    ownsUpstream = true;
  }
  try {
    if (upstreamRoot) testRealUpstream(path.resolve(upstreamRoot));
  } finally {
    if (ownsUpstream) fs.rmSync(upstreamRoot, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    upstreamSha: PIXAL3D_UPSTREAM_SHA,
    integrationRevision: PIXAL3D_INTEGRATION_REVISION,
    realUpstreamChecked: !!upstreamRoot,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
