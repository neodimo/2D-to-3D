'use strict';

const path = require('path');

const SAM3D_REPO_URL = 'https://github.com/facebookresearch/sam-3d-objects.git';
const SAM3D_UPSTREAM_SHA = 'f91db411c50efee93d8db7aeb323885650f6f722';
const SAM3D_DEFAULT_BACKEND_URL = 'http://127.0.0.1:7861';
const SAM3D_MIN_VRAM_GB = 32;
const SAM3D_LICENSE_SUMMARY = 'SAM 3D Objects code and checkpoints use Meta\'s SAM License. Checkpoint access requires Hugging Face approval and authentication.';

function normalizeSam3DBackendUrl(value) {
  const raw = String(value || SAM3D_DEFAULT_BACKEND_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error(`SAM 3D Objects backend URL is invalid: ${raw}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('SAM 3D Objects backend URL must use http:// or https://.');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.href.replace(/\/$/, '');
}

function sam3dEndpoint(baseUrl, endpoint) {
  const base = normalizeSam3DBackendUrl(baseUrl);
  return `${base}/${String(endpoint || '').replace(/^\/+/, '')}`;
}

function sam3dOutputPath(outputFolder, inputPath) {
  const stem = path.basename(inputPath, path.extname(inputPath)).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(outputFolder, `${stem}_sam3d.glb`);
}

module.exports = {
  SAM3D_REPO_URL,
  SAM3D_UPSTREAM_SHA,
  SAM3D_DEFAULT_BACKEND_URL,
  SAM3D_MIN_VRAM_GB,
  SAM3D_LICENSE_SUMMARY,
  normalizeSam3DBackendUrl,
  sam3dEndpoint,
  sam3dOutputPath,
};
