# Enlargement bake-off scripts (spec 18, 2026-10-29)

The scripts of the upscaler bake-off that chose the x2 and x4 models of spec 18. They are kept here as they ran, so
the quality run (spec 18 lifecycle plan, step 9) does not depend on a temp folder. Wiring them as the eval's
`--enlargement` mode is step 9's work; nothing in the worker or the tests imports them.

They expect a working drive `Q:` (a `subst` of any empty folder) with:

- `Q:\in\<key>.jpg`, `Q:\in\<key>.matte.png` and `Q:\in\meta.json` (the product box per key): the input photos;
- `Q:\venv` a Python venv with torch, onnx, onnxruntime, numpy and Pillow; `Q:\scripts` a copy of this folder;
- `Q:\w` the weights `fetch.py` downloads (public SwinIR and Real-ESRGAN releases).

| Script | What it does |
| --- | --- |
| `fetch.py` | downloads the model weights and the two architecture files |
| `infer.py` | runs one ONNX upscaler with the service's tiling: the product region (`region`) or the whole photo twice for determinism (`whole`) |
| `driver.py` | per photo: every model, every scale, assembled with `assemble.js`, measured, crop sheets |
| `assemble.js` | the render's colour path (crop, lanczos3, sharpen) with the repo's sharp |
| `canvas.js` | a 3000x3000 canvas from an upscaled region and the matte, encoded down the render's JPEG ladder |
| `convert.py` | converts the candidate checkpoints to fixed-tile ONNX, the service's recipe |
| `colour.py`, `grid.py` | colour drift check and side-by-side grids |
| `batch.ps1`, `batch2.ps1` | the two PowerShell batch runs of the bake-off |

Run the `.js` files from `apps/worker` (so `require("sharp")` finds the repo's build): `node src/catalog-output-evals/bake/assemble.js <job.json>`.
