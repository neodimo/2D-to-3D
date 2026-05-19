# Release Gate

This app is gated as a product, not just built after patches.

Before any public release, the last person or agent to push/build owns the QA pass:

- pull the latest main
- run npm run gate:release:prebuild
- build the installer
- run npm run gate:release:postbuild
- publish only if both gates pass

## Blocking Regression Checklist

The gate starts with the failures that broke recent releases:

- version badge is visible beside the app title
- full runtime log stays hidden; no visible full-log rail in the app
- major panels expose minimize/restore controls
- Generate and Preview have a draggable resize bar
- SHARP input/output controls are present
- PLY viewer has separate Babylon and 2D fallback canvases
- PLY fallback becomes visible when Babylon/WebGL fails
- Babylon scene handling tolerates both scene.getMeshes() and scene.meshes
- updater uses silent install, not installer UI relaunch
- CI does not publish a release until QA and artifact checks pass
- release artifacts include installer, blockmap, and latest.yml

## Tracked Preview Viewer Follow-up

PLY preview now prefers the official PlayCanvas SuperSplat viewer path, with Babylon/2D preview kept as fallback. Treat regressions in SuperSplat loading, fallback loading, or viewport responsiveness as release blockers.

## Ownership

- App-side tests and renderer/Electron regression guards: Gonzo
- Release checklist, gate policy, and coverage review: Bert
- Final release responsibility: whoever last updates/pushes/builds

## Current Commands

- npm run qa: smoke + app regression checks
- npm run gate:release:prebuild: version/tag sanity + npm run qa
- npm run gate:release:postbuild: verifies built Windows installer artifacts and updater metadata

If a regression is intentionally accepted, it must be written into the release notes before publishing.
