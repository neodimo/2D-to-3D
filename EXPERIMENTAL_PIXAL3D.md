# Pixal3D Provider

Pixal3D is an optional image-to-GLB provider. It is isolated from the bundled/default SHARP runtime and downloads its own source, Python environment, CUDA extensions, and model weights on first use.

## Pinned upstream source

The app pins TencentARC/Pixal3D commit:

```text
cdbb2bbffbf4e6f298b5f2af3d1d76a8d823d2af
```

The pin prevents a new upstream commit from silently breaking an installed app. A changed pin or integration revision creates a new install marker, so the app refreshes the source before the next Pixal3D run.

The integration uses upstream's native command-line support for:

- `--low_vram`
- `--resolution 1024|1536`
- `--fov <radians>`
- dense and sparse PyTorch SDPA
- 4K textures and a one-million-face GLB export target

## GPU profiles

- **Standard** keeps models resident on CUDA, defaults to 1536, and is documented upstream at roughly 18GB peak VRAM.
- **Low VRAM** loads models stage by stage, defaults to 1024, and is documented upstream at roughly 10–12GB peak VRAM.
- **8GB Experimental** adds allocator/TF32 tuning and a conditional projected-feature memory guard to Low VRAM mode. An 8GB GPU remains below upstream's documented requirement and can still run out of memory.
- **Auto** selects Standard at 20GB+ dedicated VRAM, 8GB Experimental at 8–19GB, and Low VRAM when CUDA memory is lower or unknown.

Resolution can be forced to 1024 or 1536 independently. Camera FOV is entered in degrees in the app and converted to the radians expected by Pixal3D. Leaving it blank uses upstream MoGe-2 estimation.

## Windows compatibility

Upstream remains Linux-first. The Windows runtime currently:

1. Uses Python 3.11 with PyTorch 2.7.0 / CUDA 12.8 wheels.
2. Uses pinned, SHA-256-verified community wheels for `cumesh`, `flex_gemm`, `nvdiffrast`, `nvdiffrec_render`, and `o_voxel`.
3. Sets upstream's native dense and sparse attention backends to SDPA.
4. Skips NATTEN and replaces the NATTEN-backed NAF upsampler with deterministic bilinear interpolation.
5. Overrides the gated RMBG-2.0 configuration with public MIT-licensed `ZhengPeng7/BiRefNet`, pinned to Hugging Face commit `e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4`, and falls back to a full-image crop when the mask is empty.

The app verifies hashes for every Windows-patched upstream file before treating the runtime as ready. Custom `PIXAL3D_REMBG_MODEL` overrides must also provide an immutable `PIXAL3D_REMBG_REVISION`.

The NAF replacement can reduce detail relative to the native Linux path. The Windows community wheels and RTX 4070 8GB path require a real GPU smoke test after each integration revision.

## Licensing and access

TencentARC currently publishes the Pixal3D code and official model weights under MIT. Downloaded third-party components retain their own licenses and notices. The Hugging Face model metadata currently flags EU access as disallowed; that access metadata is separate from the MIT license.

See `NOTICE` and the upstream `LICENSE`/`NOTICE` files before redistribution or production use.

## Test flow

1. Run `npm ci`.
2. Run `npm run qa`.
3. Run `npm run test:pixal3d:upstream` to verify the patch contract against the pinned source.
4. Launch the app and choose **Pixal3D .GLB**.
5. Select a profile, resolution, and optional FOV.
6. Choose an input image and output folder, then click **Run Pixal3D GLB**. Install/update is automatic.
7. Inspect the `.glb` in the built-in viewer and an independent viewer such as Blender.

Full image-to-GLB inference cannot be validated on a non-CUDA Linux host.
