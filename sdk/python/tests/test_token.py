from __future__ import annotations

import os
import tempfile
import unittest

from auto_mobile.token import FileTokenProvider, UnsafeTokenFileError, read_token_file


@unittest.skipIf(os.name == "nt", "POSIX ownership and mode checks")
class TokenFileTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "daemon.token")

    def tearDown(self) -> None:
        self.dir.cleanup()

    def write(self, text: str, mode: int = 0o600) -> None:
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.chmod(self.path, mode)

    def test_reads_and_trims(self) -> None:
        self.write("  abc123\n")
        self.assertEqual(read_token_file(self.path), "abc123")

    def test_missing_or_blank_is_none(self) -> None:
        self.assertIsNone(read_token_file(self.path))
        self.write("\n")
        self.assertIsNone(read_token_file(self.path))

    def test_refuses_loose_mode(self) -> None:
        self.write("abc", mode=0o644)
        with self.assertRaises(UnsafeTokenFileError):
            read_token_file(self.path)

    def test_refuses_symlink(self) -> None:
        target = os.path.join(self.dir.name, "real")
        with open(target, "w", encoding="utf-8") as handle:
            handle.write("abc")
        os.chmod(target, 0o600)
        os.symlink(target, self.path)
        with self.assertRaises(UnsafeTokenFileError):
            read_token_file(self.path)

    def test_provider_env_override_wins_and_file_is_reread(self) -> None:
        env = {"AUTOMOBILE_DAEMON_TOKEN_FILE_PATH": self.path}
        provider = FileTokenProvider(env)
        self.write("first")
        self.assertEqual(provider.read(), "first")
        self.write("second")
        self.assertEqual(provider.read(), "second")
        override = FileTokenProvider({**env, "AUTOMOBILE_DAEMON_HTTP_TOKEN": " env-token "})
        self.assertEqual(override.read(), "env-token")


if __name__ == "__main__":
    unittest.main()
