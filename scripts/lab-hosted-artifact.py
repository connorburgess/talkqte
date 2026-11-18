#!/usr/bin/env python3
"""Static unsigned lab archive/provenance; never signs or executes an app."""
import argparse
from collections import deque
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import subprocess
import tarfile
import zipfile

SHA = re.compile(r'[0-9a-f]{40}\Z')
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_CONTENT = 512 * 1024 * 1024
MAX_ENTRIES = 20000
FEATURES = ['cloud-transcription', 'lab-evaluator', 'native-audio-spike', 'timing-log']


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def inventory(app):
    records = []
    for path in sorted(app.rglob('*'), key=lambda p: p.relative_to(app).as_posix()):
        s = path.lstat()
        item = {'path': path.relative_to(app).as_posix(), 'mode': stat.S_IMODE(s.st_mode)}
        if stat.S_ISLNK(s.st_mode):
            item.update(type='symlink', target=os.readlink(path))
        elif stat.S_ISREG(s.st_mode):
            item.update(type='file', bytes=s.st_size, sha256=digest(path))
        elif stat.S_ISDIR(s.st_mode):
            item.update(type='directory')
        else:
            raise ValueError('unsupported bundle entry')
        records.append(item)
    return records


def validate_members(members):
    require(0 < len(members) <= MAX_ENTRIES, 'entry count')
    names = set()
    links = {}
    total = 0
    for m in members:
        p = PurePosixPath(m.name)
        require(not p.is_absolute() and '..' not in p.parts and p.parts[0] == 'TalkQTE.app', 'unsafe member path')
        require(m.name == p.as_posix() and m.name not in names, 'duplicate or noncanonical path')
        names.add(m.name)
        require(m.isfile() or m.isdir() or m.issym(), 'hardlink/device/unsupported type')
        require(not (m.mode & 0o7000), 'special permission bits')
        total += m.size
        require(total <= MAX_CONTENT, 'content limit')
        if m.issym():
            require(m.size == 0 and m.linkname and not PurePosixPath(m.linkname).is_absolute(), 'unsafe symlink')
            parts = list(p.parent.parts)
            for part in PurePosixPath(m.linkname).parts:
                if part == '..':
                    require(len(parts) > 1, 'escaping symlink')
                    parts.pop()
                elif part not in ('.', ''):
                    parts.append(part)
            require(parts[0] == 'TalkQTE.app', 'escaping symlink')
            links[m.name] = m.linkname
    require('TalkQTE.app' in names, 'missing app root')
    types = {m.name: m.isdir() for m in members}
    for link in links:
        pending = deque(PurePosixPath(link).parts)
        resolved = []
        traversals = 0
        while pending:
            part = pending.popleft()
            if part == '..':
                require(len(resolved) > 1, 'escaping symlink chain')
                resolved.pop()
                continue
            resolved.append(part)
            here = '/'.join(resolved)
            if here in links:
                traversals += 1
                require(traversals <= len(links), 'symlink cycle')
                resolved.pop()
                pending.extendleft(reversed(PurePosixPath(links[here]).parts))
        require('/'.join(resolved) in names, 'dangling symlink')
    for name in names:
        require(all(types.get(parent.as_posix(), True) for parent in PurePosixPath(name).parents if parent.as_posix() in names), 'member beneath non-directory')
        require(not any(parent.as_posix() in links for parent in PurePosixPath(name).parents), 'member beneath symlink')


def safe_extract(archive, destination, expected_sha):
    require(re.fullmatch(r'[0-9a-f]{64}', expected_sha) is not None, 'archive digest shape')
    require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size <= MAX_ARCHIVE, 'archive limit/type')
    require(digest(archive) == expected_sha, 'archive digest mismatch')
    require(not destination.exists(), 'destination already exists')
    # Validate every entry before creating any output. Extraction is implemented
    # here rather than relying on tar's overwrite/link traversal behavior.
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        validate_members(members)
        destination.mkdir(mode=0o700)
        for m in sorted(members, key=lambda v: (len(PurePosixPath(v.name).parts), v.name)):
            target = destination.joinpath(*PurePosixPath(m.name).parts)
            if m.isdir():
                target.mkdir(mode=0o700, exist_ok=True)
            elif m.isfile():
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with tar.extractfile(m) as src, open(target, 'xb') as out:
                    while b := src.read(1024 * 1024):
                        out.write(b)
                target.chmod(m.mode & 0o777)
            else:
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                target.symlink_to(m.linkname)
        for m in sorted(members, key=lambda v: len(PurePosixPath(v.name).parts), reverse=True):
            if m.isdir():
                destination.joinpath(*PurePosixPath(m.name).parts).chmod(m.mode & 0o777)
    return destination / 'TalkQTE.app'


def safe_download(archive, destination, expected_sha):
    require(re.fullmatch(r'[0-9a-f]{64}', expected_sha) is not None, 'artifact digest shape')
    require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size <= MAX_ARCHIVE + 9437184, 'artifact archive limit/type')
    require(digest(archive) == expected_sha, 'Actions artifact digest mismatch')
    require(not destination.exists(), 'destination already exists')
    expected = {'TalkQTE-unsigned.tar.gz': MAX_ARCHIVE, 'provenance.json': 65536, 'inventory.json': 8388608}
    with zipfile.ZipFile(archive) as z:
        members = z.infolist()
        require(len(members) == 3 and {m.filename for m in members} == set(expected), 'outer artifact entries')
        for m in members:
            kind = stat.S_IFMT(m.external_attr >> 16)
            require(kind in (0, stat.S_IFREG) and not m.is_dir() and not (m.flag_bits & 1), 'outer artifact type')
            require(m.file_size <= expected[m.filename], 'outer artifact size')
        destination.mkdir(mode=0o700)
        for m in members:
            with z.open(m) as src, open(destination / m.filename, 'xb') as out:
                total = 0
                while b := src.read(1024 * 1024):
                    total += len(b)
                    require(total <= expected[m.filename], 'outer artifact decoded size')
                    out.write(b)
            (destination / m.filename).chmod(0o600)


def capture(argv, cwd=None):
    return subprocess.check_output(argv, cwd=cwd, text=True, timeout=30).strip()


def pack(source, sha, app, out):
    require(SHA.fullmatch(sha), 'source commit shape')
    require(capture(['git', 'rev-parse', 'HEAD'], source) == sha, 'source commit mismatch')
    require(not capture(['git', 'status', '--porcelain'], source), 'dirty source')
    require(capture(['uname', '-m']) == 'arm64', 'runner architecture')
    require(os.environ.get('GITHUB_ACTIONS') == 'true', 'hosted only')
    workflow_sha = os.environ.get('GITHUB_WORKFLOW_SHA', '')
    require(SHA.fullmatch(workflow_sha), 'workflow provenance')
    require(capture(['git', 'rev-parse', 'HEAD'], Path(__file__).resolve().parents[1]) == workflow_sha, 'workflow checkout mismatch')
    require(re.fullmatch(r'[1-9][0-9]*', os.environ.get('GITHUB_RUN_ID', '')), 'run provenance')
    require(re.fullmatch(r'[1-9][0-9]*', os.environ.get('GITHUB_RUN_ATTEMPT', '')), 'attempt provenance')
    exe = app / 'Contents/MacOS/talkqte'
    require(app.is_dir() and not app.is_symlink() and exe.is_file() and not exe.is_symlink(), 'bundle shape')
    require((app / 'Contents/Resources/THIRD-PARTY-NOTICES.txt').is_file(), 'missing notices')
    require(sha.encode() in exe.read_bytes(), 'missing embedded source commit')
    require(capture(['/usr/bin/lipo', '-archs', str(exe)]) == 'arm64', 'binary architecture')
    macho = capture(['xcrun', 'vtool', '-show-build', str(exe)])
    require(re.search(r'\bminos\s+14\.0\s', macho), 'Mach-O minimum OS')
    with open(app / 'Contents/Info.plist', 'rb') as f:
        info = plistlib.load(f)
    require(info.get('CFBundleIdentifier') == 'com.talkqte.desktop' and info.get('LSMinimumSystemVersion') == '14.0', 'bundle identity/minimum OS')
    require(capture(['rustc', '--version']).startswith('rustc 1.97.1 '), 'Rust toolchain')
    require(digest(source / 'src-tauri/Entitlements.plist') == 'd70ae7a3f925e53536fe56d205e4bab9bc1df03495738bf8dfdb6cb6dbb53c7d', 'entitlement input changed')
    records = inventory(app)
    require(not out.exists(), 'output already exists')
    out.mkdir(mode=0o700)
    archive = out / 'TalkQTE-unsigned.tar.gz'
    def public_header(member):
        member.uid = member.gid = 0
        member.uname = member.gname = ''
        # PAX filesystem metadata is unnecessary for a repository-built app.
        member.pax_headers = {}
        return member
    with tarfile.open(archive, 'w:gz', dereference=False) as tar:
        tar.add(app, arcname='TalkQTE.app', recursive=True, filter=public_header)
    require(archive.stat().st_size <= MAX_ARCHIVE, 'archive limit')
    with tarfile.open(archive, 'r:gz') as tar:
        validate_members(tar.getmembers())
    provenance = {
        'schema': 'talkqte.lab.hosted-artifact.v1', 'sourceCommit': sha,
        'workflowCommit': workflow_sha, 'workflow': os.environ.get('GITHUB_WORKFLOW_REF'),
        'runId': os.environ['GITHUB_RUN_ID'], 'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
        'job': os.environ.get('GITHUB_JOB'), 'runnerImage': os.environ.get('ImageOS'),
        'runnerImageVersion': os.environ.get('ImageVersion'), 'architecture': 'arm64',
        'minimumMacOS': '14.0', 'profile': 'debug', 'target': 'aarch64-apple-darwin',
        'features': FEATURES, 'noDefaultFeatures': True, 'locked': True,
        'signing': 'no identity signing requested; local development signing remains separate',
        'executableSha256': digest(exe), 'inventorySha256': hashlib.sha256(canonical(records)).hexdigest(),
        'archiveSha256': digest(archive), 'archiveBytes': archive.stat().st_size,
        'entitlementInputSha256': digest(source / 'src-tauri/Entitlements.plist'),
        'packageLockSha256': digest(source / 'package-lock.json'),
        'cargoLockSha256': digest(source / 'src-tauri/Cargo.lock'),
        'rustc': capture(['rustc', '-vV']), 'node': capture(['node', '--version']),
        'xcode': capture(['xcodebuild', '-version']),
        'machO': '\n'.join(line.strip() for line in macho.splitlines() if re.match(r'\s*(platform|minos|sdk)\s', line)),
    }
    (out / 'inventory.json').write_bytes(canonical(records))
    (out / 'provenance.json').write_bytes(canonical(provenance) + b'\n')
    for path in out.iterdir():
        path.chmod(0o600)


def verify_extracted(app, provenance_path, inventory_path, sha, workflow_sha):
    require(SHA.fullmatch(sha) and SHA.fullmatch(workflow_sha), 'expected source/workflow shape')
    require(provenance_path.stat().st_size <= 65536 and inventory_path.stat().st_size <= 8388608, 'metadata size')
    p = json.loads(provenance_path.read_text())
    require(p.get('schema') == 'talkqte.lab.hosted-artifact.v1', 'provenance version')
    require(p.get('sourceCommit') == sha and p.get('workflowCommit') == workflow_sha, 'provenance identity mismatch')
    require(p.get('features') == FEATURES and p.get('target') == 'aarch64-apple-darwin' and p.get('profile') == 'debug' and p.get('noDefaultFeatures') is True and p.get('locked') is True, 'build tuple mismatch')
    expected = json.loads(inventory_path.read_bytes())
    require(hashlib.sha256(canonical(expected)).hexdigest() == p.get('inventorySha256'), 'inventory metadata digest')
    require(inventory(app) == expected, 'extracted inventory mismatch')
    exe = app / 'Contents/MacOS/talkqte'
    require(digest(exe) == p.get('executableSha256'), 'executable digest mismatch')
    require(sha.encode() in exe.read_bytes(), 'embedded source mismatch')
    # This is integrity checking, not a signature/architecture acceptance claim.
    # The documented local protocol independently runs lipo/vtool/codesign.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('pack')
    for key in ['source', 'sha', 'app', 'out']:
        p.add_argument('--' + key, required=True)
    p = sub.add_parser('verify-download')
    for key in ['archive', 'sha256', 'destination']:
        p.add_argument('--' + key, required=True)
    p = sub.add_parser('extract')
    for key in ['archive', 'sha256', 'destination']:
        p.add_argument('--' + key, required=True)
    p = sub.add_parser('verify-extracted')
    for key in ['app', 'provenance', 'inventory', 'sha', 'workflow-sha']:
        p.add_argument('--' + key, required=True)
    a = parser.parse_args()
    if a.command == 'pack':
        pack(Path(a.source), a.sha, Path(a.app), Path(a.out))
    elif a.command == 'verify-download':
        safe_download(Path(a.archive), Path(a.destination), a.sha256)
    elif a.command == 'extract':
        safe_extract(Path(a.archive), Path(a.destination), a.sha256)
    else:
        verify_extracted(Path(a.app), Path(a.provenance), Path(a.inventory), a.sha, a.workflow_sha)


if __name__ == '__main__':
    main()
