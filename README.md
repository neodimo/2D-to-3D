# 2D to 3D

Independent Windows GUI wrapper for Apple `ml-sharp` / SHARP: one frame in, standard 3D Gaussian Splat `.ply` out.

This is not an Apple product, is not affiliated with Apple, and is not endorsed by Apple.

## What this does

- GUI input picker for `.exr`, `.png`, `.jpg`, `.jpeg`
- Output folder picker
- Fixed-size input preview
- EXR path: converts ACEScg/linear EXR to tone-mapped sRGB PNG for SHARP inference while preserving the original EXR
- Runs Apple SHARP via `sharp predict -i <input> -o <folder>`
- Optional Pixal3D mode creates a textured `.glb` with Standard, Low VRAM, and 8GB Experimental GPU profiles
- Optional SAM 3D Objects mode connects to an official Linux 32GB+ GPU environment and creates a masked-object vertex-colored `.glb`
- Pixal3D exposes 1024/1536 generation resolution and an optional manual camera FOV
- Detects stitched 2:1 PNG/JPEG panoramas and reveals a 360 SHARP mode
- 360 mode clones the SHARP_360_to_Splat backend on first use, extracts perspective views, runs SHARP per view, aligns them, and writes a merged `.ply`
- 360 mode can optionally use tiled InfiniDepth as an external depth reference instead of DA360
- Streams the runtime log into its own scrollable pane
- Shows a coarse progress bar for install/conversion/inference activity
- Opens/shows the output `.ply`
- Loads the generated `.ply` into a built-in point-cloud preview with drag-rotate and wheel-zoom controls

## Packaging / updates

Starting with v0.4, the preferred Windows build is an installer build (`2D-to-3D-Setup-<version>.exe`) instead of a manually managed portable ZIP folder.

The app includes **Check updates** and **Restart to update** controls. Updates are downloaded through GitHub Releases and applied on restart by Electron's standard updater.

SHARP depends on Python, PyTorch, torchvision, gsplat, and a model checkpoint, so that heavy runtime is kept outside the app install in Electron's stable user-data folder:

```text
%APPDATA%/2D to 3D/sharp-runtime/
```

That keeps app updates from reinstalling the Python/PyTorch/model runtime every time.

## First run on Windows

1. Run `2D-to-3D-Setup-<version>.exe`.
2. Launch **2D to 3D** from the installer shortcut.
3. Click **Install/check runtime** or just **Run SHARP**.
4. The first runtime install may take a while and needs internet; PyTorch and the SHARP model are large.
5. Choose an input frame and output folder, then run.

Apple SHARP source is bundled under the app's `resources/ml-sharp` folder. The Python environment installs into the user-data `sharp-runtime/venv` folder.

## Licensing / attribution

- 2D to 3D wrapper code is licensed under MIT. See `LICENSE`.
- Apple `ml-sharp` / SHARP source is vendored under `vendor/ml-sharp` and remains governed by Apple's license and model license. See `vendor/ml-sharp/LICENSE` and `vendor/ml-sharp/LICENSE_MODEL`.
- Bundled `uv` Windows binaries under `vendor/uv` come from Astral's `uv` project and remain under upstream uv licensing.
- See `NOTICE` for attribution and no-endorsement notes.
- Optional TencentARC/Pixal3D source and official weights are downloaded at runtime under MIT; their third-party runtime components keep separate terms. See `NOTICE` and `EXPERIMENTAL_PIXAL3D.md`.
- Optional Meta SAM 3D Objects code/checkpoints use Meta's SAM License and remain on a separately configured Linux backend. See `NOTICE` and `SAM3D_OBJECTS.md`.

## Notes

- SHARP can run prediction on CPU, CUDA, or MPS, but Windows will usually be CPU or CUDA.
- 360 panorama mode defaults to 4 views and overlap alignment. InfiniDepth and DA360 are optional depth-reference paths; CPU is available as a slow fallback.
- Rendering preview trajectories from Apple SHARP requires CUDA; this wrapper only runs prediction/export for now.
- The built-in `.ply` viewer uses the official PlayCanvas SuperSplat viewer path first, with the older Babylon/point preview kept as a fallback.
- The output `.ply` is Apple SHARP's own 3DGS PLY, not the fallback textured-card approximation.
- Pixal3D Standard is documented upstream at roughly 18GB peak VRAM; Low VRAM is roughly 10–12GB. The app's 8GB profile remains experimental and may run out of memory.
- SAM 3D Objects officially requires Linux x64 and at least 32GB NVIDIA VRAM. Upstream provides no low-memory fallback; Windows connects through WSL2 or a remote/private Linux backend.
- GitHub auto-updates require the published update assets (`latest.yml`, installer, blockmap) to be reachable by the installed app. Do not embed a private GitHub token in the app.
