"""Offline regression tests; node changes are confined to temporary directories."""

import copy
from pathlib import Path
import struct
import tempfile
import tomllib
import unittest
from unittest.mock import patch

import gvisor as gv


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='xsphere-runtime-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.runsc = self.root / 'runsc'
        self.shim = self.root / 'shim'
        for file in (self.runsc, self.shim):
            header = bytearray(20)
            header[:6] = b'\x7fELF\x02\x01'
            struct.pack_into('<H', header, 18, 62)
            file.write_bytes(header + file.name.encode())
        lock, source_patch = gv.locked()
        self.lock = copy.deepcopy(lock)
        self.lock['sha256']['linux/amd64'] = {
            'runsc': gv.sha(self.runsc), gv.BINARIES[1]: gv.sha(self.shim)}
        for replacement in (
            patch.object(gv, 'PREFIX', self.root / 'installed'),
            patch.object(gv, 'locked', return_value=(self.lock, source_patch)),
        ):
            replacement.start()
            self.addCleanup(replacement.stop)
        self.bundle = self.root / 'bundle'
        gv.bundle('amd64', self.runsc, self.shim, self.bundle)
        self.config = self.root / 'config.toml'
        self.config.write_text(
            'version = 2\n# Preserve operator comments.\n'
            '[plugins."io.containerd.grpc.v1.cri".containerd]\n'
            'default_runtime_name = "runc"\n'
            '[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]\n'
            'runtime_type = "io.containerd.runc.v2"\n')
        self.plan = self.root / 'plan'

    def make_plan(self):
        gv.plan(self.bundle, self.config, self.plan, 'test-node')

    def install(self):
        self.make_plan()
        with patch.object(gv, 'run', return_value=(self.plan / 'candidate.toml').read_text()) as run:
            gv.install_node(self.plan)
        self.assertEqual(run.call_args.args[0], 'containerd')
        self.assertNotIn('restart', run.call_args.args)

    def test_bundle_is_verified_and_immutable(self):
        manifest = gv.verify_bundle(self.bundle)
        self.assertEqual(manifest['architecture'], 'amd64')
        self.assertEqual(self.bundle.stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.bundle / 'runsc').stat().st_mode & 0o777, 0o555)
        with self.assertRaisesRegex(ValueError, 'immutable'):
            gv.bundle('amd64', self.runsc, self.shim, self.bundle)

    def test_recorded_binary_checksum_must_match(self):
        self.shim.write_bytes(self.shim.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'not the recorded'):
            gv.bundle('amd64', self.runsc, self.shim, self.root / 'other')

    def test_wrong_architecture_is_rejected_before_output(self):
        with self.assertRaisesRegex(ValueError, 'wrong CPU architecture'):
            gv.bundle('arm64', self.runsc, self.shim, self.root / 'other')
        self.assertFalse((self.root / 'other').exists())

    def test_download_uses_exact_release_and_validates_before_publish(self):
        output = self.root / 'downloaded-runsc'

        def download(*args):
            Path(args[args.index('--output') + 1]).write_bytes(self.runsc.read_bytes())
            self.assertTrue(args[-1].endswith('/20260817.0/x86_64/runsc'))

        with patch.object(gv, 'run', side_effect=download):
            gv.fetch_runsc('amd64', output)
        self.assertEqual(gv.sha(output), gv.sha(self.runsc))
        with self.assertRaisesRegex(ValueError, 'overwrite'):
            gv.fetch_runsc('amd64', output)

    def test_bad_download_never_publishes_binary(self):
        output = self.root / 'downloaded-runsc'
        with patch.object(gv, 'run'):
            with self.assertRaisesRegex(ValueError, 'checksum'):
                gv.fetch_runsc('amd64', output)
        self.assertFalse(output.exists())

    def test_runtime_class_hostname_must_fit_label_value(self):
        with self.assertRaisesRegex(ValueError, '63 characters'):
            gv.runtime_class('a' * 64)

    def test_tampered_bundle_and_symlink_are_rejected(self):
        binary = self.bundle / 'runsc'
        binary.chmod(0o600)
        binary.write_bytes(binary.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            gv.verify_bundle(self.bundle)
        binary.unlink()
        binary.symlink_to(self.runsc)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            gv.verify_bundle(self.bundle)

    def test_manifest_cannot_reference_outside_files(self):
        manifest = gv.read_json(self.bundle / 'manifest.json')
        manifest['files']['../outside'] = 'bad'
        gv.write_json(self.bundle / 'manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'file list'):
            gv.verify_bundle(self.bundle)

    def test_v2_and_v3_candidates_only_add_new_handler(self):
        for version, plugin in gv.PLUGINS.items():
            before = self.config.read_text().replace('version = 2', f'version = {version}').replace(
                gv.PLUGINS[2], plugin)
            result = gv.candidate(before, 'test-version')
            parsed = tomllib.loads(result)
            added = parsed['plugins'][plugin]['containerd']['runtimes'].pop(gv.HANDLER)
            self.assertEqual(parsed, tomllib.loads(before))
            self.assertIn('# Preserve operator comments.', result)
            self.assertEqual(added['pod_annotations'], ['dev.gvisor.internal.*'])
            self.assertEqual(added['runtime_type'], 'io.containerd.runsc.v1')

    def test_imports_unsupported_version_and_existing_handler_fail_closed(self):
        for config in ('version = 2\nimports = ["extra.toml"]', 'version = 1',
                       gv.candidate(self.config.read_text(), 'existing')):
            with self.assertRaises(ValueError):
                gv.candidate(config, 'new')

    def test_plan_is_non_mutating_and_protects_backup(self):
        before = self.config.read_bytes()
        self.make_plan()
        self.assertEqual(before, self.config.read_bytes())
        self.assertFalse(gv.PREFIX.exists())
        self.assertEqual((self.plan / 'before.toml').stat().st_mode & 0o777, 0o600)
        resource = gv.read_json(self.plan / 'runtimeclass.json')
        self.assertEqual(resource['scheduling']['nodeSelector'], {'kubernetes.io/hostname': 'test-node'})

    def test_install_and_rollback_preserve_original_and_binaries(self):
        before = self.config.read_bytes()
        self.install()
        self.assertNotEqual(before, self.config.read_bytes())
        destination = gv.PREFIX / gv.verify_bundle(self.bundle)['id']
        self.assertTrue((destination / 'runsc').exists())
        gv.rollback_node(self.plan)
        gv.rollback_node(self.plan)
        self.assertEqual(before, self.config.read_bytes())
        self.assertTrue(destination.exists())

    def test_install_refuses_stale_plan(self):
        self.make_plan()
        self.config.write_text(self.config.read_text() + '\n# later operator edit\n')
        with self.assertRaisesRegex(ValueError, 'changed since planning'):
            gv.install_node(self.plan)
        self.assertFalse(gv.PREFIX.exists())

    def test_rollback_preserves_later_operator_edits(self):
        self.install()
        content = self.config.read_text() + '\n# later operator edit\n'
        self.config.write_text(content)
        with self.assertRaisesRegex(ValueError, 'later edits'):
            gv.rollback_node(self.plan)
        self.assertEqual(self.config.read_text(), content)

    def test_containerd_validation_failure_does_not_replace_config(self):
        self.make_plan()
        before = self.config.read_bytes()
        with patch.object(gv, 'run', side_effect=OSError('invalid containerd config')):
            with self.assertRaises(OSError):
                gv.install_node(self.plan)
        self.assertEqual(self.config.read_bytes(), before)

    def test_effective_handler_mismatch_does_not_replace_config(self):
        self.make_plan()
        before = self.config.read_bytes()
        effective = (self.plan / 'candidate.toml').read_text().replace('io.containerd.runsc.v1', 'wrong')
        with patch.object(gv, 'run', return_value=effective):
            with self.assertRaisesRegex(ValueError, 'effective config'):
                gv.install_node(self.plan)
        self.assertEqual(self.config.read_bytes(), before)

    def test_changed_candidate_cannot_modify_unrelated_settings(self):
        self.make_plan()
        target = self.plan / 'candidate.toml'
        target.write_text(target.read_text().replace('default_runtime_name = "runc"',
                                                   'default_runtime_name = "other"'))
        record = gv.read_json(self.plan / 'plan.json')
        record['afterSha256'] = gv.sha(target)
        gv.write_json(self.plan / 'plan.json', record)
        with self.assertRaisesRegex(ValueError, 'expected additive'):
            gv.install_node(self.plan)

    def test_kind_render_is_isolated_and_has_no_ports_or_other_mounts(self):
        checkpoints = self.root / 'checkpoints'
        checkpoints.mkdir()
        config = gv.kind_config(self.bundle, checkpoints, 'xsphere-test', 'kindest/node:test', 2)
        self.assertEqual(config['name'], 'xsphere-test')
        mounts = config['nodes'][0]['extraMounts']
        self.assertEqual(len(mounts), 2)
        self.assertTrue(mounts[0]['readOnly'])
        self.assertNotIn('extraPortMappings', config['nodes'][0])
        self.assertNotIn('kubeadmConfigPatches', config['nodes'][0])
        self.assertIn(gv.HANDLER, config['containerdConfigPatches'][0])

    def test_build_requires_linux_amd64_host(self):
        with patch.object(gv.platform, 'system', return_value='Darwin'):
            with self.assertRaisesRegex(ValueError, 'Linux/amd64'):
                gv.build(self.root, 'amd64', self.runsc, self.root / 'out', 4)

    def test_prepare_fetches_exact_commit_and_applies_local_patch(self):
        workdir = self.root / 'source'

        def output(*args, **_kwargs):
            if args[:3] == ('git', 'rev-parse', 'HEAD'):
                return self.lock['baseCommit'] + '\n'
            return 'source-diff' if args[:3] == ('git', 'diff', '--binary') else ''

        with patch.object(gv, 'run', side_effect=output) as run:
            gv.prepare(workdir, None)
            gv.check_source(workdir)
        commands = [call.args for call in run.call_args_list]
        self.assertIn(('git', 'fetch', '--depth=1', self.lock['repository'], self.lock['baseCommit']), commands)
        self.assertTrue(any(command[:3] == ('git', 'apply', '--check') for command in commands))
        with self.assertRaisesRegex(ValueError, 'already exists'):
            gv.prepare(workdir, None)

    def test_changed_source_is_rejected(self):
        gv.write_json(self.root / 'source.json', {
            'baseCommit': self.lock['baseCommit'], 'patchSha256': self.lock['patchSha256'],
            'diffSha256': 'wrong',
        })
        with patch.object(gv, 'run', side_effect=[self.lock['baseCommit'], 'different diff']):
            with self.assertRaisesRegex(ValueError, 'changed after preparation'):
                gv.check_source(self.root)


if __name__ == '__main__':
    unittest.main()
