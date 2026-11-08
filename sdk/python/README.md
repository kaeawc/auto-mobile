# AutoMobile Python SDK

An async Python client for the AutoMobile daemon. This first slice covers:

- daemon `status` and `ensure_running`;
- a bound MCP session with generic `list_tools`, `call_tool` and `read_resource`.

It has no runtime dependencies beyond the Python standard library (Python 3.10+). It is
not published to PyPI yet; install it from this directory.

```bash
pip install ./sdk/python
```

```python
import asyncio
from auto_mobile import AutoMobile

async def main() -> None:
    client = AutoMobile()                     # runs `auto-mobile --daemon ...`
    status = await client.ensure_running()
    print(status.version, status.port)
    async with client.session() as session:   # one session key for every request
        tools = await session.list_tools()
        result = await session.call_tool("listDevices", {"platform": "android"})
        print(result.raise_for_error().text)

asyncio.run(main())
```

User documentation: [`docs/using/python-sdk.md`](../../docs/using/python-sdk.md).

## Development

The build uses [uv](https://docs.astral.sh/uv/) with the committed `uv.lock`, ruff for
lint and format, and mypy (strict) for types. The pinned tools live in the `dev`
dependency group; the SDK itself still has no runtime dependencies.

```bash
cd sdk/python
uv sync --locked                       # create .venv with the pinned tools
uv run ruff check                      # lint
uv run ruff format --check             # format check (ruff format to rewrite)
uv run mypy                            # typecheck
uv run python -m unittest discover -s tests -t .   # tests
```

From the repository root, `bash scripts/validate_python_sdk.sh [task...]` runs the same
task list (`lint`, `format-check`, `format`, `typecheck`, `test`; `all` by default). CI
runs `all` as the `python-sdk` Fast Validation check.

Tests use only `unittest` and run against fakes (a fake CLI runner, an in-memory
transport, and a fake daemon endpoint on a loopback socket); no daemon or device is
needed and the suite takes well under a second. The daemon state-path resolver is
tested against the shared vectors in `test/fixtures/daemon-isolation-paths.json`, as
every other client port is.

After changing the `dev` group in `pyproject.toml`, run `uv lock` and commit `uv.lock`.
