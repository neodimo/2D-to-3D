# SAM 3D Objects Provider

SAM 3D Objects is an optional masked-image-to-GLB provider. The Windows app talks to a small HTTP bridge running inside Meta's official Linux environment. This keeps the large CUDA stack isolated and also permits a Windows client to use WSL2 or a remote Linux GPU.

## Hardware and operating system

Meta's official requirements are:

- Linux x64
- NVIDIA GPU with at least 32GB VRAM
- CUDA environment created from the upstream setup

The official implementation has no low-memory or CPU fallback. The app reports this directly and does not claim that a smaller GPU is supported.

## Pinned upstream source

The bridge and app contract were validated against:

```text
https://github.com/facebookresearch/sam-3d-objects.git
f91db411c50efee93d8db7aeb323885650f6f722
```

## Backend setup

1. Clone the official repository on the Linux GPU host and check out the pinned commit.
2. Follow upstream `doc/setup.md` to create the environment and install dependencies.
3. Request access to `facebook/sam-3d-objects` on Hugging Face, authenticate with `hf auth login`, and download the checkpoints into `checkpoints/hf` as documented upstream.
4. From the activated official environment, start the bridge bundled with this app:

```bash
python /path/to/sam3d_objects_server.py \
  --repo /path/to/sam-3d-objects \
  --host 127.0.0.1 \
  --port 7861
```

In a development checkout the bridge is `scripts/sam3d_objects_server.py`. In an installed Windows build it is copied to `resources/scripts/sam3d_objects_server.py` beside the app installation.

For WSL2 or a remote host, use an SSH tunnel or another authenticated private transport to expose the loopback port to the Windows app. The bridge intentionally has no authentication and must not be bound directly to a public interface.

## Input mask

SAM 3D Objects requires an object mask:

- Choose a separate PNG/JPEG mask where white or any nonzero value marks the object; or
- use a PNG input whose alpha channel already isolates the object.

The mask dimensions must exactly match the input image. A fully opaque image without a separate mask is rejected instead of silently treating the whole frame as the object.

## Output

The bridge uses Meta's public notebook inference wrapper and exports its GLB/Trimesh result with vertex colors. It keeps upstream texture baking disabled because that path introduces separate dependency terms. The result opens in the app's existing GLB viewer.

## License

SAM 3D Objects code and checkpoints use Meta's SAM License. Checkpoint access is gated on Hugging Face. Review the upstream license and acceptable-use/export restrictions before deployment or redistribution. The app does not bundle the model or checkpoints.

