'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SAM3D_REPO_URL,
  SAM3D_UPSTREAM_SHA,
  SAM3D_DEFAULT_BACKEND_URL,
  SAM3D_MIN_VRAM_GB,
  normalizeSam3DBackendUrl,
  sam3dEndpoint,
  sam3dOutputPath,
} = require('../src/lib/sam3d.cjs');

assert.strictEqual(SAM3D_REPO_URL, 'https://github.com/facebookresearch/sam-3d-objects.git');
assert(/^[0-9a-f]{40}$/.test(SAM3D_UPSTREAM_SHA));
assert.strictEqual(SAM3D_MIN_VRAM_GB, 32);
assert.strictEqual(normalizeSam3DBackendUrl('http://127.0.0.1:7861/'), SAM3D_DEFAULT_BACKEND_URL);
assert.strictEqual(sam3dEndpoint('https://gpu.example.test/base/', '/health'), 'https://gpu.example.test/base/health');
assert.throws(() => normalizeSam3DBackendUrl('file:///tmp/backend'), /http/);
assert.throws(() => normalizeSam3DBackendUrl('not a url'), /invalid/);

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam3d-output-'));
try {
  assert.strictEqual(sam3dOutputPath(outputDir, '/tmp/My Object.png'), path.join(outputDir, 'My_Object_sam3d.glb'));
} finally {
  fs.rmSync(outputDir, { recursive: true, force: true });
}

const bridge = fs.readFileSync(path.join(__dirname, 'sam3d_objects_server.py'), 'utf8');
for (const marker of [
  '@APP.get("/health")',
  '@APP.post("/generate")',
  'output.get("glb")',
  'PNG with transparent background',
  SAM3D_UPSTREAM_SHA,
]) {
  assert(bridge.includes(marker), `SAM 3D bridge is missing ${marker}`);
}

console.log(JSON.stringify({
  ok: true,
  upstreamSha: SAM3D_UPSTREAM_SHA,
  minimumVramGb: SAM3D_MIN_VRAM_GB,
  defaultBackendUrl: SAM3D_DEFAULT_BACKEND_URL,
}, null, 2));
