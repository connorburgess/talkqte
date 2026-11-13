import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  parseArguments,
  parsePlist,
  parseSignature,
  preflight,
} from './release-preflight.mjs';
import { inputsLine } from './third-party-notices.mjs';

// Everything here is a fictional project and bundle written to a temporary
// folder; no real app, signature or Apple service is involved.
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  'release-preflight.mjs',
);
const MICROPHONE = 'com.apple.security.device.audio-input';
const USAGE = 'Listen only after you start the fictional practice session.';

const plist = (entries) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${Object.entries(
    entries,
  )
    .map(
      ([key, value]) =>
        `\t<key>${key}</key>\n\t${value === true ? '<true/>' : value === false ? '<false/>' : `<string>${value}</string>`}`,
    )
    .join('\n')}\n</dict>\n</plist>\n`;

/** A minimal fictional 64-bit Mach-O executable: a header, one load command
 * per [path, weak] library, then `payload` as plain bytes. */
function machO(libraries, payload = '') {
  const commands = libraries.map(([path, weak]) => {
    const name = Buffer.from(`${path}\0`);
    const size = Math.ceil((24 + name.length) / 8) * 8;
    const command = Buffer.alloc(size);
    command.writeUInt32LE(weak ? 0x80000018 : 0xc, 0);
    command.writeUInt32LE(size, 4);
    command.writeUInt32LE(24, 8);
    name.copy(command, 24);
    return command;
  });
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(
    commands.reduce((total, command) => total + command.length, 0),
    20,
  );
  return Buffer.concat([header, ...commands, Buffer.from(payload, 'latin1')]);
}

/** A universal file holding the given slices. */
function universal(...slices) {
  const header = Buffer.alloc(8 + slices.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  let offset = header.length;
  slices.forEach((slice, index) => {
    header.writeUInt32BE(offset, 8 + index * 20 + 8);
    header.writeUInt32BE(slice.length, 8 + index * 20 + 12);
    offset += slice.length;
  });
  return Buffer.concat([header, ...slices]);
}

const SYSTEM = ['/usr/lib/libSystem.B.dylib'];
const SPIKE =
  '/System/Library/Frameworks/ScreenCaptureKit.framework/Versions/A/ScreenCaptureKit';

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A consistent fictional project and its bundle; `change` edits either. */
function fixture(t, change = {}) {
  const root = mkdtempSync(join(tmpdir(), 'preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const version = '1.4.2';
  const config = {
    version,
    identifier: 'org.example.orchard',
    bundle: {
      macOS: {
        minimumSystemVersion: '13.0',
        entitlements: 'Entitlements.plist',
        files: { 'Resources/THIRD-PARTY-NOTICES.txt': 'NOTICES.txt' },
      },
    },
  };
  change.config?.(config);
  write(root, 'package.json', JSON.stringify({ version }));
  write(
    root,
    'package-lock.json',
    JSON.stringify({ version, packages: { '': { version } } }),
  );
  write(
    root,
    'src-tauri/Cargo.toml',
    `[package]\nname = "orchard"\nversion = "${change.cargoVersion ?? version}"\n\n[dependencies]\nserde = { version = "1" }\n`,
  );
  write(
    root,
    'src-tauri/Cargo.lock',
    `[[package]]\nname = "orchard"\nversion = "${version}"\n`,
  );
  write(root, 'src-tauri/tauri.conf.json', JSON.stringify(config));
  write(
    root,
    'src-tauri/Entitlements.plist',
    plist(change.entitlements ?? { [MICROPHONE]: true }),
  );
  write(
    root,
    'src-tauri/Info.plist',
    plist({ NSMicrophoneUsageDescription: USAGE }),
  );

  const app = join(root, 'out', 'Orchard.app');
  const info = {
    CFBundleExecutable: 'orchard',
    CFBundleIdentifier: 'org.example.orchard',
    CFBundleShortVersionString: version,
    LSMinimumSystemVersion: '13.0',
    NSMicrophoneUsageDescription: USAGE,
  };
  change.info?.(info);
  write(app, 'Contents/Info.plist', plist(info));
  write(
    app,
    'Contents/MacOS/orchard',
    change.binary ??
      machO(
        change.libraries ?? [SYSTEM],
        change.executable ?? 'fictional code',
      ),
  );
  chmodSync(join(app, 'Contents/MacOS/orchard'), 0o755);
  write(app, 'Contents/Resources/icon.icns', 'icon');
  // Written last, so its digests cover the lockfiles above.
  const notices = `Fictional notices\n${inputsLine(root)}\n`;
  if (change.notices !== null)
    write(root, 'src-tauri/NOTICES.txt', change.notices ?? notices);
  write(app, 'Contents/Resources/THIRD-PARTY-NOTICES.txt', notices);
  change.bundle?.(app);
  return { root, app };
}

const DEVELOPER_ID = `Executable=/tmp/Orchard.app/Contents/MacOS/orchard
Identifier=org.example.orchard
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=445 flags=0x10000(runtime) hashes=3+7 location=embedded
Authority=Developer ID Application: Example Orchard Cooperative (EXAMPLE123)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=1 Jan 2030 at 09:00:00
TeamIdentifier=EXAMPLE123
`;
const AD_HOC = `Identifier=org.example.orchard
CodeDirectory v=20400 size=300 flags=0x10002(adhoc,runtime) hashes=3+7 location=embedded
Signature=adhoc
TeamIdentifier=not set
`;

/** Stands in for the macOS tools, answering with fictional output. */
function tools(overrides = {}) {
  const answers = {
    lipo: { stdout: 'arm64\n' },
    vtool: {
      stdout: '      cmd LC_BUILD_VERSION\n    minos 13.0\n      sdk 26.0\n',
    },
    display: { stderr: DEVELOPER_ID },
    verify: {},
    entitlements: { stdout: plist({ [MICROPHONE]: true }) },
    stapler: { stdout: 'The validate action worked!\n' },
    spctl: { stderr: 'accepted\nsource=Notarized Developer ID\n' },
    ...overrides,
  };
  return (command, args) => {
    const key =
      command === 'codesign'
        ? args.some((argument) => argument.startsWith('-R='))
          ? 'requirement'
          : args.includes('--verify')
            ? 'verify'
            : args.includes('--entitlements')
              ? 'entitlements'
              : 'display'
        : command === 'xcrun'
          ? 'stapler'
          : command;
    return {
      status: 0,
      stdout: '',
      stderr: '',
      missing: false,
      ...answers[key],
    };
  };
}

const failures = (result) =>
  result.findings
    .filter((finding) => finding.level === 'fail')
    .map((finding) => `${finding.check}: ${finding.message}`);

test('a consistent project and bundle pass, with the signature only reported', (t) => {
  const { root, app } = fixture(t);
  const result = preflight({
    root,
    app,
    run: tools({ display: { stderr: AD_HOC } }),
  });
  assert.deepEqual(failures(result), []);
  assert.equal(result.passed, true);
  const signature = result.findings.find(
    (finding) => finding.check === 'signature',
  );
  assert.equal(signature.level, 'note');
  assert.match(signature.message, /ad-hoc.*local inspection only/);
});

test('a version that differs in one manifest is named with every source', (t) => {
  const { root } = fixture(t, { cargoVersion: '1.4.1' });
  const [problem] = failures(preflight({ root }));
  assert.match(problem, /^version: sources disagree/);
  assert.match(problem, /src-tauri\/Cargo\.toml 1\.4\.1/);
  assert.match(problem, /package\.json 1\.4\.2/);
});

test('a bundle built from another identifier, version or macOS floor fails', (t) => {
  const { root, app } = fixture(t, {
    info: (info) => {
      info.CFBundleIdentifier = 'org.example.orchard.dev';
      info.CFBundleShortVersionString = '1.4.1';
      info.LSMinimumSystemVersion = '14.0';
    },
  });
  assert.deepEqual(failures(preflight({ root, app, run: tools() })), [
    'bundle identifier in the app: the bundle says org.example.orchard.dev, tauri.conf.json says org.example.orchard',
    'version in the app: the bundle says 1.4.1, tauri.conf.json says 1.4.2',
    'minimum macOS in the app: the bundle says 14.0, tauri.conf.json says 13.0',
  ]);
});

test('a missing or reworded permission explanation in the bundle fails', (t) => {
  const missing = fixture(t, {
    info: (info) => delete info.NSMicrophoneUsageDescription,
  });
  assert.match(
    failures(preflight({ ...missing, run: tools() }))[0],
    /NSMicrophoneUsageDescription is missing from the bundle/,
  );
  const extra = fixture(t, {
    info: (info) => {
      info.NSMicrophoneUsageDescription = 'Different words.';
      info.NSCameraUsageDescription = 'Unexpected.';
    },
  });
  const [problem] = failures(preflight({ ...extra, run: tools() }));
  assert.match(problem, /NSMicrophoneUsageDescription differs/);
  assert.match(problem, /NSCameraUsageDescription is in the bundle but not in/);
});

test('an entitlement outside the reviewed list fails before any build', (t) => {
  const { root } = fixture(t, {
    entitlements: {
      [MICROPHONE]: true,
      'com.apple.security.get-task-allow': true,
    },
  });
  assert.deepEqual(failures(preflight({ root })), [
    'entitlements: com.apple.security.get-task-allow is not on the reviewed list',
  ]);
});

test('a committed signing identity or disabled hardened runtime fails', (t) => {
  const { root } = fixture(t, {
    config: (config) => {
      config.bundle.macOS.signingIdentity = 'Developer ID Application: Example';
      config.bundle.macOS.hardenedRuntime = false;
    },
  });
  const problems = failures(preflight({ root }));
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^signing identity: .*APPLE_SIGNING_IDENTITY/);
  assert.match(problems[1], /^hardened runtime: .*notarization requires it/);
});

test('an updater without https endpoints and a key fails; none is a note', (t) => {
  const { root } = fixture(t, {
    config: (config) => {
      config.plugins = { updater: { endpoints: ['http://updates.example/x'] } };
    },
  });
  assert.match(failures(preflight({ root }))[0], /^updater: needs/);
  const plain = fixture(t);
  const updater = preflight({ root: plain.root }).findings.find(
    (finding) => finding.check === 'updater',
  );
  assert.equal(updater.level, 'note');
});

test('development-only files and outward links are listed by path', (t) => {
  const { root, app } = fixture(t, {
    bundle: (app) => {
      write(app, 'Contents/Resources/assets/index.js.map', '{}');
      write(app, 'Contents/Resources/models/ggml-tiny.en.bin', 'weights');
      write(app, 'Contents/Resources/.env.local', 'EXAMPLE=1');
      symlinkSync(tmpdir(), join(app, 'Contents', 'Resources', 'outside'));
      symlinkSync('../../../..', join(app, 'Contents', 'Resources', 'escape'));
      symlinkSync(
        'icon.icns',
        join(app, 'Contents', 'Resources', 'alias.icns'),
      );
      write(app, 'Contents/Resources/AuthKey_EXAMPLE.p8', 'fictional');
    },
  });
  const [problem] = failures(preflight({ root, app, run: tools() }));
  assert.match(problem, /^development-only files: /);
  for (const expected of [
    'index.js.map (source map)',
    'ggml-tiny.en.bin (speech model weights)',
    '.env.local (environment file)',
    'outside (link to an absolute path)',
    'escape (link leading outside the bundle)',
    'AuthKey_EXAMPLE.p8 (key, certificate or profile file)',
  ])
    assert.ok(problem.includes(expected), `${expected} in ${problem}`);
});

test('a bundle over the size tripwire fails and says which limit applied', (t) => {
  const { root, app } = fixture(t, { executable: 'x'.repeat(3 * 1024 * 1024) });
  assert.deepEqual(
    failures(preflight({ root, app, run: tools(), maxSizeMib: 2 })),
    [
      'size: 3.0 MiB is over the 2 MiB tripwire for --expect bundle; a debug build or a bundled model would explain it',
    ],
  );
});

test('build-machine home folders are counted, not printed, and fail a release', (t) => {
  const { root, app } = fixture(t, {
    executable:
      'panic at /Users/fictional-builder/.cargo/registry/src/lib.rs\0/Users/Shared/data\0',
  });
  const result = preflight({ root, app, run: tools() });
  const paths = result.findings.find(
    (finding) => finding.check === 'build paths',
  );
  assert.equal(paths.level, 'note');
  assert.match(paths.message, /1 home folder/);
  assert.doesNotMatch(paths.message, /fictional-builder/);

  for (const options of [{ strictPaths: true }, { expect: 'signed' }])
    assert.deepEqual(
      failures(preflight({ root, app, run: tools(), ...options })),
      [
        'build paths: the executable embeds paths under 1 home folder(s) of the build machine; build with `npm run build:release`, which remaps them',
      ],
    );

  const remapped = fixture(t, {
    executable: 'panic at /build/cargo/registry/src/lib.rs\0',
  });
  assert.deepEqual(
    failures(preflight({ ...remapped, run: tools(), strictPaths: true })),
    [],
  );
});

test('an executable needing a newer macOS than the bundle declares fails', (t) => {
  const { root, app } = fixture(t);
  const run = tools({ vtool: { stdout: '    minos 14.2\n' } });
  assert.match(
    failures(preflight({ root, app, run }))[0],
    /^architectures: arm64; the executable needs macOS 14\.2 but the bundle declares 13\.0/,
  );
});

test('--expect signed accepts Developer ID with runtime, timestamp and matching entitlements', (t) => {
  const { root, app } = fixture(t);
  const result = preflight({ root, app, expect: 'signed', run: tools() });
  assert.deepEqual(failures(result), []);
});

test('--expect signed rejects ad-hoc, unverifiable and widened signatures', (t) => {
  const { root, app } = fixture(t);
  const adhoc = preflight({
    root,
    app,
    expect: 'signed',
    run: tools({ display: { stderr: AD_HOC } }),
  });
  assert.deepEqual(failures(adhoc), [
    'signature: it is ad-hoc, not Developer ID Application; no team identifier; no secure timestamp',
  ]);

  const unsigned = preflight({
    root,
    app,
    expect: 'signed',
    run: tools({
      display: {
        status: 1,
        stderr: 'Orchard.app: code object is not signed at all\n',
      },
      verify: { status: 1, stderr: 'code object is not signed at all\n' },
      entitlements: { stdout: '' },
    }),
  });
  assert.match(failures(unsigned)[0], /^signature: it is unsigned/);
  assert.match(failures(unsigned)[1], /^entitlements in the signature: /);

  const widened = preflight({
    root,
    app,
    expect: 'signed',
    run: tools({
      entitlements: {
        stdout: plist({
          [MICROPHONE]: true,
          'com.apple.security.cs.disable-library-validation': true,
        }),
      },
    }),
  });
  assert.match(
    failures(widened)[0],
    /^entitlements in the signature: the signature carries \[com\.apple\.security\.cs\.disable-library-validation, /,
  );

  const tampered = preflight({
    root,
    app,
    expect: 'signed',
    run: tools({
      verify: {
        status: 1,
        stderr: 'a sealed resource is missing or invalid\n',
      },
    }),
  });
  assert.match(
    failures(tampered)[0],
    /codesign --verify failed: a sealed resource/,
  );
});

test('--expect notarized needs a stapled ticket and a Notarized Developer ID verdict', (t) => {
  const { root, app } = fixture(t);
  assert.deepEqual(
    failures(preflight({ root, app, expect: 'notarized', run: tools() })),
    [],
  );
  const result = preflight({
    root,
    app,
    expect: 'notarized',
    run: tools({
      stapler: { status: 65, stdout: 'does not have a ticket stapled to it\n' },
      spctl: {
        status: 3,
        stderr: 'rejected\nsource=Unnotarized Developer ID\n',
      },
    }),
  });
  assert.deepEqual(failures(result), [
    'notarization ticket: no valid stapled ticket (`xcrun stapler validate` failed)',
    'Gatekeeper: not accepted as Notarized Developer ID: source=Unnotarized Developer ID',
  ]);
});

test('release expectations fail, not skip, where the macOS tools are absent', (t) => {
  const { root, app } = fixture(t);
  const absent = () => ({
    status: null,
    stdout: '',
    stderr: '',
    missing: true,
  });
  const local = preflight({ root, app, run: absent });
  assert.deepEqual(failures(local), []);
  const signed = failures(
    preflight({ root, app, expect: 'signed', run: absent }),
  );
  assert.ok(
    signed.some((problem) =>
      problem.startsWith('architectures: not inspected'),
    ),
  );
  assert.ok(
    signed.some((problem) => problem.startsWith('signature: not inspected')),
  );
});

test('property lists: entities, nesting and binary input', () => {
  assert.deepEqual(
    parsePlist(
      '<plist><dict><key>a &amp; b</key><string>x &lt; &#65;</string><key>list</key><array><integer>3</integer><false/><dict/></array></dict></plist>',
    ),
    { 'a & b': 'x < A', list: [3, false, {}] },
  );
  assert.throws(() => parsePlist('bplist00\u0000'), /binary property list/);
  assert.throws(
    () => parsePlist('<plist><dict><key>a</key></dict></plist>'),
    /unexpected/,
  );
});

test('signature fields are read from codesign output', () => {
  assert.deepEqual(parseSignature('x: code object is not signed at all'), {
    signed: false,
  });
  const linker = parseSignature(
    'Identifier=orchard-0123\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0\nSignature=adhoc\nTeamIdentifier=not set\n',
  );
  assert.equal(linker.linkerSigned, true);
  assert.equal(linker.adhoc, true);
  assert.equal(linker.teamId, undefined);
  const developer = parseSignature(DEVELOPER_ID);
  assert.equal(developer.hardenedRuntime, true);
  assert.equal(developer.teamId, 'EXAMPLE123');
  assert.equal(developer.authorities.length, 3);
});

test('command line: usage errors exit 2, failures 1, and this repository passes', (t) => {
  assert.throws(
    () => parseArguments(['--expect', 'shipped']),
    /bundle, signed or notarized/,
  );
  assert.throws(() => parseArguments(['--expect', 'signed']), /needs the path/);
  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  const missing = run(join(tmpdir(), 'no-such-bundle.app'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /does not exist/);

  const { root } = fixture(t, { cargoVersion: '9.9.9' });
  const drift = run('--root', root);
  assert.equal(drift.status, 1);
  assert.match(drift.stdout, /FAIL {2}version: sources disagree/);

  const repository = run();
  assert.equal(repository.status, 0, repository.stdout + repository.stderr);
  assert.match(repository.stdout, /configuration only; no bundle given/);
});

test('each signature weakness is named on its own', (t) => {
  const { root, app } = fixture(t);
  const signed = (overrides) =>
    failures(preflight({ root, app, expect: 'signed', run: tools(overrides) }));

  assert.deepEqual(
    signed({
      display: { stderr: DEVELOPER_ID.replace('(runtime)', '(none)') },
    }),
    ['signature: hardened runtime flag is missing'],
  );
  assert.deepEqual(
    signed({
      display: {
        stderr: DEVELOPER_ID.replace(
          /^Timestamp=.*$/m,
          'Signed Time=1 Jan 2030',
        ),
      },
    }),
    ['signature: no secure timestamp'],
  );
  assert.deepEqual(
    signed({
      display: {
        stderr: DEVELOPER_ID.replace(
          'Identifier=org.example.orchard',
          'Identifier=orchard-0123',
        ),
      },
    }),
    ['signature: signed as orchard-0123, bundle is org.example.orchard'],
  );
  // A certificate merely named like a Developer ID one does not chain to Apple.
  assert.deepEqual(signed({ requirement: { status: 3 } }), [
    "signature: the certificate chain does not meet Apple's Developer ID requirement",
  ]);
});

test('a signature codesign cannot read is reported as not inspected', (t) => {
  const { root, app } = fixture(t);
  const display = {
    status: 1,
    stderr: 'Orchard.app: bundle format unrecognized, invalid, or unsuitable\n',
  };
  const local = preflight({ root, app, run: tools({ display }) });
  const signature = local.findings.find(
    (finding) => finding.check === 'signature',
  );
  assert.equal(signature.level, 'note');
  assert.match(
    signature.message,
    /could not be inspected: .*bundle format unrecognized/,
  );
  assert.match(
    failures(
      preflight({ root, app, expect: 'signed', run: tools({ display }) }),
    )[0],
    /^signature: could not be inspected/,
  );
});

test('Gatekeeper accepting a signed but unnotarized app is not a pass', (t) => {
  const { root, app } = fixture(t);
  const run = tools({
    spctl: { status: 0, stderr: 'accepted\nsource=Developer ID\n' },
  });
  assert.deepEqual(
    failures(preflight({ root, app, expect: 'notarized', run })),
    ['Gatekeeper: not accepted as Notarized Developer ID: source=Developer ID'],
  );
});

test('a bundle without its executable, or with an unreadable Info.plist, fails clearly', (t) => {
  const missing = fixture(t, {
    info: (info) => {
      info.CFBundleExecutable = 'absent';
    },
  });
  assert.deepEqual(failures(preflight({ ...missing, run: tools() })), [
    'executable: Contents/MacOS/absent is missing',
  ]);
  const binary = fixture(t, {
    bundle: (app) => write(app, 'Contents/Info.plist', 'bplist00'),
  });
  assert.match(
    failures(preflight({ ...binary, run: tools() }))[0],
    /^bundle: Contents\/Info\.plist: binary property list/,
  );
});

test('the release size tripwire is lower than the local one', (t) => {
  const { root, app } = fixture(t, {
    executable: 'x'.repeat(41 * 1024 * 1024),
  });
  assert.deepEqual(failures(preflight({ root, app, run: tools() })), []);
  assert.match(
    failures(preflight({ root, app, expect: 'signed', run: tools() }))[0],
    /^size: 41\.0 MiB is over the 40 MiB tripwire for --expect signed/,
  );
});

test('manifests with arrays before the version and Windows line endings are read', (t) => {
  const { root } = fixture(t);
  write(
    root,
    'src-tauri/Cargo.toml',
    '[package]\nname = "orchard"\nauthors = ["A Fictional Grower"]\nversion = \'1.4.2\'\n\n[dependencies]\nversion = "9.9.9"\n',
  );
  write(
    root,
    'src-tauri/Cargo.lock',
    '[[package]]\r\nname = "orchard"\r\nversion = "1.4.2"\r\n',
  );
  write(
    root,
    'src-tauri/NOTICES.txt',
    `Fictional notices\n${inputsLine(root)}\n`,
  );
  assert.deepEqual(failures(preflight({ root })), []);
});

test('configuration this check cannot read fails by name instead of passing', (t) => {
  const merged = fixture(t);
  write(merged.root, 'src-tauri/tauri.macos.conf.json', '{}');
  assert.match(
    failures(preflight({ root: merged.root }))[0],
    /^configuration: cannot be read: src-tauri\/tauri\.macos\.conf\.json exists/,
  );
  const updater = fixture(t, {
    config: (config) => {
      config.plugins = {
        updater: { endpoints: 'https://updates.example/x', pubkey: 'k' },
      };
    },
  });
  assert.match(
    failures(preflight({ root: updater.root }))[0],
    /^updater: needs/,
  );
  const silent = fixture(t);
  write(silent.root, 'src-tauri/Info.plist', plist({}));
  assert.deepEqual(failures(preflight({ root: silent.root })), [
    'entitlements: com.apple.security.device.audio-input needs NSMicrophoneUsageDescription in src-tauri/Info.plist',
  ]);
  const blank = fixture(t);
  write(
    blank.root,
    'src-tauri/Info.plist',
    plist({ NSMicrophoneUsageDescription: ' ' }),
  );
  assert.deepEqual(failures(preflight({ root: blank.root })), [
    'usage descriptions: empty in src-tauri/Info.plist: NSMicrophoneUsageDescription',
  ]);
});

test('third-party notices must exist and match the lockfiles they record', (t) => {
  const missing = fixture(t, { notices: null });
  assert.deepEqual(failures(preflight({ root: missing.root })), [
    'third-party notices: src-tauri/NOTICES.txt is missing; run `npm run notices`',
  ]);

  const stale = fixture(t);
  write(
    stale.root,
    'package-lock.json',
    JSON.stringify({
      version: '1.4.2',
      packages: { '': { version: '1.4.2' }, 'node_modules/new': {} },
    }),
  );
  assert.deepEqual(failures(preflight({ root: stale.root })), [
    'third-party notices: src-tauri/NOTICES.txt is stale: a lockfile changed after it was generated; run `npm run notices`',
  ]);

  const unmarked = fixture(t, { notices: 'Hand-written notices\n' });
  assert.match(
    failures(preflight({ root: unmarked.root }))[0],
    /^third-party notices: .*records no lockfile digests/,
  );

  const unbundled = fixture(t, {
    config: (config) => delete config.bundle.macOS.files,
  });
  assert.match(
    failures(preflight({ root: unbundled.root }))[0],
    /^third-party notices: tauri\.conf\.json does not place Resources\/THIRD-PARTY-NOTICES\.txt in the bundle/,
  );
});

test('a bundle without the current notices fails', (t) => {
  const absent = fixture(t, {
    bundle: (app) =>
      rmSync(join(app, 'Contents/Resources/THIRD-PARTY-NOTICES.txt')),
  });
  assert.deepEqual(failures(preflight({ ...absent, run: tools() })), [
    'third-party notices in the app: Contents/Resources/THIRD-PARTY-NOTICES.txt is missing from the bundle',
  ]);
  const old = fixture(t, {
    bundle: (app) =>
      write(
        app,
        'Contents/Resources/THIRD-PARTY-NOTICES.txt',
        'From an earlier build\n',
      ),
  });
  assert.match(
    failures(preflight({ ...old, run: tools() }))[0],
    /^third-party notices in the app: .*differs from the repository's copy/,
  );
});

test('a development feature switched on by the configuration fails', (t) => {
  const byDefault = fixture(t);
  write(
    byDefault.root,
    'src-tauri/Cargo.toml',
    [
      '[package]',
      'name = "orchard"',
      'version = "1.4.2"',
      '',
      '[features]',
      '# Fictional: the default turns on a feature that turns on the spike.',
      'default = ["capture"]',
      'capture = ["native-audio-spike", "dep:fictional-capture"]',
      'native-audio-spike = [',
      '  "dep:fictional-spike",',
      ']',
      '',
      '[dependencies]',
      '',
    ].join('\n'),
  );
  assert.deepEqual(failures(preflight({ root: byDefault.root })), [
    "development features: native-audio-spike is switched on by the crate's default features or tauri.conf.json build.features; a release must not include it",
  ]);

  const byTauri = fixture(t, {
    config: (config) => {
      config.build = { features: ['native-audio-spike'] };
    },
  });
  assert.match(
    failures(preflight({ root: byTauri.root }))[0],
    /^development features: native-audio-spike is switched on/,
  );

  const declaredOnly = fixture(t);
  write(
    declaredOnly.root,
    'src-tauri/Cargo.toml',
    '[package]\nname = "orchard"\nversion = "1.4.2"\n\n[features]\nnative-audio-spike = ["dep:fictional-spike"]\nlocal-whisper = ["dep:fictional-whisper"]\n',
  );
  assert.deepEqual(failures(preflight({ root: declaredOnly.root })), []);
});

test("an executable that loads the development feature's framework fails", (t) => {
  const expected =
    'development features in the app: the executable loads ScreenCaptureKit, which only native-audio-spike links; it was built with that development feature';
  for (const libraries of [
    [SYSTEM, [SPIKE]],
    [SYSTEM, [SPIKE, true]],
  ]) {
    const { root, app } = fixture(t, { libraries });
    assert.deepEqual(failures(preflight({ root, app, run: tools() })), [
      expected,
    ]);
  }
  const mixed = fixture(t, {
    binary: universal(machO([SYSTEM]), machO([SYSTEM, [SPIKE]])),
  });
  assert.deepEqual(failures(preflight({ ...mixed, run: tools() })), [expected]);

  const plain = fixture(t, {
    libraries: [
      SYSTEM,
      [
        '/System/Library/Frameworks/AVFoundation.framework/Versions/A/AVFoundation',
      ],
      [
        '/System/Library/Frameworks/ScreenCaptureKitHelper.framework/Versions/A/ScreenCaptureKitHelper',
      ],
    ],
  });
  const result = preflight({ ...plain, run: tools() });
  assert.deepEqual(failures(result), []);
  assert.match(
    result.findings.find(
      (finding) => finding.check === 'development features in the app',
    ).message,
    /none of ScreenCaptureKit among 3 linked libraries/,
  );
});

test('an executable the check cannot read fails a release and is noted otherwise', (t) => {
  const { root, app } = fixture(t, {
    binary: Buffer.from('#!/bin/sh\necho fictional\n'),
  });
  const local = preflight({ root, app, run: tools() });
  assert.deepEqual(failures(local), []);
  assert.equal(
    local.findings.find(
      (finding) => finding.check === 'development features in the app',
    ).level,
    'note',
  );
  assert.deepEqual(
    failures(preflight({ root, app, expect: 'signed', run: tools() })),
    ['development features in the app: not inspected: not a Mach-O executable'],
  );
});

test('the framework marker stops counting once release builds link its crate', (t) => {
  const { root } = fixture(t);
  write(
    root,
    'src-tauri/NOTICES.txt',
    `Fictional notices\n${inputsLine(root)}\n\nobjc2-screen-capture-kit 0.3.2\n  Declared licence: Zlib OR Apache-2.0 OR MIT\n`,
  );
  assert.deepEqual(failures(preflight({ root })), [
    'development features: objc2-screen-capture-kit is now linked into release builds, so ScreenCaptureKit no longer shows that a bundle was built with native-audio-spike; update DEVELOPMENT_FRAMEWORKS in scripts/release-preflight.mjs',
  ]);
});
