# Python worker tests

CI runs the Node test suite and only one Python suite, the shared
`cascadia-workers-commons` package. The [Testing](./testing.md) guide covers
the CAD converter's suite, run locally in its conda environment; the two
workers that serve the design engine's CAD generation are run the same way,
and this page is their half of that note.

The `cascadia-workers-cad-generator` and `cascadia-workers-freecad-runner`
suites are **run locally only**. They import `cadquery` and FreeCAD, which are
conda-only, so each needs its own environment, created from its
`environment.yml` the way the converter's is:

```bash
conda env create -f cascadia-workers-cad-generator/environment.yml
conda run -n cad-generator pytest cascadia-workers-cad-generator
```

State the run and its result in the pull request body when you change either
of them; CI does not cover them.

One file in each is an exception. `tests/test_worker_claim.py` covers how
`_run_job` settles a RabbitMQ delivery and touches no geometry, so it stubs
whichever heavy package is genuinely absent and runs under a plain
`pip install pytest pydantic pydantic-settings`, with that worker's `src` and
`cascadia-workers-commons/src` on `PYTHONPATH`. An installed package always
beats the stub, so the file behaves identically inside the conda environment.

The FreeCAD runner goes further: its whole suite runs without FreeCAD.
`test_runner.py` drives the real child-process harness against a fake `FreeCAD`
module (`tests/fake_freecad/`) through `FREECAD_LIB_DIR`, because what it pins —
the scrubbed environment, the deadline kill, the `result` contract — is
everything around the kernel rather than the kernel. Its `pyproject.toml` puts
`src` and `../cascadia-workers-commons/src` on the path, so
`pytest cascadia-workers-freecad-runner` is the whole invocation. Only the
Docker build exercises the real FreeCAD, and it fails if
`import FreeCAD, Part` does not succeed in the finished image.
