# Third-party notices

Mindlog contains no source code copied from other projects. The reference projects it studied are listed in `docs/PLAN.md` §28; they were read for design only, never copied (CLAUDE.md §7).

Third-party dependencies are installed from npm and PyPI under their own licenses and are not redistributed in this repository. Their full list with licenses is in the release SBOMs (`scripts/sbom.sh`: CycloneDX for the Node and Python workspaces).

The model service downloads pretrained models at build time (`python/model_service/scripts/download_models.py`). Each is under the license on its Hugging Face model card:
- `sentence-transformers/all-MiniLM-L6-v2`;
- `cross-encoder/ms-marco-MiniLM-L6-v2`;
- `cross-encoder/nli-deberta-v3-xsmall`;
- `onnx-community/gliner_small-v2.1`.

Container images that bake the models in carry the models under those licenses.

The documentation diagrams embed **Excalifont** (`docs/diagrams/excalifont-latin.woff2`, also inlined in the SVGs under `docs/.gitbook/assets/`), the hand-drawn font of the Excalidraw project, © Excalidraw contributors, licensed under the SIL Open Font License 1.1 (https://openfontlicense.org). Only its Latin subset is included.
