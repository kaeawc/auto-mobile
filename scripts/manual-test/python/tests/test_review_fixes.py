from __future__ import annotations
import asyncio
import contextlib
import io
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
import characterize_close
from mcp_harness import cli
from mcp_harness.client import Options, run_client
from mcp_harness.evidence import Evidence
from mcp_harness.guard import check_calls
from mcp_harness.launch import LaunchSpec, fake_launch
from mcp_harness.script import load_script, parse_script
from tests.support import ROOT, call, guard_ok, run_fake, tempdir

class ReviewFixTests(unittest.TestCase):
    def test_late_response_retains_real_result(self) -> None:
        with tempdir() as tmp:
            result, records, events = run_fake(Path(tmp), [{**call('slow', seconds=0.6), 'timeoutMs': 150, 'retries': 0}, {'op': 'sleep', 'ms': 800}])
            self.assertEqual(result.exit_code, 1)
            self.assertEqual(len([r for r in records if r['event'] == 'request' and r['index'] == 0]), 1)
            timeout = next(r for r in records if r['event'] == 'exception')
            self.assertTrue(timeout['timedOut'])
            self.assertTrue(timeout['stillPending'])
            late = next(r for r in records if r['event'] == 'late-response')
            self.assertEqual((late['index'], late['attempt']), (0, 1))
            self.assertEqual(late['response']['content'][0]['text'], 'slow done')
            self.assertGreater(late['lateByMs'], 0)
            self.assertEqual(result.json()['lateResponses'], 1)
            self.assertEqual(events[0]['timedOutAttempts'], 1)

    def test_timeout_outcome_survives_immediate_close(self) -> None:
        with tempdir() as tmp:
            result, records, _ = run_fake(Path(tmp), [{**call('slow', seconds=0.6), 'timeoutMs': 150}])
            outcomes = [r for r in records if r['event'] in ('late-response', 'late-exception', 'abandoned')]
            self.assertEqual(len(outcomes), 1)
            self.assertTrue(outcomes[0]['afterClose'])
            self.assertEqual((outcomes[0]['index'], outcomes[0]['attempt']), (0, 1))

    def test_reused_evidence_refused_before_guard_both_clis(self) -> None:
        for two in (False, True):
            for suffix in (('lifetime-001',) if two else ('A.jsonl', 'A.identity.json', 'A.server.stderr.log')):
                with self.subTest(two=two, suffix=suffix), tempdir() as tmp:
                    directory = Path(tmp)
                    existing = directory / suffix
                    existing.mkdir() if two else existing.write_text('previous evidence')
                    script = directory / 'script.json'
                    script.write_text('{"steps":[]}')
                    guard, spawn = Mock(), Mock()
                    with contextlib.redirect_stderr(io.StringIO()) as stderr:
                        code = cli.main(['--fake-server', '--script', str(script), '--out-dir', tmp], is_two=two, runner=guard, run=spawn)
                    self.assertEqual(code, 2)
                    self.assertIn('new evidence directory', stderr.getvalue())
                    guard.assert_not_called()
                    spawn.assert_not_called()

    def test_cancellation_stops_remaining_steps_and_closes(self) -> None:
        with tempdir() as tmp:
            directory = Path(tmp)
            path = directory / 'steps.json'
            path.write_text('{}')
            script = parse_script({'steps': [call('hang', seconds=30), call('echo', text='must not run')]}, {}, path)
            evidence = Evidence(directory, 'A')
            async def execute():
                owner = asyncio.create_task(run_client(fake_launch({}), script, evidence, Options(), lambda _: None))
                while not any(json.loads(l)['event'] == 'request' for l in (directory/'A.jsonl').read_text().splitlines()):
                    await asyncio.sleep(0.01)
                owner.cancel()
                return await owner
            try:
                with contextlib.redirect_stderr(io.StringIO()):
                    result = asyncio.run(execute())
            finally:
                evidence.close()
            records = [json.loads(l) for l in (directory/'A.jsonl').read_text().splitlines()]
            self.assertFalse(any(r['event'] == 'request' and r['index'] == 1 for r in records))
            self.assertTrue(any(r['event'] == 'close' for r in records))
            self.assertEqual(len([r for r in records if r.get('phase') == 'application']), 1)
            self.assertEqual(result.exit_code, 1)

    def test_reaper_verifies_fake_command_before_signalling(self) -> None:
        fake = str(ROOT/'scripts/manual-test/python/fake_mcp_server.py')
        for command, code, should_signal in ((f'python {fake}', 0, True), ('unrelated service', 0, False), ('', 0, False), (f'python {fake}', 1, False)):
            with self.subTest(command=command, code=code), tempdir() as tmp:
                (Path(tmp)/'A.jsonl').write_text('{"event":"spawn","pid":1234}\n')
                runner = Mock(return_value=subprocess.CompletedProcess([], code, command, ''))
                with patch('characterize_close.subprocess.run', runner), patch('characterize_close.os.kill') as kill:
                    characterize_close.reap_recorded_children(Path(tmp))
                self.assertEqual(kill.called, should_signal)
                runner.assert_called_once_with(['ps', '-p', '1234', '-o', 'command='], capture_output=True, text=True, timeout=2)

    def test_shipped_scripts_bind_device_and_dry_run(self) -> None:
        for name in ('observe-then-close', 'sendkeys-multiline'):
            path = ROOT/f'scripts/manual-test/python/scripts/{name}.json'
            script = load_script(path, {'platform': 'android', 'deviceId': 'fake-id'})
            self.assertEqual(script.steps[0], call('startDevice', platform='android', deviceId='fake-id'))
            runner = Mock(return_value=subprocess.CompletedProcess([], 0, '{"ok":true}', ''))
            check_calls([script], False, runner)
            document = json.loads(runner.call_args.kwargs['input'])
            self.assertEqual(document['calls'][0], {'tool': 'startDevice', 'arguments': {'platform': 'android', 'deviceId': 'fake-id'}})
            self.assertTrue(all(not ({'device', 'deviceId'} & set(c['arguments'])) for c in document['calls'][1:]))
            with tempdir() as tmp:
                result, _, _ = run_fake(Path(tmp), script.steps + script.after_peer_closed)
                self.assertEqual(result.exit_code, 0, result.json())

    def test_independent_initialize_timeout_flag(self) -> None:
        self.assertEqual(Options().init_timeout_ms, 60000)
        for two in (False, True):
            args = cli.parser(two).parse_args(['--fake-server', '--script', 's', '--out-dir', '/evidence', '--init-timeout-ms', '21000', '--step-timeout-ms', '150'])
            self.assertEqual(cli.options(args, 'normal').init_timeout_ms, 21000)
            self.assertEqual(cli.options(args, 'normal').step_timeout_ms, 150)
        with tempdir() as tmp:
            result, _, _ = run_fake(Path(tmp), [], options=Options(step_timeout_ms=1))
            self.assertEqual(result.exit_code, 0)

    def test_spawn_failure_and_initialize_request_have_evidence(self) -> None:
        with tempdir() as tmp:
            _, records, _ = run_fake(Path(tmp), [call('echo', text='ok')])
            kinds = [r['event'] for r in records]
            self.assertLess(kinds.index('spawn-request'), kinds.index('spawn'))
            self.assertLess(kinds.index('initialize-request'), kinds.index('initialize'))
        with tempdir() as tmp:
            directory = Path(tmp)
            path = directory/'script.json'
            path.write_text('{"steps":[]}')
            evidence = Evidence(directory, 'A')
            try:
                with patch('mcp_harness.client.Capture.enter', side_effect=OSError('injected spawn failure')), contextlib.redirect_stderr(io.StringIO()):
                    result = asyncio.run(run_client(fake_launch({}), load_script(path, {}), evidence, Options(), lambda _: None))
            finally:
                evidence.close()
            records = [json.loads(l) for l in (directory/'A.jsonl').read_text().splitlines()]
            self.assertEqual(result.exit_code, 1)
            self.assertEqual(records[0]['event'], 'spawn-request')
            self.assertEqual(next(r for r in records if r['event'] == 'exception')['phase'], 'spawn')

    def test_pair_early_stderr_failure_releases_peer(self) -> None:
        with tempdir() as tmp:
            directory = Path(tmp)
            path = directory/'script.json'
            path.write_text(json.dumps({'steps': [call('echo', text='peer')]}))
            args = cli.parser(True).parse_args(['--fake-server', '--script', str(path), '--out-dir', tmp])
            launch, scripts = cli.prepare(args, True, guard_ok)
            original = Evidence.open_private
            def fail_a_stderr(path, append=True):
                if path.name == 'A.server.stderr.log':
                    raise OSError('injected stderr open failure')
                return original(path, append)
            async def execute():
                return await asyncio.wait_for(cli.two(args, launch, scripts), 25)
            with patch.object(Evidence, 'open_private', side_effect=fail_a_stderr), contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(asyncio.run(execute()), 1)
            rows = json.loads(stdout.getvalue().splitlines()[-1])['clients']
            self.assertEqual(rows[0]['exitCode'], 1)
            self.assertEqual(rows[1]['close']['status'], 'CLOSE_OK')
            records = [json.loads(l) for l in (directory/'lifetime-001/B.jsonl').read_text().splitlines()]
            self.assertTrue(any('peer' in r.get('exception', {}).get('message', '').lower() for r in records))

    def test_message_handler_keeps_transport_errors_and_server_requests(self) -> None:
        from types import SimpleNamespace
        class Payload:
            def __init__(self, value): self.value = value
            def model_dump(self, **kwargs): return self.value
        class Session:
            def __init__(self, *streams, message_handler=None): self.handler = message_handler
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
            async def initialize(self):
                await self.handler(ValueError('transport parse failure'))
                await self.handler(SimpleNamespace(request=SimpleNamespace(root=Payload({'method': 'sampling/createMessage', 'params': {'messages': []}}))))
                await self.handler(SimpleNamespace(root=Payload({'method': 'notifications/tools/list_changed'})))
                return Payload({'protocolVersion': 'fake'})
        class Transport:
            async def __aenter__(self): return (None, None)
            async def __aexit__(self, *args): return None
        with tempdir() as tmp:
            path = Path(tmp)/'script.json'
            path.write_text('{"steps":[]}')
            evidence = Evidence(Path(tmp), 'A')
            async def enter(capture, transport): return await transport.__aenter__()
            try:
                with patch('mcp_harness.client.ClientSession', Session), patch('mcp_harness.client.stdio_client', return_value=Transport()), patch('mcp_harness.client.Capture.enter', enter):
                    result = asyncio.run(run_client(fake_launch({}), load_script(path, {}), evidence, Options(), lambda _: None))
            finally:
                evidence.close()
            records = [json.loads(l) for l in (Path(tmp)/'A.jsonl').read_text().splitlines()]
            self.assertEqual(result.exit_code, 0)
            error = next(r for r in records if r['event'] == 'transport-exception')
            self.assertEqual(error['exception']['class'], 'builtins.ValueError')
            request = next(r for r in records if r['event'] == 'server-request')
            self.assertEqual(request['method'], 'sampling/createMessage')
            self.assertEqual(request['params'], {'messages': []})
            self.assertEqual(len([r for r in records if r['event'] == 'notification']), 1)

    def test_abandoned_request_is_cancelled_and_counted(self) -> None:
        from mcp_harness.client import Requests, Summary
        with tempdir() as tmp:
            evidence = Evidence(Path(tmp), 'A')
            summary = Summary('A')
            async def execute():
                requests = Requests(evidence, summary)
                task = asyncio.create_task(asyncio.sleep(60))
                requests.add(task, 4, 2, 10, False)
                requests.closing()
                await requests.drain()
                self.assertTrue(task.cancelled())
            try:
                asyncio.run(execute())
            finally:
                evidence.close()
            records = [json.loads(l) for l in (Path(tmp)/'A.jsonl').read_text().splitlines()]
            self.assertEqual([r['event'] for r in records], ['abandoned'])
            self.assertEqual((records[0]['index'], records[0]['attempt']), (4, 2))
            self.assertEqual(summary.json()['abandonedRequests'], 1)

    def test_all_control_exceptions_are_persisted_and_reraised(self) -> None:
        from mcp_harness.client import Summary, run_step
        for cls in (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
            with self.subTest(cls=cls), tempdir() as tmp:
                evidence = Evidence(Path(tmp), 'A')
                async def execute():
                    future = asyncio.get_running_loop().create_future()
                    future.set_exception(cls('control exception'))
                    def created(coroutine):
                        coroutine.close()
                        return future
                    with patch('mcp_harness.client.asyncio.create_task', created):
                        with self.assertRaises(cls):
                            await run_step(None, call('echo', text='x'), 0, evidence, Options(), Summary('A'), lambda _: None)
                try:
                    asyncio.run(execute())
                finally:
                    evidence.close()
                records = [json.loads(l) for l in (Path(tmp)/'A.jsonl').read_text().splitlines()]
                self.assertEqual([r['event'] for r in records], ['request', 'exception'])
