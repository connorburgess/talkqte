import importlib.util
import io
import gzip
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import json
import zipfile
import sys
import subprocess

spec = importlib.util.spec_from_file_location('artifact', Path(__file__).with_name('lab-hosted-artifact.py'))
artifact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifact)


def entry(name, kind='file', target=None, mode=0o644):
    m = tarfile.TarInfo(name)
    m.mode = mode
    if kind == 'dir':
        m.type = tarfile.DIRTYPE
    elif kind == 'symlink':
        m.type = tarfile.SYMTYPE
        m.linkname = target
    elif kind == 'hardlink':
        m.type = tarfile.LNKTYPE
        m.linkname = target
    elif kind == 'device':
        m.type = tarfile.CHRTYPE
    else:
        m.size = 3
    return m


class ArchiveProtocol(unittest.TestCase):
    def root(self):
        return entry('TalkQTE.app', 'dir', mode=0o755)

    def test_valid_roundtrip_preserves_mode_and_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / 'TalkQTE.app'
            (app / 'Contents/MacOS').mkdir(parents=True)
            exe = app / 'Contents/MacOS/talkqte'
            exe.write_bytes(b'not executable fixture')
            exe.chmod(0o755)
            archive = root / 'app.tar.gz'
            with tarfile.open(archive, 'w:gz', format=tarfile.USTAR_FORMAT, dereference=False) as t:
                t.add(app, arcname='TalkQTE.app')
            extracted = artifact.safe_extract(archive, root / 'out', artifact.digest(archive))
            self.assertEqual(artifact.inventory(app), artifact.inventory(extracted))
            self.assertEqual((extracted / 'Contents/MacOS/talkqte').stat().st_mode & 0o777, 0o755)
            with self.assertRaisesRegex(ValueError, 'already exists'):
                artifact.safe_extract(archive, root / 'out', artifact.digest(archive))

    def test_rejects_unsafe_archives_before_creating_output(self):
        cases = [
            [entry('/absolute')], [entry('TalkQTE.app/../escape')],
            [entry('Other.app', 'dir')], [self.root(), self.root()],
            [self.root(), entry('TalkQTE.app/link', 'hardlink', 'x')],
            [self.root(), entry('TalkQTE.app/dev', 'device')],
            [self.root(), entry('TalkQTE.app/setuid', mode=0o4755)],
            [self.root(), entry('TalkQTE.app/a', 'symlink', '../../outside')],
            [self.root(), entry('TalkQTE.app/a', 'symlink', '/outside')],
            [self.root(), entry('TalkQTE.app/a', 'symlink', 'missing')],
            [self.root(), entry('TalkQTE.app/a', 'symlink', 'a')],
            [self.root(), entry('TalkQTE.app/a', 'symlink', '.'), entry('TalkQTE.app/a/child')],
            [self.root(), entry('TalkQTE.app/file'), entry('TalkQTE.app/file/child')],
        ]
        for index, members in enumerate(cases):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as tmp:
                archive = Path(tmp) / 'bad.tar.gz'
                with tarfile.open(archive, 'w:gz', format=tarfile.USTAR_FORMAT) as t:
                    for m in members:
                        t.addfile(m, io.BytesIO(b'abc') if m.isfile() else None)
                dest = Path(tmp) / 'out'
                with self.assertRaises(ValueError):
                    artifact.safe_extract(archive, dest, artifact.digest(archive))
                self.assertFalse(dest.exists())

    def test_digest_mismatch_and_size_limits_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / 'fixture.tar.gz'
            with tarfile.open(archive, 'w:gz', format=tarfile.USTAR_FORMAT) as t:
                t.addfile(self.root())
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                artifact.safe_extract(archive, Path(tmp) / 'out', '0' * 64)
            huge = entry('TalkQTE.app/huge')
            huge.size = artifact.MAX_CONTENT + 1
            with self.assertRaisesRegex(ValueError, 'content limit'):
                artifact.validate_members([self.root(), huge])
            with self.assertRaisesRegex(ValueError, 'entry count'):
                artifact.validate_members([self.root()] * (artifact.MAX_ENTRIES + 1))

    def test_symlink_chain_cannot_escape_after_resolution(self):
        # Lexical normalization alone misses a/../.. after a points upward.
        with self.assertRaises(ValueError):
            artifact.validate_members([
                self.root(), entry('TalkQTE.app/d', 'dir'),
                entry('TalkQTE.app/d/a', 'symlink', '..'),
                entry('TalkQTE.app/d/b', 'symlink', 'a/../../escape'),
            ])

    def test_case_and_unicode_aliases_include_implicit_ancestors(self):
        cases = [
            [entry('TalkQTE.app/A'), entry('TalkQTE.app/a')],
            [entry('TalkQTE.app/D/a'), entry('TalkQTE.app/d/b')],
            [entry('TalkQTE.app/D', 'dir'), entry('TalkQTE.app/d/a')],
            [entry('TalkQTE.app/é'), entry('TalkQTE.app/e\u0301')],
            [entry('TalkQTE.app/K'), entry('TalkQTE.app/K')],
            [entry('TalkQTE.app/Ａ')],
        ]
        for members in cases:
            with self.subTest(names=[m.name for m in members]), self.assertRaises(ValueError):
                artifact.validate_members([self.root(), *members])

    def test_real_case_insensitive_escape_reproduction_rejected_before_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'CaseProbe').write_bytes(b'fixture')
            if not (root / 'caseprobe').exists():
                self.skipTest('requires real case-insensitive filesystem (macOS default)')
            # Exact reviewer reproduction, entirely under a disposable root.
            # Old code wrote root/outside/evil through case-alias symlink parents.
            members = [self.root(), entry('TalkQTE.app/d', 'dir'),
                       entry('TalkQTE.app/outside', 'dir'),
                       entry('TalkQTE.app/d/A', 'symlink', '..'),
                       entry('TalkQTE.app/d/b', 'symlink', 'a/../../outside'),
                       entry('TalkQTE.app/d/B/evil')]
            archive = root / 'escape.tar.gz'
            with tarfile.open(archive, 'w:gz', format=tarfile.USTAR_FORMAT) as t:
                for m in members:
                    t.addfile(m, io.BytesIO(b'abc') if m.isfile() else None)
            dest = root / 'extracted'
            with self.assertRaises(ValueError):
                artifact.safe_extract(archive, dest, artifact.digest(archive))
            self.assertFalse(dest.exists())
            self.assertFalse((root / 'outside/evil').exists())
            self.assertFalse((root / 'outside').exists())

    def test_decoded_tar_bound_precedes_all_metadata_parsing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'metadata.tar.gz'
            # Tiny gzip containing a large, highly compressible PAX comment.
            m = self.root()
            m.pax_headers = {'comment': 'x' * 65536}
            with tarfile.open(archive, 'w:gz', format=tarfile.PAX_FORMAT) as t:
                t.addfile(m)
            self.assertLess(archive.stat().st_size, 2048)
            with patch.object(artifact, 'MAX_CONTENT', 1024), patch.object(artifact.tarfile.TarInfo, 'frombuf', side_effect=AssertionError('metadata parser reached')):
                with self.assertRaisesRegex(ValueError, 'decoded tar byte limit'):
                    artifact.safe_extract(archive, root / 'out', artifact.digest(archive))
            self.assertFalse((root / 'out').exists())

    def test_pax_gnu_long_headers_and_header_count_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            variants = [
                (tarfile.PAX_FORMAT, entry('TalkQTE.app/' + 'x' * 150)),
                (tarfile.GNU_FORMAT, entry('TalkQTE.app/' + 'x' * 150)),
                (tarfile.GNU_FORMAT, entry('TalkQTE.app/a', 'symlink', 'x' * 150)),
            ]
            for index, (fmt, m) in enumerate(variants):
                archive = root / str(index)
                with tarfile.open(archive, 'w:gz', format=fmt) as t:
                    t.addfile(self.root())
                    t.addfile(m, io.BytesIO(b'abc') if m.isfile() else None)
                with self.assertRaises(ValueError):
                    artifact.safe_extract(archive, root / ('out' + str(index)), artifact.digest(archive))
                self.assertFalse((root / ('out' + str(index))).exists())
            archive = root / 'many'
            with tarfile.open(archive, 'w:gz', format=tarfile.USTAR_FORMAT) as t:
                t.addfile(self.root())
                t.addfile(entry('TalkQTE.app/a', 'dir'))
                t.addfile(entry('TalkQTE.app/b', 'dir'))
            with patch.object(artifact, 'MAX_ENTRIES', 2):
                with self.assertRaisesRegex(ValueError, 'entry/header count'):
                    artifact.safe_extract(archive, root / 'many-out', artifact.digest(archive))
            self.assertFalse((root / 'many-out').exists())

    def test_outer_zip_exact_names_types_and_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'actions.zip'
            names = ['TalkQTE-unsigned.tar.gz', 'provenance.json', 'inventory.json']
            with zipfile.ZipFile(archive, 'w') as z:
                for name in names:
                    z.writestr(name, b'fixture')
            artifact.safe_download(archive, root / 'valid', artifact.digest(archive))
            self.assertEqual(sorted(p.name for p in (root / 'valid').iterdir()), sorted(names))
            for index, bad in enumerate(['../escape', '/absolute', 'extra', 'inventory.json']):
                with zipfile.ZipFile(archive, 'w') as z:
                    for name in names[:2]:
                        z.writestr(name, b'fixture')
                    z.writestr(bad, b'fixture')
                    if bad == 'inventory.json':
                        z.writestr(bad, b'duplicate')
                with self.assertRaises(ValueError):
                    artifact.safe_download(archive, root / str(index), artifact.digest(archive))
                self.assertFalse((root / str(index)).exists())
            with zipfile.ZipFile(archive, 'w') as z:
                for name in names:
                    m = zipfile.ZipInfo(name)
                    m.external_attr = (0o120777 << 16)
                    z.writestr(m, b'outside')
            with self.assertRaisesRegex(ValueError, 'outer artifact type'):
                artifact.safe_download(archive, root / 'link', artifact.digest(archive))

    def test_fake_hosted_pack_source_toolchain_provenance_failure_and_tamper(self):
        # Rust selection uses an actual harmless subprocess; other host tools are mocked.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source'
            (source / 'src-tauri').mkdir(parents=True)
            for name in ['Entitlements.plist', 'Cargo.lock']:
                (source / 'src-tauri' / name).write_text('fixture')
            (source / 'package-lock.json').write_text('fixture')
            (source / 'rust-toolchain.toml').write_text('1.97.1')
            # Model rustup's cwd-dependent selection: the workspace/default differs.
            # This script is not rustc and never compiles or invokes a real toolchain.
            fake_rustc = root / 'fake-rustc.py'
            fake_rustc.write_text(
                'from pathlib import Path\nimport sys\n'
                'source = Path(sys.argv[1])\n'
                'version = (source / "rust-toolchain.toml").read_text() if Path.cwd() == source.resolve() else "1.96.0"\n'
                'print("rustc " + version + " fixture" + ("\\nrelease: " + version if sys.argv[2] == "-vV" else ""))\n'
            )
            real_capture = artifact.capture
            rust_queries = []
            def rust_command(args, cwd):
                return real_capture([sys.executable, str(fake_rustc), str(source), *args], cwd)
            self.assertTrue(rust_command(['--version'], root).startswith('rustc 1.96.0 '))
            self.assertTrue(rust_command(['--version'], source).startswith('rustc 1.97.1 '))
            app = root / 'TalkQTE.app'
            (app / 'Contents/MacOS').mkdir(parents=True)
            (app / 'Contents/Resources').mkdir()
            sha = 'a' * 40
            workflow = 'b' * 40
            exe = app / 'Contents/MacOS/talkqte'
            exe.write_bytes(sha.encode())
            exe.chmod(0o755)
            (app / 'Contents/Resources/THIRD-PARTY-NOTICES.txt').write_text('fixture')
            import plistlib
            (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'com.talkqte.desktop', 'LSMinimumSystemVersion': '14.0'}))
            def fake_capture(argv, cwd=None):
                if argv[:3] == ['git', 'rev-parse', 'HEAD']:
                    return sha if cwd == source else workflow
                if argv[:2] == ['git', 'status']:
                    return ''
                if argv[0] in ['uname', '/usr/bin/lipo']:
                    return 'arm64'
                if argv[0] == 'xcrun':
                    return 'platform MACOS\n minos 14.0\n sdk 26.5\n'
                if argv[0] == 'rustc':
                    rust_queries.append((argv[1:], cwd))
                    return rust_command(argv[1:], cwd)
                return 'fixture version'
            real_digest = artifact.digest
            def fake_digest(path):
                if path.name == 'Entitlements.plist':
                    return 'd70ae7a3f925e53536fe56d205e4bab9bc1df03495738bf8dfdb6cb6dbb53c7d'
                return real_digest(path)
            env = {'GITHUB_ACTIONS': 'true', 'GITHUB_WORKFLOW_SHA': workflow, 'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'}
            out = root / 'export'
            with patch.object(artifact, 'capture', fake_capture), patch.object(artifact, 'digest', fake_digest), patch.dict(artifact.os.environ, env):
                artifact.pack(source, sha, app, out)
            provenance = json.loads((out / 'provenance.json').read_text())
            self.assertEqual(provenance['sourceCommit'], sha)
            self.assertEqual(provenance['workflowCommit'], workflow)
            self.assertEqual(provenance['features'], artifact.FEATURES)
            self.assertEqual(provenance['rustc'], 'rustc 1.97.1 fixture\nrelease: 1.97.1')
            self.assertEqual(rust_queries, [(['--version'], source), (['-vV'], source)])
            # A wrong SOURCE toolchain still fails before any export directory.
            (source / 'rust-toolchain.toml').write_text('1.96.9')
            rejected = root / 'rejected-export'
            with patch.object(artifact, 'capture', fake_capture), patch.object(artifact, 'digest', fake_digest), patch.dict(artifact.os.environ, env):
                with self.assertRaisesRegex(ValueError, 'Rust toolchain'):
                    artifact.pack(source, sha, app, rejected)
            self.assertFalse(rejected.exists())
            extracted = artifact.safe_extract(out / 'TalkQTE-unsigned.tar.gz', root / 'new', provenance['archiveSha256'])
            artifact.verify_extracted(extracted, out / 'provenance.json', out / 'inventory.json', sha, workflow)
            (extracted / 'Contents/MacOS/talkqte').write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'inventory mismatch'):
                artifact.verify_extracted(extracted, out / 'provenance.json', out / 'inventory.json', sha, workflow)

    def test_manual_workflow_rejects_unreviewed_input_before_literal_checkout(self):
        workflow = Path(__file__).parents[1] / '.github/workflows/checks.yml'
        text = workflow.read_text()
        normal, job = text.split('  lab-artifact:\n', 1)
        sha = '6f626d2fef9419a3448b32fe62733bcd6c768038'
        self.assertNotIn('ref: ${{ inputs.lab_native_sha }}', job)
        self.assertNotIn('          NATIVE_SHA: ${{ inputs.lab_native_sha }}', job)
        self.assertEqual(job.count('NATIVE_SHA: ' + sha), 3)
        self.assertIn('ref: ' + sha + '\n          path: native-source', job)
        self.assertIn('package-manager-cache: false', job)
        self.assertIn('cache: npm', normal)  # Normal frontend caching remains.
        selection = job.split('      - uses:', 1)[0]
        script = selection.split('        run: |\n', 1)[1]
        script = '\n'.join(line[10:] for line in script.splitlines())
        # Execute the actual gate before the host-architecture query. Wrong
        # inputs must stop before reaching even that harmless fixture command.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            marker = root / 'queried-host'
            uname = root / 'uname'
            uname.write_text('#!/bin/sh\nprintf queried > "$HOST_MARKER"\nprintf arm64\n')
            uname.chmod(0o755)
            for requested in [sha, '', 'a' * 40, sha.upper(), sha + ';echo bad']:
                marker.unlink(missing_ok=True)
                result = subprocess.run(['/bin/bash', '-e', '-c', script], env={
                    'PATH': str(root), 'HOST_MARKER': str(marker),
                    'NATIVE_SHA': sha, 'REQUESTED_NATIVE_SHA': requested,
                }, capture_output=True)
                self.assertEqual(result.returncode == 0, requested == sha)
                self.assertEqual(marker.exists(), requested == sha)

    def test_pack_rejects_bad_commit_before_any_command_or_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'commit shape'):
                artifact.pack(Path(tmp), 'main;bad', Path(tmp), Path(tmp) / 'out')
            self.assertFalse((Path(tmp) / 'out').exists())


if __name__ == '__main__':
    unittest.main()
