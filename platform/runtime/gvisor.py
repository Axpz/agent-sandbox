#!/usr/bin/env python3
"""Pinned gVisor source, bundles and opt-in node configuration. Python 3.11+."""

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import struct
import subprocess
import tempfile
import tomllib


HERE = Path(__file__).resolve().parent
PREFIX = Path('/opt/xsphere/gvisor')
HANDLER = 'runsc-xsphere'
RUNTIME_CLASS = 'gvisor-xsphere'
BINARIES = ('runsc', 'containerd-shim-runsc-v1')
PLUGINS = {2: 'io.containerd.grpc.v1.cri', 3: 'io.containerd.cri.v1.runtime'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def run(*args, cwd=None, capture=False):
    return subprocess.run(args, cwd=cwd, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def locked():
    lock = read_json(HERE / 'gvisor.lock.json')['historicalPodTestedBuild']
    patch = (HERE / lock['patchPath']).resolve()
    require(sha(patch) == lock['patchSha256'], 'gVisor patch does not match the lock')
    return lock, patch


def elf_arch(path):
    with path.open('rb') as stream:
        header = stream.read(20)
    require(len(header) == 20 and header[:6] == b'\x7fELF\x02\x01',
            f'{path.name}: expected a little-endian Linux ELF64 binary')
    machine = struct.unpack_from('<H', header, 18)[0]
    require(machine in (62, 183), f'{path.name}: unsupported ELF architecture')
    return {62: 'amd64', 183: 'arm64'}[machine]


def fetch_runsc(arch, output):
    lock, _ = locked()
    require(not output.exists(), 'download output already exists; refusing to overwrite it')
    release = lock['tag'].removeprefix('release-')
    require(re.fullmatch(r'\d{8}\.\d+', release), 'invalid locked release tag')
    machine = {'amd64': 'x86_64', 'arm64': 'aarch64'}[arch]
    url = f'https://storage.googleapis.com/gvisor/releases/release/{release}/{machine}/runsc'
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as stream:
        temporary = Path(stream.name)
    try:
        run('curl', '--fail', '--location', '--connect-timeout', '15', '--max-time', '120',
            '--output', str(temporary), url)
        require(sha(temporary) == lock['sha256'][f'linux/{arch}']['runsc'], 'download checksum mismatch')
        require(elf_arch(temporary) == arch, 'download architecture mismatch')
        temporary.chmod(0o555)
        os.link(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    print(f'Downloaded and verified official runsc: {output}')


def prepare(workdir, source):
    lock, patch = locked()
    require(not workdir.exists(), f'{workdir} already exists; choose a fresh build directory')
    workdir.mkdir(parents=True, mode=0o700)
    checkout = workdir / 'src'
    run('git', 'init', str(checkout))
    run('git', 'fetch', '--depth=1', source or lock['repository'], lock['baseCommit'], cwd=checkout)
    run('git', 'checkout', '--detach', 'FETCH_HEAD', cwd=checkout)
    require(run('git', 'rev-parse', 'HEAD', cwd=checkout, capture=True).strip() == lock['baseCommit'],
            'fetched source does not match pinned commit')
    run('git', 'apply', '--check', str(patch), cwd=checkout)
    run('git', 'apply', str(patch), cwd=checkout)
    run('git', 'diff', '--check', cwd=checkout)
    diff = run('git', 'diff', '--binary', cwd=checkout, capture=True)
    write_json(workdir / 'source.json', {
        'baseCommit': lock['baseCommit'], 'patchSha256': lock['patchSha256'],
        'diffSha256': hashlib.sha256(diff.encode()).hexdigest(),
    })
    print(f'Prepared pinned source: {checkout}')


def check_source(workdir):
    lock, _ = locked()
    record = read_json(workdir / 'source.json')
    checkout = workdir / 'src'
    require(run('git', 'rev-parse', 'HEAD', cwd=checkout, capture=True).strip() == lock['baseCommit'],
            'source HEAD changed after preparation')
    diff = run('git', 'diff', '--binary', cwd=checkout, capture=True)
    require(record == {
        'baseCommit': lock['baseCommit'], 'patchSha256': lock['patchSha256'],
        'diffSha256': hashlib.sha256(diff.encode()).hexdigest(),
    }, 'source or lock changed after preparation; prepare a new directory')
    require(not run('git', 'ls-files', '--others', '--exclude-standard', cwd=checkout,
                    capture=True).strip(), 'unexpected untracked source files')
    require(not run('git', 'diff', '--cached', '--name-only', cwd=checkout, capture=True).strip(),
            'unexpected staged source changes')
    return checkout


def bundle(arch, runsc, shim, output, built=False):
    lock, _ = locked()
    require(not output.exists(), f'{output} already exists; bundles are immutable')
    for binary in (runsc, shim):
        require(elf_arch(binary) == arch, f'{binary.name}: wrong CPU architecture')
    expected = lock['sha256'][f'linux/{arch}']
    require(sha(runsc) == expected['runsc'], 'runsc is not the locked official release')
    if not built:
        require(sha(shim) == expected[BINARIES[1]], 'shim is not the recorded tested binary')
    identity = f"{lock['tag']}-{arch}-{sha(shim)[:12]}"
    node_path = PREFIX / identity
    output.mkdir(parents=True, mode=0o755)
    output.chmod(0o755)
    for name, source in zip(BINARIES, (runsc, shim)):
        shutil.copyfile(source, output / name)
        (output / name).chmod(0o555)
    (output / 'runsc.toml').write_text(
        f'binary_name = {json.dumps(str(node_path / "runsc"))}\n'
        '[runsc_config]\nplatform = "systrap"\n')
    (output / 'runsc.toml').chmod(0o444)
    write_json(output / 'manifest.json', {
        'schemaVersion': 1, 'id': identity, 'architecture': arch,
        'baseCommit': lock['baseCommit'], 'patchSha256': lock['patchSha256'],
        'origin': 'rebuilt; Pod E2E required' if built else 'recorded Pod-tested binaries',
        'files': {name: sha(output / name) for name in (*BINARIES, 'runsc.toml')},
    })
    print(f'Verified runtime bundle: {output}')


def build(workdir, arch, runsc, output, jobs):
    require(platform.system() == 'Linux' and platform.machine() == 'x86_64',
            'build on Linux/amd64; ARM64 output uses the documented cross-toolchain')
    checkout = check_source(workdir)
    lock, _ = locked()
    require(run('bazel', '--version', capture=True).strip() == f"bazel {lock['bazelVersion']}",
            f"Bazel {lock['bazelVersion']} is required")
    require(elf_arch(runsc) == arch and sha(runsc) == lock['sha256'][f'linux/{arch}']['runsc'],
            'provide the matching official runsc before building')
    options = f'-c opt --jobs={jobs} --local_resources=memory=8192'
    run('make', 'DOCKER_BUILD=false', 'test',
        'TARGETS=//pkg/shim/v1/runsc:runsc_test //pkg/shim/v1/proc:proc_test',
        f'OPTIONS={options}', cwd=checkout)
    if arch == 'arm64':
        options = '--config=aarch64 ' + options
    exported = workdir / f'export-{arch}'
    exported.mkdir(exist_ok=False)
    run('make', 'DOCKER_BUILD=false', 'copy', 'TARGETS=//shim:containerd-shim-runsc-v1',
        f'OPTIONS={options}', f'DESTINATION={exported}', cwd=checkout)
    check_source(workdir)
    bundle(arch, runsc, exported / BINARIES[1], output, built=True)


def verify_bundle(directory):
    lock, _ = locked()
    manifest = read_json(directory / 'manifest.json')
    arch = manifest['architecture']
    require(arch in ('amd64', 'arm64'), 'unsupported bundle architecture')
    require(manifest['baseCommit'] == lock['baseCommit'] and
            manifest['patchSha256'] == lock['patchSha256'], 'bundle source does not match lock')
    require(set(manifest['files']) == {*BINARIES, 'runsc.toml'}, 'unexpected bundle file list')
    for name, digest in manifest['files'].items():
        require(not (directory / name).is_symlink(), f'bundle symlink not allowed: {name}')
        require(sha(directory / name) == digest, f'bundle checksum mismatch: {name}')
    for name in BINARIES:
        require(elf_arch(directory / name) == arch, f'wrong architecture: {name}')
    require(manifest['files']['runsc'] == lock['sha256'][f'linux/{arch}']['runsc'],
            'runsc is not the locked release')
    identity = f"{lock['tag']}-{arch}-{manifest['files'][BINARIES[1]][:12]}"
    require(manifest['id'] == identity, 'invalid bundle identity')
    config = tomllib.loads((directory / 'runsc.toml').read_text())
    require(config == {'binary_name': str(PREFIX / identity / 'runsc'),
                       'runsc_config': {'platform': 'systrap'}}, 'unexpected shim configuration')
    return manifest


def fragment(version, identity):
    require(version in PLUGINS, 'only containerd config versions 2 and 3 are supported')
    section = f'plugins.{json.dumps(PLUGINS[version])}.containerd.runtimes.{HANDLER}'
    node_path = PREFIX / identity
    return (f'\n[{section}]\nruntime_type = "io.containerd.runsc.v1"\n'
            f'runtime_path = {json.dumps(str(node_path / BINARIES[1]))}\n'
            'pod_annotations = ["dev.gvisor.internal.*"]\n'
            f'[{section}.options]\nTypeUrl = "io.containerd.runsc.v1.options"\n'
            f'ConfigPath = {json.dumps(str(node_path / "runsc.toml"))}\n')


def candidate(original, identity):
    parsed = tomllib.loads(original)
    version = parsed.get('version')
    require(version in PLUGINS, 'explicit containerd version 2 or 3 is required')
    require(not parsed.get('imports'),
            'imported configs require manual effective-config review; automatic edit refused')
    expected = copy.deepcopy(parsed)
    runtimes = expected.setdefault('plugins', {}).setdefault(PLUGINS[version], {}).setdefault(
        'containerd', {}).setdefault('runtimes', {})
    require(HANDLER not in runtimes, f'{HANDLER} already exists; refusing to replace it')
    extra = fragment(version, identity)
    added = tomllib.loads(extra)['plugins'][PLUGINS[version]]['containerd']['runtimes'][HANDLER]
    runtimes[HANDLER] = added
    result = original + '\n' + extra
    require(tomllib.loads(result) == expected, 'candidate changed more than the new handler')
    return result


def runtime_class(node):
    require(len(node) <= 63 and re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', node),
            'provide the target node kubernetes.io/hostname label value (at most 63 characters)')
    return {'apiVersion': 'node.k8s.io/v1', 'kind': 'RuntimeClass',
            'metadata': {'name': RUNTIME_CLASS}, 'handler': HANDLER,
            'scheduling': {'nodeSelector': {'kubernetes.io/hostname': node}}}


def kind_config(directory, checkpoint_dir, name, image, version):
    manifest = verify_bundle(directory)
    require(re.fullmatch(r'[a-z0-9][a-z0-9-]*', name), 'invalid kind cluster name')
    require(checkpoint_dir.is_dir(), 'create a dedicated checkpoint directory before rendering')
    require(image and not any(char.isspace() for char in image), 'provide an explicit kind node image')
    return {'kind': 'Cluster', 'apiVersion': 'kind.x-k8s.io/v1alpha4', 'name': name,
            'containerdConfigPatches': [fragment(version, manifest['id'])],
            'nodes': [{'role': 'control-plane', 'image': image, 'extraMounts': [
                {'hostPath': str(directory.resolve()),
                 'containerPath': str(PREFIX / manifest['id']), 'readOnly': True},
                {'hostPath': str(checkpoint_dir.resolve()),
                 'containerPath': '/var/lib/xsphere/checkpoints'},
            ]}]}


def plan(directory, config, output, node):
    manifest = verify_bundle(directory)
    require(not output.exists(), 'plan output already exists; use a fresh directory')
    require(not config.is_symlink(), 'symlink config requires manual review')
    original = config.read_bytes().decode()
    result = candidate(original, manifest['id'])
    resource = runtime_class(node)
    output.mkdir(parents=True, mode=0o700)
    for name, content in [('before.toml', original), ('candidate.toml', result)]:
        (output / name).write_text(content)
        (output / name).chmod(0o600)
    write_json(output / 'runtimeclass.json', resource)
    write_json(output / 'plan.json', {
        'config': str(config.resolve()), 'bundle': str(directory.resolve()),
        'beforeSha256': sha(output / 'before.toml'), 'afterSha256': sha(output / 'candidate.toml'),
    })
    print(f'Plan only: {output}; no node changes or restarts performed')


def atomic_replace(path, content):
    stat = path.stat()
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.xsphere-', delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
        os.fchmod(stream.fileno(), stat.st_mode & 0o777)
        if os.geteuid() == 0:
            os.fchown(stream.fileno(), stat.st_uid, stat.st_gid)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def install_node(plan_dir):
    record = read_json(plan_dir / 'plan.json')
    config = Path(record['config'])
    directory = Path(record['bundle'])
    manifest = verify_bundle(directory)
    require(not config.is_symlink(), 'symlink config requires manual review')
    require(sha(config) == record['beforeSha256'], 'node config changed since planning')
    require(sha(plan_dir / 'before.toml') == record['beforeSha256'] and
            sha(plan_dir / 'candidate.toml') == record['afterSha256'], 'plan files were changed')
    require(candidate(config.read_bytes().decode(), manifest['id']) ==
            (plan_dir / 'candidate.toml').read_bytes().decode(),
            'plan is not the expected additive runtime change')
    destination = PREFIX / manifest['id']
    if destination.exists():
        require(verify_bundle(destination) == manifest, 'installed version differs from bundle')
    else:
        missing = []
        parent = destination.parent
        while not parent.exists():
            missing.append(parent)
            parent = parent.parent
        for parent in reversed(missing):
            parent.mkdir(mode=0o755)
            parent.chmod(0o755)
        shutil.copytree(directory, destination)
        destination.chmod(0o755)
    # Validate with the actual node binary before replacing its config. No service restart.
    effective = tomllib.loads(run('containerd', '--config', str(plan_dir / 'candidate.toml'),
                                 'config', 'dump', capture=True))
    plugin = PLUGINS[effective['version']]
    handler = effective['plugins'][plugin]['containerd']['runtimes'][HANDLER]
    require(handler['runtime_path'] == str(destination / BINARIES[1]) and
            handler['runtime_type'] == 'io.containerd.runsc.v1' and
            handler['options']['ConfigPath'] == str(destination / 'runsc.toml') and
            handler['pod_annotations'] == ['dev.gvisor.internal.*'],
            'containerd effective config does not select this bundle')
    require(sha(config) == record['beforeSha256'], 'node config changed during validation')
    atomic_replace(config, (plan_dir / 'candidate.toml').read_bytes())
    print('Installed candidate config. containerd is NOT restarted; review activation runbook.')


def rollback_node(plan_dir):
    record = read_json(plan_dir / 'plan.json')
    config = Path(record['config'])
    require(not config.is_symlink(), 'symlink config requires manual review')
    require(sha(plan_dir / 'before.toml') == record['beforeSha256'], 'backup checksum mismatch')
    if sha(config) == record['beforeSha256']:
        print('Original config already present; no change')
        return
    require(sha(config) == record['afterSha256'],
            'config has later edits; automatic rollback refused to preserve them')
    atomic_replace(config, (plan_dir / 'before.toml').read_bytes())
    print('Original config restored. No restart; binaries, PVCs and checkpoints retained.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('verify-lock')
    p = commands.add_parser('fetch-runsc', help='download the pinned official binary and verify its hash')
    p.add_argument('--arch', choices=['amd64', 'arm64'], required=True)
    p.add_argument('--output', type=Path, required=True)
    p = commands.add_parser('prepare')
    p.add_argument('--workdir', type=Path, required=True)
    p.add_argument('--source', help='optional existing Git repository used as a fetch source')
    p = commands.add_parser('verify-source')
    p.add_argument('--workdir', type=Path, required=True)
    p = commands.add_parser('build')
    p.add_argument('--workdir', type=Path, required=True)
    p.add_argument('--arch', choices=['amd64', 'arm64'], required=True)
    p.add_argument('--runsc', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--jobs', type=int, default=4)
    p = commands.add_parser('bundle', help='package previously recorded, hash-locked binaries')
    p.add_argument('--arch', choices=['amd64', 'arm64'], required=True)
    p.add_argument('--runsc', type=Path, required=True)
    p.add_argument('--shim', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p = commands.add_parser('verify-bundle')
    p.add_argument('--bundle', type=Path, required=True)
    p = commands.add_parser('kind-render', help='print JSON (valid YAML); does not create a cluster')
    p.add_argument('--bundle', type=Path, required=True)
    p.add_argument('--checkpoint-dir', type=Path, required=True)
    p.add_argument('--name', required=True)
    p.add_argument('--image', required=True)
    p.add_argument('--config-version', type=int, choices=[2, 3], default=2)
    p = commands.add_parser('runtimeclass-render')
    p.add_argument('--node', required=True, help='target node kubernetes.io/hostname label value')
    p = commands.add_parser('node-plan')
    p.add_argument('--bundle', type=Path, required=True)
    p.add_argument('--config', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--node', required=True)
    for command in ('node-install', 'node-rollback'):
        p = commands.add_parser(command)
        p.add_argument('--plan', type=Path, required=True)
        p.add_argument('--ack-node-change', action='store_true', required=True)
    args = parser.parse_args()
    if args.command.startswith('node-') and args.command != 'node-plan':
        require(platform.system() == 'Linux' and os.geteuid() == 0,
                'node changes require root on the explicitly selected Linux node')
        if args.command == 'node-install':
            record = read_json(args.plan / 'plan.json')
            manifest = verify_bundle(Path(record['bundle']))
            host = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
            require(host == manifest['architecture'], 'bundle architecture does not match this node')
            if host == 'arm64':
                require(not re.search(r'\b(paca|pacg)\b', Path('/proc/cpuinfo').read_text()),
                        'this restore baseline requires a no-PAC ARM64 VM; CPU settings are not changed')
    if args.command == 'verify-lock':
        locked()
        print('PASS: locked source and patch checksum')
    elif args.command == 'fetch-runsc':
        fetch_runsc(args.arch, args.output)
    elif args.command == 'prepare':
        prepare(args.workdir.resolve(), args.source)
    elif args.command == 'verify-source':
        check_source(args.workdir.resolve())
        print('PASS: pinned checkout contains exactly the prepared patch')
    elif args.command == 'build':
        require(args.jobs > 0, '--jobs must be positive')
        build(args.workdir.resolve(), args.arch, args.runsc.resolve(), args.output.resolve(), args.jobs)
    elif args.command == 'bundle':
        bundle(args.arch, args.runsc, args.shim, args.output)
    elif args.command == 'verify-bundle':
        print(json.dumps(verify_bundle(args.bundle), indent=2))
    elif args.command == 'kind-render':
        print(json.dumps(kind_config(args.bundle, args.checkpoint_dir, args.name,
                                     args.image, args.config_version), indent=2))
    elif args.command == 'runtimeclass-render':
        print(json.dumps(runtime_class(args.node), indent=2))
    elif args.command == 'node-plan':
        plan(args.bundle, args.config, args.output, args.node)
    elif args.command == 'node-install':
        install_node(args.plan)
    elif args.command == 'node-rollback':
        rollback_node(args.plan)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, KeyError) as error:
        raise SystemExit(f'ERROR: {error}') from error
