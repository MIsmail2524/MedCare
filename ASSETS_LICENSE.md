# Third-party assets

## Human anatomy model (`web/public/models/anatomy.glb`)

Derived from **BodyParts3D**, © The Database Center for Life Science (DBCLS), licensed under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
Source: https://dbarchive.biosciencedbc.jp/en/bodyparts3d/ — file `partof_BP3D_4.0_obj_99.zip`.

Changes made: meshes grouped by organ system, re-oriented and scaled to a 1.8-unit y-up body,
welded, simplified (meshoptimizer) and quantized into a single glTF binary by
`tools/build-anatomy.mjs`.

Note: the OBJ file headers of this release reference CC BY-SA 2.1 Japan, while the licensor's current
licence page states CC BY 4.0. To satisfy both, the derived `anatomy.glb` is distributed under
**CC BY-SA 4.0**. This applies only to the model file, not to the MedCare Twin source code.

Attribution as requested by the licensor:
"BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International"

## Drug-safety data (`data/drug-safety.json`, `web/public/data/safety-kb.json`)

- openFDA drug labeling and FAERS (U.S. Food and Drug Administration): public domain (https://open.fda.gov/license/). FAERS reports are unverified spontaneous reports and do not establish causation.
- PubChem (NCBI/NLM) compound properties and structures: public domain.
- Fingerprints computed with RDKit (BSD 3-Clause), bundled as `@rdkit/rdkit`.
