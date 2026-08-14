'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PIXAL3D_REPO_URL = 'https://github.com/TencentARC/Pixal3D.git';
const PIXAL3D_UPSTREAM_SHA = 'cdbb2bbffbf4e6f298b5f2af3d1d76a8d823d2af';
const PIXAL3D_INTEGRATION_REVISION = 'native-cli-windows-v2';
const PIXAL3D_REMBG_MODEL = 'ZhengPeng7/BiRefNet';
const PIXAL3D_REMBG_REVISION = 'e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4';
const PIXAL3D_LICENSE_SUMMARY = 'Pixal3D code and official weights are MIT. Downloaded third-party components keep their own terms, and the Hugging Face model metadata flags EU access as disallowed.';

const PIXAL3D_WINDOWS_PATCH_HASHES = {
  'inference.py': 'a5fb988fe9a998d7bc77deb0758e0960f3fed1fd696f225f9e5efe002a19b556',
  'pixal3d/pipelines/rembg/BiRefNet.py': 'ed7bbf9b538e3f2a4dddcb142b9194c0f9bafae9e243ae77e693839876709b57',
  'pixal3d/pipelines/pixal3d_image_to_3d.py': '10b491b5a98d652dd34cc0d868ef446b69ea29b6d83bca9b92104c9660ac1301',
  'pixal3d/trainers/flow_matching/mixins/image_conditioned_proj.py': '615fbbf3b236790e7b6ee62e059ab0476aaebbbb1944fd28135ca3e3a9c8ae39',
};

function pixal3dInstallMarkerName(platform = process.platform) {
  return `install-${platform}-${PIXAL3D_UPSTREAM_SHA.slice(0, 12)}-${PIXAL3D_INTEGRATION_REVISION}.json`;
}

function resolvePixal3DProfile(request = {}, vramMb = null) {
  const requested = request.pixalQuality || 'auto';
  const autoProfile = vramMb && vramMb >= 20000
    ? 'full'
    : (vramMb && vramMb >= 8000 ? 'aggressive' : 'compat');
  const name = ['full', 'aggressive', 'compat'].includes(requested) ? requested : autoProfile;
  return {
    name,
    lowVram: name !== 'full',
    windowsCatGuard: name !== 'full',
  };
}

function normalizeResolution(value) {
  if (value === undefined || value === null || value === '' || value === 'auto') return null;
  const resolution = Number(value);
  if (resolution !== 1024 && resolution !== 1536) {
    throw new Error(`Pixal3D resolution must be Auto, 1024, or 1536; got ${value}.`);
  }
  return resolution;
}

function normalizeFovDegrees(value) {
  if (value === undefined || value === null || value === '') return null;
  const degrees = Number(value);
  if (!Number.isFinite(degrees) || degrees <= 0 || degrees >= 180) {
    throw new Error(`Pixal3D FOV must be between 0 and 180 degrees; got ${value}.`);
  }
  return degrees;
}

function buildPixal3DInferenceArgs(request, outputGlb, profile) {
  const args = [
    '-u', 'inference.py',
    '--image', request.inputPath,
    '--output', outputGlb,
    '--seed', String(request.seed || 42),
  ];

  if (profile.lowVram) args.push('--low_vram');

  const resolution = normalizeResolution(request.pixalResolution) || (profile.lowVram ? 1024 : 1536);
  args.push('--resolution', String(resolution));

  const fovDegrees = normalizeFovDegrees(request.pixalFovDegrees);
  if (fovDegrees) args.push('--fov', String(fovDegrees * Math.PI / 180));

  return args;
}

function requireFiles(repo, relativePaths) {
  for (const relativePath of relativePaths) {
    if (!fs.existsSync(path.join(repo, relativePath))) {
      throw new Error(`Pinned Pixal3D source is missing ${relativePath}.`);
    }
  }
}

function assertNativeUpstreamContract(repo) {
  const inference = fs.readFileSync(path.join(repo, 'inference.py'), 'utf8');
  const sparseConfig = fs.readFileSync(path.join(repo, 'pixal3d', 'modules', 'sparse', 'config.py'), 'utf8');
  const sparseAttention = fs.readFileSync(path.join(repo, 'pixal3d', 'modules', 'sparse', 'attention', 'full_attn.py'), 'utf8');
  const requiredInferenceFlags = [
    'parser.add_argument("--low_vram"',
    'parser.add_argument("--resolution"',
    'parser.add_argument("--fov"',
  ];
  for (const flag of requiredInferenceFlags) {
    if (!inference.includes(flag)) throw new Error(`Pinned Pixal3D inference contract is missing ${flag}.`);
  }
  if (!sparseConfig.includes("'sdpa'")) throw new Error('Pinned Pixal3D sparse config no longer accepts SDPA.');
  if (!sparseAttention.includes("elif config.ATTN == 'sdpa':")) {
    throw new Error('Pinned Pixal3D sparse attention no longer implements SDPA.');
  }
}

function patchPixal3DWindowsSource(repo, log = () => {}) {
  const inferencePath = path.join(repo, 'inference.py');
  const rembgPath = path.join(repo, 'pixal3d', 'pipelines', 'rembg', 'BiRefNet.py');
  const pipelinePath = path.join(repo, 'pixal3d', 'pipelines', 'pixal3d_image_to_3d.py');
  const imageCondPath = path.join(repo, 'pixal3d', 'trainers', 'flow_matching', 'mixins', 'image_conditioned_proj.py');
  requireFiles(repo, [
    'inference.py',
    'pixal3d/modules/sparse/config.py',
    'pixal3d/modules/sparse/attention/full_attn.py',
    'pixal3d/pipelines/rembg/BiRefNet.py',
    'pixal3d/pipelines/pixal3d_image_to_3d.py',
    'pixal3d/trainers/flow_matching/mixins/image_conditioned_proj.py',
  ]);
  assertNativeUpstreamContract(repo);

  let inference = fs.readFileSync(inferencePath, 'utf8').replace(/\r\n/g, '\n');
  inference = inference.replace(
    'os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"',
    'os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")'
  );
  if (!inference.includes('os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF"')) {
    throw new Error('Pinned Pixal3D allocator configuration marker changed upstream.');
  }
  fs.writeFileSync(inferencePath, inference);

  let rembg = fs.readFileSync(rembgPath, 'utf8').replace(/\r\n/g, '\n');
  if (!rembg.includes('PIXAL3D_REMBG_MODEL')) {
    const oldLoader = '    def __init__(self, model_name: str = "ZhengPeng7/BiRefNet"):\n        self.model = AutoModelForImageSegmentation.from_pretrained(\n            model_name, trust_remote_code=True\n        )';
    const newLoader = `    def __init__(self, model_name: str = "${PIXAL3D_REMBG_MODEL}"):
        import os
        requested_model_name = model_name
        model_name = os.environ.get("PIXAL3D_REMBG_MODEL") or model_name
        model_revision = os.environ.get("PIXAL3D_REMBG_REVISION") or (
            "${PIXAL3D_REMBG_REVISION}" if model_name == "${PIXAL3D_REMBG_MODEL}" else None
        )
        if not model_revision:
            raise RuntimeError(
                "Set PIXAL3D_REMBG_REVISION to an immutable Hugging Face commit "
                "when overriding PIXAL3D_REMBG_MODEL."
            )
        if requested_model_name != model_name:
            print(f"[RMBG] Using {model_name} instead of {requested_model_name}", flush=True)
        if model_revision:
            print(f"[RMBG] Pinned revision: {model_revision}", flush=True)
        load_kwargs = {"trust_remote_code": True}
        if model_revision:
            load_kwargs["revision"] = model_revision
            load_kwargs["code_revision"] = model_revision
        try:
            self.model = AutoModelForImageSegmentation.from_pretrained(
                model_name, **load_kwargs
            )
        except Exception as exc:
            if "gated repo" in str(exc).lower() or "401 client error" in str(exc).lower():
                raise RuntimeError(
                    f"Pixal3D background-removal model {model_name!r} is gated on Hugging Face. "
                    "Accept access on Hugging Face and run with a token, or set PIXAL3D_REMBG_MODEL "
                    "and PIXAL3D_REMBG_REVISION to a compatible public model."
                ) from exc
            raise`;
    if (!rembg.includes(oldLoader)) throw new Error('Pinned Pixal3D BiRefNet loader marker changed upstream.');
    rembg = rembg.replace(oldLoader, newLoader);
  }
  fs.writeFileSync(rembgPath, rembg);

  let pipeline = fs.readFileSync(pipelinePath, 'utf8').replace(/\r\n/g, '\n');
  if (!pipeline.includes('Windows RMBG empty mask fallback')) {
    const oldBbox = '        alpha = output_np[:, :, 3]\n        bbox = np.argwhere(alpha > 0.8 * 255)\n        bbox = np.min(bbox[:, 1]), np.min(bbox[:, 0]), np.max(bbox[:, 1]), np.max(bbox[:, 0])';
    const newBbox = '        alpha = output_np[:, :, 3]\n        bbox = np.argwhere(alpha > 0.8 * 255)\n        if bbox.size == 0:\n            # Windows RMBG empty mask fallback: keep processing with the full image.\n            print("[RMBG] Empty foreground mask; using full image crop fallback", flush=True)\n            output = output.convert("RGBA")\n            output.putalpha(255)\n            output_np = np.array(output)\n            alpha = output_np[:, :, 3]\n            bbox = np.argwhere(alpha > 0)\n        bbox = np.min(bbox[:, 1]), np.min(bbox[:, 0]), np.max(bbox[:, 1]), np.max(bbox[:, 0])';
    if (!pipeline.includes(oldBbox)) throw new Error('Pinned Pixal3D preprocess bbox marker changed upstream.');
    pipeline = pipeline.replace(oldBbox, newBbox);
  }
  fs.writeFileSync(pipelinePath, pipeline);

  let imageCond = fs.readFileSync(imageCondPath, 'utf8').replace(/\r\n/g, '\n');
  if (!imageCond.includes('PIXAL3D_WINDOWS_CAT_GUARD')) {
    const oldCat = '                # Concatenate lr and hr: [B, grid_res³, D*2]\n                z_proj = torch.cat([z_proj_lr, z_proj_hr], dim=-1)';
    const newCat = '                # Concatenate lr and hr: [B, grid_res³, D*2]\n                # Optional Windows 8GB guard; full-GPU mode preserves upstream dtypes.\n                if os.environ.get("PIXAL3D_WINDOWS_CAT_GUARD", "0") == "1":\n                    z_proj_lr = z_proj_lr.to(torch.bfloat16)\n                    z_proj_hr = z_proj_hr.to(torch.bfloat16)\n                    if torch.cuda.is_available():\n                        torch.cuda.empty_cache()\n                z_proj = torch.cat([z_proj_lr, z_proj_hr], dim=-1)';
    if (!imageCond.includes(oldCat)) throw new Error('Pinned Pixal3D projected-feature concat marker changed upstream.');
    imageCond = imageCond.replace(oldCat, newCat);
  }
  if (!imageCond.includes('Windows interpolation fallback')) {
    const newLoadNaf = `    def _load_naf(self):
        """Lazy-load a Windows-safe NAF replacement."""
        if self.naf_model is None:
            import torch
            import torch.nn.functional as F
            device = next(self.model.parameters()).device

            class _WindowsInterpolationNAF(torch.nn.Module):
                def forward(self, image, lr_features, output_size):
                    return F.interpolate(
                        lr_features,
                        size=output_size,
                        mode="bilinear",
                        align_corners=False,
                    )

            print("[NAF] Using Windows interpolation fallback instead of NATTEN-backed NAF", flush=True)
            self.naf_model = _WindowsInterpolationNAF().to(device)
            self.naf_model.eval()
            self.naf_model.requires_grad_(False)
`;
    const loadNafMatch = imageCond.match(/    def _load_naf\(self\):\n[\s\S]*?(?=\n    def to\(self, device\):)/);
    if (!loadNafMatch) throw new Error('Pinned Pixal3D NAF loader marker changed upstream.');
    imageCond = imageCond.replace(loadNafMatch[0], newLoadNaf.trimEnd());
  }
  fs.writeFileSync(imageCondPath, imageCond);

  log(`Pinned Pixal3D ${PIXAL3D_UPSTREAM_SHA.slice(0, 12)}: using native low-VRAM/SDPA/FOV/resolution with Windows NAF and RMBG fallbacks.`);
  return {
    upstreamSha: PIXAL3D_UPSTREAM_SHA,
    integrationRevision: PIXAL3D_INTEGRATION_REVISION,
  };
}

function hasPixal3DWindowsPatch(repo) {
  try {
    assertNativeUpstreamContract(repo);
    return Object.entries(PIXAL3D_WINDOWS_PATCH_HASHES).every(([relativePath, expected]) => {
      if (!/^[0-9a-f]{64}$/.test(expected)) return false;
      const source = fs.readFileSync(path.join(repo, relativePath));
      return crypto.createHash('sha256').update(source).digest('hex') === expected;
    });
  } catch (_) {
    return false;
  }
}

module.exports = {
  PIXAL3D_REPO_URL,
  PIXAL3D_UPSTREAM_SHA,
  PIXAL3D_INTEGRATION_REVISION,
  PIXAL3D_REMBG_MODEL,
  PIXAL3D_REMBG_REVISION,
  PIXAL3D_LICENSE_SUMMARY,
  pixal3dInstallMarkerName,
  resolvePixal3DProfile,
  normalizeResolution,
  normalizeFovDegrees,
  buildPixal3DInferenceArgs,
  assertNativeUpstreamContract,
  patchPixal3DWindowsSource,
  hasPixal3DWindowsPatch,
};
