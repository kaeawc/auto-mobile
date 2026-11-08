from __future__ import annotations

import json
import unittest
from pathlib import Path
from typing import Any

from auto_mobile.paths import StateFile, isolation_suffix, resolve_state_path

# The shared vectors every daemon client port is tested against.
VECTORS = Path(__file__).resolve().parents[3] / "test" / "fixtures" / "daemon-isolation-paths.json"


@unittest.skipUnless(VECTORS.is_file(), "shared path vectors live in the repository checkout")
class SharedVectorTest(unittest.TestCase):
    vectors: dict[str, Any]

    @classmethod
    def setUpClass(cls) -> None:
        cls.vectors = json.loads(VECTORS.read_text(encoding="utf-8"))

    def test_posix_cases(self) -> None:
        uid = self.vectors["uid"]
        fields: dict[StateFile, str] = {
            "sock": "socketPath",
            "pid": "pidFilePath",
            "lock": "lockFilePath",
            "token": "tokenFilePath",
        }
        for case in self.vectors["cases"]:
            env = case["env"]
            with self.subTest(case["name"]):
                self.assertEqual(isolation_suffix(env, "/unused-cwd"), case["suffix"])
                for file, field in fields.items():
                    path = resolve_state_path(
                        file, env, cwd="/unused-cwd", user_id=uid, windows=False
                    )
                    self.assertEqual(path, case[field])

    def test_windows_token_cases(self) -> None:
        for case in self.vectors["windowsCases"]:
            env = case["env"]
            with self.subTest(case["name"]):
                self.assertEqual(isolation_suffix(env, "C:\\unused", windows=True), case["suffix"])
                path = resolve_state_path("token", env, cwd="C:\\unused", windows=True)
                self.assertEqual(path, case["windowsTokenFilePath"])


class FallbackTest(unittest.TestCase):
    def test_relative_override_without_launch_cwd_uses_cwd(self) -> None:
        path = resolve_state_path(
            "token", {"AUTOMOBILE_DAEMON_TOKEN_FILE_PATH": "a/../t.token"}, cwd="/w", windows=False
        )
        self.assertEqual(path, "/w/t.token")

    def test_set_but_blank_override_does_not_fall_through_to_legacy(self) -> None:
        env = {
            "AUTOMOBILE_DAEMON_SOCKET_PATH": " ",
            "AUTO_MOBILE_DAEMON_SOCKET_PATH": "/legacy.sock",
        }
        path = resolve_state_path("sock", env, cwd="/", user_id="7", windows=False)
        self.assertEqual(path, "/tmp/auto-mobile-daemon-7.sock")


if __name__ == "__main__":
    unittest.main()
