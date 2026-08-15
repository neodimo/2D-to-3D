"""Small HTTP bridge for the official Meta SAM 3D Objects environment.

Run this inside the Linux environment created from the upstream setup guide:

    python /path/to/sam3d_objects_server.py --repo /path/to/sam-3d-objects

The Electron app sends an image plus an optional binary mask and receives a GLB.
"""

from __future__ import annotations

import argparse
import io
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image
from starlette.background import BackgroundTask


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve SAM 3D Objects to 2D to 3D")
    parser.add_argument("--repo", required=True, help="Official sam-3d-objects checkout")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7861)
    parser.add_argument("--compile", action="store_true")
    parser.add_argument("--allow-unpinned", action="store_true", help="Allow a different upstream commit at your own risk")
    return parser.parse_args()


ARGS = parse_args()
REPO = Path(ARGS.repo).expanduser().resolve()
CONFIG = REPO / "checkpoints" / "hf" / "pipeline.yaml"
if not (REPO / "notebook" / "inference.py").is_file():
    raise SystemExit(f"Official SAM 3D Objects checkout is incomplete: {REPO}")
if not CONFIG.is_file():
    raise SystemExit(
        f"Checkpoint config is missing: {CONFIG}. Request Hugging Face access, "
        "authenticate, and download the official checkpoints first."
    )

try:
    CURRENT_UPSTREAM = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=REPO, text=True, stderr=subprocess.DEVNULL
    ).strip()
except (OSError, subprocess.CalledProcessError):
    CURRENT_UPSTREAM = "unknown"

EXPECTED_UPSTREAM = "f91db411c50efee93d8db7aeb323885650f6f722"
if CURRENT_UPSTREAM != EXPECTED_UPSTREAM and not ARGS.allow_unpinned:
    raise SystemExit(
        f"SAM 3D Objects checkout mismatch: expected {EXPECTED_UPSTREAM}, got {CURRENT_UPSTREAM}. "
        "Check out the pinned commit or pass --allow-unpinned after validating compatibility."
    )

os.chdir(REPO)
sys.path.insert(0, str(REPO / "notebook"))
sys.path.insert(0, str(REPO))

from inference import Inference  # noqa: E402


APP = FastAPI(title="2D to 3D — SAM 3D Objects bridge", version="1")
PIPELINE: Inference | None = None


def pipeline() -> Inference:
    global PIPELINE
    if PIPELINE is None:
        PIPELINE = Inference(str(CONFIG), compile=ARGS.compile)
    return PIPELINE


def decode_image(data: bytes) -> np.ndarray:
    try:
        with Image.open(io.BytesIO(data)) as image:
            return np.asarray(image.convert("RGBA"), dtype=np.uint8)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot decode image: {exc}") from exc


def decode_mask(data: bytes, size: tuple[int, int]) -> np.ndarray:
    try:
        with Image.open(io.BytesIO(data)) as image:
            mask = image.convert("L")
            if mask.size != size:
                raise HTTPException(status_code=400, detail="Mask dimensions must match the input image.")
            return np.asarray(mask, dtype=np.uint8) > 0
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot decode mask: {exc}") from exc


def remove_file(path: str) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


@APP.get("/health")
def health() -> dict:
    import torch

    return {
        "ok": True,
        "provider": "sam-3d-objects",
        "upstream": CURRENT_UPSTREAM,
        "cuda": torch.cuda.is_available(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "vram_gb": round(torch.cuda.get_device_properties(0).total_memory / 1024**3, 1)
        if torch.cuda.is_available()
        else 0,
        "model_loaded": PIPELINE is not None,
    }


@APP.post("/generate")
async def generate(
    image: UploadFile = File(...),
    mask: UploadFile | None = File(default=None),
    seed: int = Form(default=42),
) -> FileResponse:
    rgba = decode_image(await image.read())
    width, height = rgba.shape[1], rgba.shape[0]
    if mask is not None:
        object_mask = decode_mask(await mask.read(), (width, height))
    else:
        object_mask = rgba[..., 3] > 0
        if object_mask.all():
            raise HTTPException(
                status_code=400,
                detail="SAM 3D Objects needs an object mask. Supply a mask or a PNG with transparent background.",
            )

    output = pipeline()(rgba, object_mask, seed=seed)
    glb = output.get("glb")
    if glb is None:
        raise HTTPException(status_code=500, detail="SAM 3D Objects returned no GLB mesh.")

    handle = tempfile.NamedTemporaryFile(prefix="sam3d-", suffix=".glb", delete=False)
    output_path = handle.name
    handle.close()
    glb.export(output_path)
    return FileResponse(
        output_path,
        media_type="model/gltf-binary",
        filename="sam3d.glb",
        background=BackgroundTask(remove_file, output_path),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(APP, host=ARGS.host, port=ARGS.port)
