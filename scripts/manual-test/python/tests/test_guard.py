from __future__ import annotations
import contextlib
import io
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import Mock
from mcp_harness.cli import main
from mcp_harness.guard import HERE, REPO, GuardRefusal, check_calls, resolve_launch
from mcp_harness.script import parse_script
from tests.support import tempdir

class GuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scripts = [parse_script({"steps": [{"op": "call", "tool": "echo", "arguments": {"text": "x"}}],
            "afterPeerClosed": [{"op": "call", "tool": "startDevice", "arguments": {"deviceId": "serial"}}]}, {})]
        self.launch = {"command": "/bun", "args": ["/built/index.js"], "env": {"MT_SERVER": "/built/index.js"},
                       "daemon": {"name": "P1", "port": "3333", "socketPath": "/private/d.sock", "pidFilePath": "/private/d.pid"}}

    def test_exact_argv_and_every_call(self) -> None:
        runner = Mock(return_value=subprocess.CompletedProcess([], 0, json.dumps(self.launch), ""))
        launch = resolve_launch("/batch", "1", self.scripts, True, runner)
        self.assertEqual(launch.env, self.launch["env"])
        self.assertEqual(runner.call_args.args[0], ["bash", str(REPO / "scripts/manual-test/in-daemon-env.sh"),
            "--batch-dir", "/batch", "--daemon", "1", "--", "bun", str(HERE / "harness-guard.ts"), "resolve"])
        self.assertEqual(json.loads(runner.call_args.kwargs["input"]), {"calls": self.scripts[0].calls(), "allowSelector": True})
        runner.return_value.stdout = '{"ok":true}'
        check_calls(self.scripts, False, runner)
        self.assertEqual(runner.call_args.args[0], ["bun", str(HERE / "harness-guard.ts"), "check-calls"])

    def test_refusals_never_invoke_spawn_seam(self) -> None:
        responses = [subprocess.CompletedProcess([], 2, "", "refused"),
                     subprocess.TimeoutExpired("guard", 20), subprocess.CompletedProcess([], 0, "no JSON", "")]
        for key in ("command", "args", "env", "daemon"):
            value = dict(self.launch)
            del value[key]
            responses.append(subprocess.CompletedProcess([], 0, json.dumps(value), ""))
        for value in ({**self.launch, "env": {"secret": 123}}, {**self.launch, "args": []},
                      {**self.launch, "daemon": {}}, {**self.launch, "command": ""}):
            responses.append(subprocess.CompletedProcess([], 0, json.dumps(value), ""))
        with tempdir() as tmp:
            path = Path(tmp) / "script.json"
            path.write_text('{"steps":[]}')
            for response in responses:
                runner = Mock(side_effect=response) if isinstance(response, BaseException) else Mock(return_value=response)
                spawn = Mock()
                with self.subTest(response=response), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(main(["--batch-dir", "/batch", "--daemon", "1", "--script", str(path),
                                           "--out-dir", str(Path(tmp)/"output")], runner=runner, run=spawn), 2)
                spawn.assert_not_called()
                self.assertFalse((Path(tmp)/"output").exists())
                with self.assertRaises(GuardRefusal):
                    resolve_launch("/batch", "1", self.scripts, False, runner)
