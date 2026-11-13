// Pre-flight for a macOS release candidate. It reads the repository's release
// configuration and, when given a built .app, the bundle itself, and fails
// with a named reason for each problem. It never signs, uploads or launches
// the app and needs no credentials. The default and --expect signed checks
// work offline; --expect notarized runs `stapler validate`, which asks Apple's
// ticket service about the artifact.
//
//   node scripts/release-preflight.mjs                     configuration only
//   node scripts/release-preflight.mjs path/to/TalkQTE.app  plus the bundle
//   node scripts/release-preflight.mjs --expect signed path/to/TalkQTE.app
//   node scripts/release-preflight.mjs --expect notarized path/to/TalkQTE.app
//
// --expect bundle (default) reports the signature without judging it.
// --expect signed requires a Developer ID signature with the hardened runtime.
// --expect notarized also requires a stapled ticket and Gatekeeper's verdict.
// --max-size-mib N overrides the size tripwire; --root DIR reads another tree.
// --strict-paths fails on build-machine home folders in the executable, as
// --expect signed and notarized always do.
//
// A pass is evidence about one artifact on the Mac that ran the check. It is
// not a clean-machine installation test; see docs/release-path.md.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { NOTICES_IN_BUNDLE, staleReason } from './third-party-notices.mjs';

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIB = 1024 * 1024;

/** Entitlements the app may request. Adding one is a reviewed change here and
 * in docs/release-path.md, because each widens what a signed build may do. */
export const ALLOWED_ENTITLEMENTS = ['com.apple.security.device.audio-input'];

/** Usage description each entitlement needs before macOS will show a prompt. */
const USAGE_FOR_ENTITLEMENT = {
  'com.apple.security.device.audio-input': 'NSMicrophoneUsageDescription',
};

/** Size tripwires, not budgets: one arm64 debug bundle measured 46.0 MiB and
 * one arm64 release bundle 15.3 MiB (docs/operating-estimates.md). */
export const SIZE_LIMIT_MIB = { bundle: 80, signed: 40, notarized: 40 };

/** Files that belong to a checkout or a developer's machine, not a release. */
const DEVELOPMENT_ONLY = [
  [/^\.DS_Store$/, 'Finder metadata'],
  [/^\.env(\..*)?$/, 'environment file'],
  [/^\.git/, 'version-control data'],
  [/^node_modules$/, 'dependency folder'],
  [/\.map$/, 'source map'],
  [/\.(tsx?|rs)$/, 'source file'],
  [/^\.npmrc$/, 'package manager configuration'],
  [
    /\.(pem|key|p8|p12|pfx|cer|mobileprovision)$/,
    'key, certificate or profile file',
  ],
  [/\.(log|tsbuildinfo)$/, 'build or log output'],
  [/\.dSYM$/, 'debug symbols'],
  [/^ggml-.*\.bin$|\.(gguf|ggml)$/, 'speech model weights'],
  [/\.(sqlite|db)(-.*)?$/, 'database file'],
];

/** Apple's requirement for a Developer ID Application signature: issued under
 * Apple's root, through the Developer ID authority, to a Developer ID leaf. */
const DEVELOPER_ID_REQUIREMENT =
  'anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';

/** Cargo features for development only. A release must not compile them in:
 * `native-audio-spike` adds application-audio capture code paths that are not
 * part of the reviewed release. */
export const DEVELOPMENT_FEATURES = ['native-audio-spike'];

/** The `[features]` table of a Cargo.toml as { feature: [entries] }. */
export function cargoFeatureTable(manifest) {
  const table =
    /^\[features\][^\n]*\n((?:(?!\[)[^\n]*(?:\n|$))*)/m.exec(manifest)?.[1] ??
    '';
  const uncommented = table.replace(/#[^\n]*/g, '');
  const features = {};
  for (const [, name, items] of uncommented.matchAll(
    /^\s*([A-Za-z0-9_-]+)\s*=\s*\[([^\]]*)\]/gm,
  ))
    features[name] = [...items.matchAll(/["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
  return features;
}

/** Every feature switched on by `start`, following features that switch on
 * others. `dep:` entries and `crate/feature` entries name dependencies, not
 * features of this crate, and are not followed. */
export function featureClosure(table, start) {
  const enabled = new Set();
  const pending = [...start];
  while (pending.length) {
    const name = pending.pop();
    if (enabled.has(name)) continue;
    enabled.add(name);
    for (const entry of table[name] ?? [])
      if (!entry.startsWith('dep:') && !entry.includes('/'))
        pending.push(entry);
  }
  return enabled;
}

/** Development features a plain build of this configuration would include:
 * the crate's default features, and Tauri's `build.features`. */
export function configuredDevelopmentFeatures(manifest, config) {
  const table = cargoFeatureTable(manifest);
  const start = [
    ...(table.default ? ['default'] : []),
    ...(Array.isArray(config.build?.features) ? config.build.features : []),
  ];
  const enabled = featureClosure(table, start);
  return DEVELOPMENT_FEATURES.filter((name) => enabled.has(name));
}

/** Frameworks only a development feature links, keyed by that feature. The
 * crate that links ScreenCaptureKit is an optional dependency that only
 * native-audio-spike turns on, so a release executable loading it was built
 * with the feature. The notices check below keeps this true: it fails if that
 * crate ever appears among the crates a release links. */
export const DEVELOPMENT_FRAMEWORKS = {
  'native-audio-spike': {
    framework: 'ScreenCaptureKit',
    crate: 'objc2-screen-capture-kit',
  },
};

const DYLIB_COMMANDS = new Set([
  0xc, // LC_LOAD_DYLIB
  0x80000018, // LC_LOAD_WEAK_DYLIB
  0x8000001f, // LC_REEXPORT_DYLIB
  0x20, // LC_LAZY_LOAD_DYLIB
  0x80000023, // LC_LOAD_UPWARD_DYLIB
]);

/** The libraries a Mach-O executable asks the loader for, from its load
 * commands, across every architecture of a universal file. Throws for
 * anything that is not a little-endian Mach-O. */
export function linkedLibraries(buffer) {
  const slices = [];
  const fat = buffer.length >= 8 ? buffer.readUInt32BE(0) : 0;
  if (fat === 0xcafebabe || fat === 0xcafebabf) {
    const wide = fat === 0xcafebabf;
    const count = buffer.readUInt32BE(4);
    for (let index = 0; index < count; index++) {
      const at = 8 + index * (wide ? 32 : 20);
      if (at + (wide ? 32 : 20) > buffer.length)
        throw new Error('universal header is truncated');
      const offset = wide
        ? Number(buffer.readBigUInt64BE(at + 8))
        : buffer.readUInt32BE(at + 8);
      const size = wide
        ? Number(buffer.readBigUInt64BE(at + 16))
        : buffer.readUInt32BE(at + 12);
      if (offset + size > buffer.length)
        throw new Error('universal slice lies outside the file');
      slices.push(buffer.subarray(offset, offset + size));
    }
  } else slices.push(buffer);

  const libraries = new Set();
  for (const slice of slices) {
    const magic = slice.length >= 28 ? slice.readUInt32LE(0) : 0;
    if (magic !== 0xfeedfacf && magic !== 0xfeedface)
      throw new Error('not a Mach-O executable');
    const commands = slice.readUInt32LE(16);
    let at = magic === 0xfeedfacf ? 32 : 28;
    for (let index = 0; index < commands; index++) {
      if (at + 8 > slice.length) throw new Error('load commands are truncated');
      const command = slice.readUInt32LE(at);
      const size = slice.readUInt32LE(at + 4);
      if (size < 8 || at + size > slice.length)
        throw new Error('a load command has an impossible size');
      if (DYLIB_COMMANDS.has(command)) {
        const name = at + slice.readUInt32LE(at + 8);
        const end = slice.indexOf(0, name);
        libraries.add(
          slice.toString(
            'utf8',
            name,
            end < 0 || end > at + size ? at + size : end,
          ),
        );
      }
      at += size;
    }
  }
  return [...libraries].sort();
}

const ok = (check, message) => ({ level: 'ok', check, message });
const fail = (check, message) => ({ level: 'fail', check, message });
const note = (check, message) => ({ level: 'note', check, message });

/** An XML property list as plain values. Binary lists are refused by name. */
export function parsePlist(text) {
  if (text.startsWith('bplist'))
    throw new Error(
      'binary property list; convert a copy with `plutil -convert xml1`',
    );
  const tokens = text.match(/<[^>]+>|[^<]+/g) ?? [];
  let index = 0;
  const decode = (raw) =>
    raw.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity) => {
      const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
      const lower = entity.toLowerCase();
      if (named[lower]) return named[lower];
      return String.fromCodePoint(
        lower.startsWith('#x')
          ? parseInt(lower.slice(2), 16)
          : Number(lower.slice(1)),
      );
    });
  const next = () => {
    while (
      index < tokens.length &&
      (/^\s*$/.test(tokens[index]) || /^<([?!]|\/?plist\b)/.test(tokens[index]))
    )
      index++;
    return tokens[index++];
  };
  const text_ = (type) => {
    let raw = '';
    while (index < tokens.length && !tokens[index].startsWith('<'))
      raw += tokens[index++];
    if (tokens[index++] !== `</${type}>`)
      throw new Error(`unterminated <${type}> in property list`);
    return decode(raw);
  };
  const value = (tag = next()) => {
    const match = /^<([a-z]+)\s*(\/?)>$/.exec(tag ?? '');
    if (!match) throw new Error(`unexpected ${tag ?? 'end'} in property list`);
    const [, type, empty] = match;
    if (type === 'true') return true;
    if (type === 'false') return false;
    if (type === 'dict') {
      const dict = {};
      while (!empty) {
        const child = next();
        if (child === '</dict>') break;
        if (child !== '<key>')
          throw new Error(`expected a key, found ${child ?? 'end'}`);
        const key = text_('key');
        dict[key] = value();
      }
      return dict;
    }
    if (type === 'array') {
      const list = [];
      while (!empty) {
        const child = next();
        if (child === '</array>') break;
        list.push(value(child));
      }
      return list;
    }
    if (['string', 'integer', 'real', 'date', 'data'].includes(type)) {
      const raw = empty ? '' : text_(type);
      return type === 'integer' || type === 'real' ? Number(raw) : raw;
    }
    throw new Error(`unsupported <${type}> in property list`);
  };
  const root = value();
  if (root === null || typeof root !== 'object' || Array.isArray(root))
    throw new Error('property list does not hold a dictionary');
  return root;
}

/** The fields of `codesign --display --verbose=4` this check relies on. */
export function parseSignature(text) {
  if (/not signed at all/.test(text)) return { signed: false };
  const field = (name) =>
    new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1].trim();
  const flags =
    /flags=0x[0-9a-f]+\(([^)]*)\)/i.exec(text)?.[1].split(',') ?? [];
  const team = field('TeamIdentifier');
  const timestamp = field('Timestamp');
  return {
    signed: true,
    identifier: field('Identifier'),
    authorities: [...text.matchAll(/^Authority=(.*)$/gm)].map((match) =>
      match[1].trim(),
    ),
    adhoc: flags.includes('adhoc') || field('Signature') === 'adhoc',
    linkerSigned: flags.includes('linker-signed'),
    hardenedRuntime: flags.includes('runtime'),
    timestamp: timestamp && timestamp !== 'none' ? timestamp : undefined,
    teamId: team && team !== 'not set' ? team : undefined,
  };
}

const compareVersions = (left, right) => {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let part = 0; part < Math.max(a.length, b.length); part++) {
    const difference = (a[part] ?? 0) - (b[part] ?? 0);
    if (difference) return difference;
  }
  return 0;
};

function readSources(root) {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const json = (path) => JSON.parse(read(path));
  const config = json('src-tauri/tauri.conf.json');
  const lock = json('package-lock.json');
  if (existsSync(join(root, 'src-tauri/tauri.macos.conf.json')))
    throw new Error(
      'src-tauri/tauri.macos.conf.json exists; Tauri merges it into macOS builds and this check does not read it yet',
    );
  // The [package] table of Cargo.toml, up to the next table header.
  const manifest =
    /^\[package\][^\n]*\n((?:(?!\[)[^\n]*(?:\n|$))*)/m.exec(
      read('src-tauri/Cargo.toml'),
    )?.[1] ?? '';
  const field = (name) =>
    new RegExp(`^\\s*${name}\\s*=\\s*["']([^"']+)["']`, 'm').exec(
      manifest,
    )?.[1];
  const cargo = field('version');
  const crate = field('name');
  const locked = new RegExp(
    `^name = "${crate}"\\r?\\nversion = "([^"]+)"`,
    'm',
  ).exec(read('src-tauri/Cargo.lock'))?.[1];
  const developmentFeatures = configuredDevelopmentFeatures(
    read('src-tauri/Cargo.toml'),
    config,
  );
  const entitlementsPath = config.bundle?.macOS?.entitlements;
  const noticesPath = config.bundle?.macOS?.files?.[NOTICES_IN_BUNDLE];
  return {
    config,
    developmentFeatures,
    noticesPath,
    notices:
      noticesPath && existsSync(join(root, 'src-tauri', noticesPath))
        ? read(join('src-tauri', noticesPath))
        : undefined,
    versions: [
      ['package.json', json('package.json').version],
      ['package-lock.json', lock.version],
      ['package-lock.json root package', lock.packages?.['']?.version],
      ['src-tauri/Cargo.toml', cargo],
      ['src-tauri/Cargo.lock', locked],
      ['src-tauri/tauri.conf.json', config.version],
    ],
    entitlementsPath,
    entitlements:
      entitlementsPath && existsSync(join(root, 'src-tauri', entitlementsPath))
        ? parsePlist(read(join('src-tauri', entitlementsPath)))
        : undefined,
    usage: existsSync(join(root, 'src-tauri/Info.plist'))
      ? usageDescriptions(parsePlist(read('src-tauri/Info.plist')))
      : {},
  };
}

const usageDescriptions = (plist) =>
  Object.fromEntries(
    Object.entries(plist).filter(([key]) =>
      /^NS\w+UsageDescription$/.test(key),
    ),
  );

/** Checks that need only the repository: what a build would be made from. */
export function checkSources(root = REPOSITORY) {
  let sources;
  try {
    sources = readSources(root);
  } catch (error) {
    return {
      findings: [fail('configuration', `cannot be read: ${error.message}`)],
    };
  }
  const { config, versions, entitlements, entitlementsPath, usage } = sources;
  const findings = [];

  findings.push(
    sources.developmentFeatures.length
      ? fail(
          'development features',
          `${sources.developmentFeatures.join(', ')} is switched on by the crate's default features or tauri.conf.json build.features; a release must not include it`,
        )
      : ok(
          'development features',
          `${DEVELOPMENT_FEATURES.join(', ')} not switched on by default or by tauri.conf.json`,
        ),
  );

  const missing = versions.filter(([, version]) => !version);
  const distinct = new Set(versions.map(([, version]) => version));
  if (missing.length)
    findings.push(
      fail(
        'version',
        `no version found in ${missing.map(([source]) => source).join(', ')}`,
      ),
    );
  else if (distinct.size > 1)
    findings.push(
      fail(
        'version',
        `sources disagree: ${versions
          .map(([source, version]) => `${source} ${version}`)
          .join('; ')}`,
      ),
    );
  else if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(config.version))
    findings.push(
      fail('version', `${config.version} is not a MAJOR.MINOR.PATCH version`),
    );
  else
    findings.push(
      ok('version', `${config.version} in all ${versions.length} places`),
    );

  const identifier = config.identifier ?? '';
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(identifier))
    findings.push(
      fail(
        'bundle identifier',
        `"${identifier}" is not a reverse-domain name with at least three parts`,
      ),
    );
  else if (/\.app$/i.test(identifier))
    findings.push(
      fail(
        'bundle identifier',
        `"${identifier}" ends in .app, which clashes with the bundle extension`,
      ),
    );
  else findings.push(ok('bundle identifier', identifier));

  const macOS = config.bundle?.macOS ?? {};
  if (macOS.signingIdentity && macOS.signingIdentity !== '-')
    findings.push(
      fail(
        'signing identity',
        'tauri.conf.json names a signing identity; supply it through APPLE_SIGNING_IDENTITY at build time instead of committing it',
      ),
    );
  if (macOS.hardenedRuntime === false)
    findings.push(
      fail(
        'hardened runtime',
        'tauri.conf.json turns it off; notarization requires it',
      ),
    );
  else
    findings.push(
      ok(
        'hardened runtime',
        "not turned off in tauri.conf.json; Tauri's default applies it when signing",
      ),
    );
  if (!macOS.minimumSystemVersion)
    findings.push(
      fail('minimum macOS', 'tauri.conf.json states no minimumSystemVersion'),
    );

  if (!entitlementsPath)
    findings.push(
      fail('entitlements', 'tauri.conf.json names no entitlements file'),
    );
  else if (!entitlements)
    findings.push(
      fail('entitlements', `src-tauri/${entitlementsPath} does not exist`),
    );
  else {
    const problems = [];
    for (const [key, value] of Object.entries(entitlements)) {
      if (!ALLOWED_ENTITLEMENTS.includes(key))
        problems.push(`${key} is not on the reviewed list`);
      else if (value !== true) problems.push(`${key} is not set to true`);
    }
    for (const [key, usageKey] of Object.entries(USAGE_FOR_ENTITLEMENT))
      if (entitlements[key] && !usage[usageKey])
        problems.push(`${key} needs ${usageKey} in src-tauri/Info.plist`);
    findings.push(
      problems.length
        ? fail('entitlements', problems.join('; '))
        : ok(
            'entitlements',
            Object.keys(entitlements).join(', ') || 'none requested',
          ),
    );
  }

  const blank = Object.entries(usage).filter(
    ([, text]) => typeof text !== 'string' || !text.trim(),
  );
  if (blank.length)
    findings.push(
      fail(
        'usage descriptions',
        `empty in src-tauri/Info.plist: ${blank.map(([key]) => key).join(', ')}`,
      ),
    );

  const { noticesPath, notices } = sources;
  const stale = notices === undefined ? null : staleReason(notices, root);
  for (const [feature, { framework, crate }] of Object.entries(
    DEVELOPMENT_FRAMEWORKS,
  ))
    if (notices && new RegExp(`^${crate} `, 'm').test(notices))
      findings.push(
        fail(
          'development features',
          `${crate} is now linked into release builds, so ${framework} no longer shows that a bundle was built with ${feature}; update DEVELOPMENT_FRAMEWORKS in scripts/release-preflight.mjs`,
        ),
      );
  if (!noticesPath)
    findings.push(
      fail(
        'third-party notices',
        `tauri.conf.json does not place ${NOTICES_IN_BUNDLE} in the bundle`,
      ),
    );
  else if (notices === undefined)
    findings.push(
      fail(
        'third-party notices',
        `src-tauri/${noticesPath} is missing; run \`npm run notices\``,
      ),
    );
  else if (stale)
    findings.push(
      fail(
        'third-party notices',
        `src-tauri/${noticesPath} is stale: ${stale}; run \`npm run notices\``,
      ),
    );
  else
    findings.push(
      ok('third-party notices', 'generated from the current lockfiles'),
    );

  const updater = config.plugins?.updater;
  if (!updater)
    findings.push(
      note(
        'updater',
        'none configured; an update is a manual replacement of the app',
      ),
    );
  else {
    const endpoints = Array.isArray(updater.endpoints) ? updater.endpoints : [];
    const insecure = endpoints.filter((url) => !/^https:\/\//.test(`${url}`));
    if (!endpoints.length || insecure.length || !updater.pubkey)
      findings.push(
        fail(
          'updater',
          'needs at least one endpoint, only https endpoints, and a public key',
        ),
      );
    else
      findings.push(
        ok('updater', `${endpoints.length} https endpoint(s) with a key`),
      );
  }

  return { findings, sources };
}

function walk(directory) {
  const entries = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    entries.push({ path, name, stat });
    if (stat.isDirectory()) entries.push(...walk(path));
  }
  return entries;
}

const defaultRun = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    missing: result.error?.code === 'ENOENT',
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

/** Checks on a built .app against the configuration it should come from. */
export function checkBundle(app, sources, options = {}) {
  const expect = options.expect ?? 'bundle';
  const release = expect !== 'bundle';
  const run = options.run ?? defaultRun;
  const findings = [];
  const { config } = sources;

  const plistPath = join(app, 'Contents', 'Info.plist');
  if (!existsSync(plistPath))
    return [fail('bundle', `${app} has no Contents/Info.plist`)];
  let info;
  try {
    info = parsePlist(readFileSync(plistPath, 'utf8'));
  } catch (error) {
    return [fail('bundle', `Contents/Info.plist: ${error.message}`)];
  }

  const same = (check, actual, expected, source) =>
    findings.push(
      actual === expected
        ? ok(check, `${actual}`)
        : fail(check, `the bundle says ${actual}, ${source} says ${expected}`),
    );
  same(
    'bundle identifier in the app',
    info.CFBundleIdentifier,
    config.identifier,
    'tauri.conf.json',
  );
  same(
    'version in the app',
    info.CFBundleShortVersionString,
    config.version,
    'tauri.conf.json',
  );
  same(
    'minimum macOS in the app',
    info.LSMinimumSystemVersion,
    config.bundle?.macOS?.minimumSystemVersion,
    'tauri.conf.json',
  );

  if (typeof info.CFBundleExecutable !== 'string')
    delete info.CFBundleExecutable;
  const executable = join(
    app,
    'Contents',
    'MacOS',
    info.CFBundleExecutable ?? '',
  );
  const executableStat =
    info.CFBundleExecutable && existsSync(executable)
      ? lstatSync(executable)
      : undefined;
  if (!executableStat?.isFile())
    findings.push(
      fail(
        'executable',
        `Contents/MacOS/${info.CFBundleExecutable ?? '(unnamed)'} is missing`,
      ),
    );
  else if (process.platform !== 'win32' && !(executableStat.mode & 0o111))
    findings.push(fail('executable', 'is not marked executable'));
  else
    findings.push(
      ok('executable', `Contents/MacOS/${info.CFBundleExecutable}`),
    );

  const bundled = usageDescriptions(info);
  const usageProblems = [];
  for (const key of new Set([
    ...Object.keys(bundled),
    ...Object.keys(sources.usage),
  ])) {
    if (!(key in bundled))
      usageProblems.push(`${key} is missing from the bundle`);
    else if (!(key in sources.usage))
      usageProblems.push(
        `${key} is in the bundle but not in src-tauri/Info.plist`,
      );
    else if (bundled[key] !== sources.usage[key])
      usageProblems.push(`${key} differs from src-tauri/Info.plist`);
    else if (!String(bundled[key]).trim())
      usageProblems.push(`${key} is empty`);
  }
  findings.push(
    usageProblems.length
      ? fail('usage descriptions in the app', usageProblems.join('; '))
      : ok(
          'usage descriptions in the app',
          Object.keys(bundled).join(', ') || 'none',
        ),
  );

  const bundledNotices = join(app, 'Contents', ...NOTICES_IN_BUNDLE.split('/'));
  findings.push(
    !existsSync(bundledNotices)
      ? fail(
          'third-party notices in the app',
          `Contents/${NOTICES_IN_BUNDLE} is missing from the bundle`,
        )
      : readFileSync(bundledNotices, 'utf8') !== sources.notices
        ? fail(
            'third-party notices in the app',
            `Contents/${NOTICES_IN_BUNDLE} differs from the repository's copy; rebuild after \`npm run notices\``,
          )
        : ok('third-party notices in the app', `Contents/${NOTICES_IN_BUNDLE}`),
  );

  const entries = walk(app);
  const realApp = realpathSync(app);
  const unwanted = [];
  for (const { path, name, stat } of entries) {
    const shown = relative(app, path);
    const reason = DEVELOPMENT_ONLY.find(([pattern]) => pattern.test(name));
    if (reason) unwanted.push(`${shown} (${reason[1]})`);
    else if (stat.isSymbolicLink()) {
      const target = existsSync(path) ? realpathSync(path) : undefined;
      if (isAbsolute(readlinkSync(path)))
        unwanted.push(`${shown} (link to an absolute path)`);
      else if (!target || !(target + sep).startsWith(realApp + sep))
        unwanted.push(`${shown} (link leading outside the bundle)`);
    }
  }
  findings.push(
    unwanted.length
      ? fail('development-only files', unwanted.join('; '))
      : ok('development-only files', `none in ${entries.length} entries`),
  );

  const bytes = entries.reduce(
    (total, { stat }) => total + (stat.isFile() ? stat.size : 0),
    0,
  );
  const limit = options.maxSizeMib ?? SIZE_LIMIT_MIB[expect];
  const size = `${(bytes / MIB).toFixed(1)} MiB`;
  findings.push(
    bytes > limit * MIB
      ? fail(
          'size',
          `${size} is over the ${limit} MiB tripwire for --expect ${expect}; a debug build or a bundled model would explain it`,
        )
      : ok('size', `${size} (tripwire ${limit} MiB)`),
  );

  if (executableStat?.isFile()) {
    const paths = new Set(
      (
        readFileSync(executable, 'latin1').match(/\/Users\/[^/\0\s"']+\//g) ??
        []
      ).filter((path) => path !== '/Users/Shared/'),
    );
    if (paths.size)
      findings.push(
        (release || options.strictPaths ? fail : note)(
          'build paths',
          `the executable embeds paths under ${paths.size} home folder(s) of the build machine; build with \`npm run build:release\`, which remaps them`,
        ),
      );
    else
      findings.push(
        ok('build paths', 'no home-folder paths in the executable'),
      );

    let libraries;
    try {
      libraries = linkedLibraries(readFileSync(executable));
    } catch (error) {
      findings.push(
        (release ? fail : note)(
          'development features in the app',
          `not inspected: ${error.message}`,
        ),
      );
    }
    if (libraries) {
      const built = Object.entries(DEVELOPMENT_FRAMEWORKS).filter(
        ([, { framework }]) =>
          libraries.some((path) => path.includes(`/${framework}.framework/`)),
      );
      findings.push(
        built.length
          ? fail(
              'development features in the app',
              built
                .map(
                  ([feature, { framework }]) =>
                    `the executable loads ${framework}, which only ${feature} links; it was built with that development feature`,
                )
                .join('; '),
            )
          : ok(
              'development features in the app',
              `none of ${Object.values(DEVELOPMENT_FRAMEWORKS)
                .map(({ framework }) => framework)
                .join(', ')} among ${libraries.length} linked libraries`,
            ),
      );
    }

    const archs = run('lipo', ['-archs', executable]);
    const build = run('vtool', ['-show-build', executable]);
    if (
      archs.missing ||
      build.missing ||
      archs.status !== 0 ||
      build.status !== 0
    )
      findings.push(
        (release ? fail : note)(
          'architectures',
          'not inspected: lipo and vtool (Xcode Command Line Tools) are needed',
        ),
      );
    else {
      const minimums = [...build.stdout.matchAll(/minos (\d+(?:\.\d+)*)/g)].map(
        (match) => match[1],
      );
      const declared = info.LSMinimumSystemVersion ?? '0';
      const newer = minimums.filter(
        (minimum) => compareVersions(minimum, declared) > 0,
      );
      findings.push(
        !minimums.length || newer.length
          ? fail(
              'architectures',
              `${archs.stdout.trim()}; the executable needs macOS ${newer.join(', ') || '(unknown)'} but the bundle declares ${declared}`,
            )
          : ok(
              'architectures',
              `${archs.stdout.trim()}; executable minimum macOS ${[...new Set(minimums)].join(', ')}`,
            ),
      );
    }
  }

  findings.push(...checkSignature(app, sources, { expect, run, info }));
  return findings;
}

function checkSignature(app, sources, { expect, run, info }) {
  const release = expect !== 'bundle';
  const shown = run('codesign', ['--display', '--verbose=4', app]);
  if (shown.missing)
    return [
      (release ? fail : note)(
        'signature',
        'not inspected: codesign is available only on macOS',
      ),
    ];
  const signature = parseSignature(`${shown.stdout}\n${shown.stderr}`);
  if (shown.status !== 0 && signature.signed)
    return [
      (release ? fail : note)(
        'signature',
        `could not be inspected: ${shown.stderr.trim().split('\n')[0] || 'codesign gave no detail'}`,
      ),
    ];
  const developerId = signature.authorities?.find((authority) =>
    authority.startsWith('Developer ID Application:'),
  );
  const kind = !signature.signed
    ? 'unsigned'
    : developerId
      ? 'Developer ID'
      : signature.linkerSigned
        ? 'ad-hoc, applied by the linker to the executable only'
        : signature.adhoc
          ? 'ad-hoc'
          : `signed by ${signature.authorities[0] ?? 'an unknown authority'}`;
  if (!release)
    return [
      note(
        'signature',
        developerId
          ? 'Developer ID; rerun with --expect signed to check it'
          : `${kind}; not a Developer ID signature, so this bundle is for local inspection only`,
      ),
    ];

  const findings = [];
  const problems = [];
  if (!developerId)
    problems.push(`it is ${kind}, not Developer ID Application`);
  if (!signature.teamId) problems.push('no team identifier');
  if (!signature.hardenedRuntime)
    problems.push('hardened runtime flag is missing');
  if (!signature.timestamp) problems.push('no secure timestamp');
  if (signature.signed && signature.identifier !== info.CFBundleIdentifier)
    problems.push(
      `signed as ${signature.identifier}, bundle is ${info.CFBundleIdentifier}`,
    );
  const verified = run('codesign', ['--verify', '--deep', '--strict', app]);
  if (verified.status !== 0)
    problems.push(
      `codesign --verify failed: ${verified.stderr.trim().split('\n')[0] || 'no detail'}`,
    );
  const chained = run('codesign', [
    '--verify',
    `-R=${DEVELOPER_ID_REQUIREMENT}`,
    app,
  ]);
  if (chained.status !== 0)
    problems.push(
      "the certificate chain does not meet Apple's Developer ID requirement",
    );
  findings.push(
    problems.length
      ? fail('signature', problems.join('; '))
      : ok(
          'signature',
          'Developer ID Application, hardened runtime, timestamped',
        ),
  );

  const embedded = run('codesign', [
    '--display',
    '--entitlements',
    '-',
    '--xml',
    app,
  ]);
  let entitlements = {};
  let unreadable;
  try {
    if (embedded.stdout.trim())
      entitlements = parsePlist(embedded.stdout.trim());
  } catch (error) {
    unreadable = error.message;
  }
  const wanted = sources.entitlements ?? {};
  const keys = (dict) => Object.keys(dict).sort();
  const equal =
    !unreadable &&
    JSON.stringify(
      keys(entitlements).map((key) => [key, entitlements[key]]),
    ) === JSON.stringify(keys(wanted).map((key) => [key, wanted[key]]));
  findings.push(
    equal
      ? ok(
          'entitlements in the signature',
          keys(entitlements).join(', ') || 'none',
        )
      : fail(
          'entitlements in the signature',
          unreadable ??
            `the signature carries [${keys(entitlements).join(', ')}], src-tauri/${sources.entitlementsPath} asks for [${keys(wanted).join(', ')}]`,
        ),
  );

  if (expect === 'notarized') {
    const stapled = run('xcrun', ['stapler', 'validate', app]);
    findings.push(
      stapled.status === 0 && !stapled.missing
        ? ok('notarization ticket', 'stapled to the app')
        : fail(
            'notarization ticket',
            'no valid stapled ticket (`xcrun stapler validate` failed)',
          ),
    );
    const assessed = run('spctl', [
      '--assess',
      '--type',
      'execute',
      '-vv',
      app,
    ]);
    const verdict = `${assessed.stdout}\n${assessed.stderr}`;
    findings.push(
      assessed.status === 0 && /source=Notarized Developer ID/.test(verdict)
        ? ok('Gatekeeper', 'accepted as Notarized Developer ID on this Mac')
        : fail(
            'Gatekeeper',
            `not accepted as Notarized Developer ID: ${verdict.trim().split('\n').pop() || 'no verdict'}`,
          ),
    );
  }
  return findings;
}

/** Runs every applicable check; `passed` is false if any finding failed. */
export function preflight({ root = REPOSITORY, app, ...options } = {}) {
  const { findings, sources } = checkSources(root);
  if (app && sources)
    try {
      findings.push(...checkBundle(app, sources, options));
    } catch (error) {
      findings.push(fail('bundle', `could not be inspected: ${error.message}`));
    }
  return {
    findings,
    passed: !findings.some((finding) => finding.level === 'fail'),
  };
}

export function parseArguments(argv) {
  const options = { expect: 'bundle' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => {
      if (index + 1 >= argv.length)
        throw new Error(`${argument} needs a value`);
      return argv[++index];
    };
    if (argument === '--expect') {
      options.expect = value();
      if (!(options.expect in SIZE_LIMIT_MIB))
        throw new Error('--expect takes bundle, signed or notarized');
    } else if (argument === '--max-size-mib') {
      options.maxSizeMib = Number(value());
      if (!(options.maxSizeMib > 0))
        throw new Error('--max-size-mib takes a positive number');
    } else if (argument === '--strict-paths') options.strictPaths = true;
    else if (argument === '--root') options.root = resolve(value());
    else if (argument.startsWith('-'))
      throw new Error(`unknown option ${argument}`);
    else if (options.app) throw new Error('give one .app path');
    else options.app = resolve(argument);
  }
  if (options.app && !existsSync(options.app))
    throw new Error(`${options.app} does not exist`);
  if (!options.app && options.expect !== 'bundle')
    throw new Error(
      `--expect ${options.expect} needs the path of a built .app`,
    );
  return options;
}

if (isMain(import.meta.url)) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`release-preflight: ${error.message}`);
    console.error(
      'usage: node scripts/release-preflight.mjs [--expect bundle|signed|notarized] [--max-size-mib N] [--strict-paths] [--root DIR] [path/to/App.app]',
    );
    process.exit(2);
  }
  const { findings, passed } = preflight(options);
  const label = { ok: 'ok  ', fail: 'FAIL', note: 'note' };
  for (const { level, check, message } of findings)
    console.log(`${label[level]}  ${check}: ${message}`);
  const failures = findings.filter(
    (finding) => finding.level === 'fail',
  ).length;
  console.log(
    passed
      ? `\nPre-flight passed for --expect ${options.expect}${options.app ? '' : ' (configuration only; no bundle given)'}. This is not an installation test.`
      : `\n${failures} pre-flight check(s) failed.`,
  );
  process.exit(passed ? 0 : 1);
}
