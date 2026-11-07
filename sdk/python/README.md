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

Tests use only `unittest` and run against fakes (a fake CLI runner, an in-memory
transport, and a fake daemon endpoint on a loopback socket); no daemon or device is
needed and the suite takes well under a second.

```bash
cd sdk/python
PYTHONPATH=src python3 -m unittest discover -s tests -t .
```

From the repository root, `bash scripts/validate_python_sdk.sh` runs the same suite;
CI runs it as the `python-sdk` Fast Validation check. Optional local tooling, configured
in `pyproject.toml`: `ruff check`, `ruff format --check` and `mypy` (strict).

The daemon state-path resolver is tested against the shared vectors in
`test/fixtures/daemon-isolation-paths.json`, as every other client port is.
