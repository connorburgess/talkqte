// Subscription and offline lab boundary. Caps count CLI/runner dispatch
// attempts, never underlying HTTP/model requests or auth recovery.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const CODEX_SUPPORT = Object.freeze({
  provider: 'codex',
  inspectedVersion: '0.163.0',
  model: 'gpt-6.1-sol',
  efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  actualProviderRequestBound: false,
  subscriptionAvailable: true,
  featureCatalogHash:
    '3001caca32452e98a3d61e98a6ff3cdc7efc160b1fd2fd593928c15e8b06aca4',
  reason:
    'The CLI can issue another model request after rejecting a tool call.',
});

// Compare names and lifecycle stages, independent of user-configured defaults.
// New/removed capabilities require a new audit; do not silently disable just
// the capabilities an older adapter happens to know about.
export function codexFeatureDisables(catalog) {
  if (typeof catalog !== 'string') throw codexFailure('configuration-mismatch');
  const rows = catalog
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s{2,}/));
  if (
    rows.some(
      (row) =>
        row.length !== 3 ||
        !/^[a-z0-9_.]+$/.test(row[0]) ||
        !['true', 'false'].includes(row[2]),
    )
  )
    throw codexFailure('configuration-mismatch');
  const hash = createHash('sha256')
    .update(rows.map((row) => row.slice(0, 2).join(':')).join('\n'))
    .digest('hex');
  if (hash !== CODEX_SUPPORT.featureCatalogHash)
    throw codexFailure('configuration-mismatch');
  return rows
    .filter((row) => !['removed', 'deprecated'].includes(row[1]))
    .flatMap(([name]) => ['--disable', name]);
}

// A single profile for the fake-provider audit and proposed subscription
// runner. Auth and endpoint are the only deliberate audit differences.
export function codexExecArgs({
  cwd,
  schemaFile,
  catalog,
  model,
  effort,
  offlineBaseUrl,
} = {}) {
  if (
    typeof cwd !== 'string' ||
    !cwd ||
    typeof schemaFile !== 'string' ||
    !schemaFile ||
    model !== CODEX_SUPPORT.model ||
    !CODEX_SUPPORT.efforts.includes(effort)
  )
    throw codexFailure('configuration');
  const provider =
    offlineBaseUrl === undefined
      ? [
          '-c',
          'model_provider="lab_subscription"',
          '-c',
          'model_providers.lab_subscription={name="Lab subscription",wire_api="responses",requires_openai_auth=true,request_max_retries=0,stream_max_retries=0,supports_websockets=false}',
        ]
      : (() => {
          if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/v1$/.test(offlineBaseUrl))
            throw codexFailure('configuration');
          return [
            '-c',
            'model_provider="lab_offline"',
            '-c',
            `model_providers.lab_offline={name="Offline audit",base_url=${JSON.stringify(offlineBaseUrl)},wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0,supports_websockets=false}`,
          ];
        })();
  return [
    '--no-daemon',
    '--ask-for-approval',
    'never',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--model',
    model,
    '--json',
    '--color',
    'never',
    '-C',
    cwd,
    '--output-schema',
    schemaFile,
    '-c',
    'forced_login_method="chatgpt"',
    '-c',
    `model_reasoning_effort=${JSON.stringify(effort)}`,
    '-c',
    'web_search="disabled"',
    '-c',
    'tools.update_plan.enabled=false',
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'mcp_servers={}',
    ...provider,
    ...codexFeatureDisables(catalog),
    '-',
  ];
}
export function assertInspectedCodexVersion(version) {
  if (version !== `codex-cli ${CODEX_SUPPORT.inspectedVersion}`)
    throw codexFailure('unsupported-cli-version');
  // A matching version is necessary for interpreting the offline audit,
  // never permission to enable authenticated execution.
}

const MAX_BYTES = 256 * 1024;
const MAX_INPUT = 64 * 1024;
const DISABLED_CODE_MODE_NOTICE =
  'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
const ROLES = new Set([
  'generator',
  'cast',
  'listener',
  'judge',
  'cue-evaluator',
]);
const CREDENTIAL =
  /(?:API.?KEY|ACCESS.?TOKEN|AUTH.?TOKEN|BASE.?URL|PROXY|GATEWAY|PROVIDER|NODE_OPTIONS|CODEX_HOME|CONFIG_DIR|CUSTOM_HEADERS|^AWS_|GOOGLE_APPLICATION_CREDENTIALS|^AZURE_|CLOUD_ML_REGION|CLAUDE_CODE_(?:USE_|SKIP_))/i;

export function assertSubscriptionEnvironment(environment) {
  if (
    !environment ||
    typeof environment !== 'object' ||
    Object.keys(environment).some(
      (key) => environment[key] && CREDENTIAL.test(key),
    )
  )
    throw codexFailure('ambient-credentials');
}

export function snapshotLabJson(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (
        ['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) ||
        (typeof item === 'number' && !Number.isFinite(item))
      )
        throw codexFailure('invalid-request');
      return item;
    }),
  );
}

export function codexFailure(category, calls = 0) {
  return Object.assign(new Error(`Codex lab stopped: ${category}.`), {
    category,
    calls,
    exitCode: null,
    signals: [],
  });
}

// A deliberately small strict JSON Schema subset. Unsupported keywords are
// refused rather than silently ignored. The role owns semantic validation.
export function validateCodexSchema(schema, value, depth = 0) {
  if (schema && typeof schema === 'object' && Object.hasOwn(schema, 'anyOf')) {
    if (
      depth > 12 ||
      Object.keys(schema).length !== 1 ||
      !Array.isArray(schema.anyOf) ||
      schema.anyOf.length < 1 ||
      schema.anyOf.length > 8
    )
      throw codexFailure('schema');
    for (const child of schema.anyOf)
      validateCodexSchema(child, undefined, depth + 1);
    if (value === undefined) return;
    for (const child of schema.anyOf) {
      try {
        validateCodexSchema(child, value, depth + 1);
        return;
      } catch {
        /* try the next declared shape */
      }
    }
    throw codexFailure('schema');
  }
  const keywords = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'enum',
  ]);
  const types = [
    'object',
    'array',
    'string',
    'number',
    'integer',
    'boolean',
    'null',
  ];
  if (
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    depth > 12 ||
    Object.keys(schema).some((key) => !keywords.has(key))
  )
    throw codexFailure('schema');
  const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!allowed.length || allowed.some((type) => !types.includes(type)))
    throw codexFailure('schema');
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength'])
    if (
      schema[key] !== undefined &&
      (!Number.isSafeInteger(schema[key]) || schema[key] < 0)
    )
      throw codexFailure('schema');
  for (const key of ['minimum', 'maximum'])
    if (schema[key] !== undefined && !Number.isFinite(schema[key]))
      throw codexFailure('schema');
  for (const [min, max] of [
    ['minItems', 'maxItems'],
    ['minLength', 'maxLength'],
    ['minimum', 'maximum'],
  ])
    if (
      schema[min] !== undefined &&
      schema[max] !== undefined &&
      schema[min] > schema[max]
    )
      throw codexFailure('schema');
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || !schema.enum.length)
  )
    throw codexFailure('schema');
  if (allowed.includes('object')) {
    if (
      !schema.properties ||
      Array.isArray(schema.properties) ||
      typeof schema.properties !== 'object' ||
      schema.additionalProperties !== false ||
      !Array.isArray(schema.required) ||
      schema.required.some(
        (key) =>
          typeof key !== 'string' || !Object.hasOwn(schema.properties, key),
      ) ||
      new Set(schema.required).size !== schema.required.length
    )
      throw codexFailure('schema');
    for (const child of Object.values(schema.properties))
      validateCodexSchema(child, undefined, depth + 1);
  }
  if (allowed.includes('array'))
    validateCodexSchema(schema.items, undefined, depth + 1);
  // undefined means check the schema itself before any dispatch.
  if (value === undefined) return;
  const matches = (type) =>
    type === 'null'
      ? value === null
      : type === 'array'
        ? Array.isArray(value)
        : type === 'object'
          ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : type === 'integer'
            ? Number.isSafeInteger(value)
            : type === 'number'
              ? typeof value === 'number' && Number.isFinite(value)
              : typeof value === type;
  if (
    !allowed.some(matches) ||
    (schema.enum &&
      !schema.enum.some(
        (item) => JSON.stringify(item) === JSON.stringify(value),
      ))
  )
    throw codexFailure('schema');
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (
      schema.required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))
    )
      throw codexFailure('schema');
    for (const [key, item] of Object.entries(value))
      validateCodexSchema(schema.properties[key], item, depth + 1);
  } else if (Array.isArray(value)) {
    if (
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      throw codexFailure('schema');
    for (const item of value)
      validateCodexSchema(schema.items, item, depth + 1);
  } else if (typeof value === 'string') {
    if (
      value.length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? Infinity)
    )
      throw codexFailure('schema');
  } else if (
    typeof value === 'number' &&
    (value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity))
  )
    throw codexFailure('schema');
}

// Retain only one structured final message and numeric counters. Unknown
// events, tools and additional turns fail before their result is accepted.
// This is a result guard, NOT a mechanism that prevents CLI tool execution.
export function createCodexEventReader() {
  let starts = 0,
    threads = 0,
    completed = 0,
    text = null,
    usage,
    disabledNotice = false;
  const accept = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw codexFailure('protocol');
    }
    if (completed) throw codexFailure('unexpected-event');
    if (event.type === 'thread.started' && starts === 0 && ++threads === 1)
      return;
    // Pinned CLI emits this startup diagnostic even with code_mode=false.
    // It confirms the disabled host; any other error remains terminal.
    if (
      starts === 0 &&
      !disabledNotice &&
      event.type === 'item.completed' &&
      event.item?.type === 'error' &&
      event.item.message === DISABLED_CODE_MODE_NOTICE
    ) {
      disabledNotice = true;
      return;
    }
    if (event.type === 'turn.started' && ++starts === 1) return;
    if (event.type === 'item.completed' && event.item?.type === 'reasoning')
      return;
    if (
      event.type === 'item.completed' &&
      event.item?.type === 'agent_message' &&
      text === null &&
      typeof event.item.text === 'string'
    ) {
      text = event.item.text;
      return;
    }
    if (
      event.type === 'turn.completed' &&
      starts === 1 &&
      ++completed === 1 &&
      text !== null
    ) {
      usage = Object.fromEntries(
        ['input_tokens', 'output_tokens', 'cached_input_tokens']
          .filter(
            (key) =>
              Number.isSafeInteger(event.usage?.[key]) && event.usage[key] >= 0,
          )
          .map((key) => [key, event.usage[key]]),
      );
      return;
    }
    throw codexFailure('unexpected-event');
  };
  const finish = () => {
    if (starts !== 1 || completed !== 1 || text === null)
      throw codexFailure('protocol');
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw codexFailure('schema');
    }
    return { value, usage };
  };
  return { accept, finish };
}

export function parseCodexEvents(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_BYTES)
    throw codexFailure('output-limit');
  const reader = createCodexEventReader();
  for (const line of stdout.split('\n')) reader.accept(line);
  return reader.finish();
}

// Generic process supervision for offline executable stand-ins. A process
// group is terminated on abort/deadline/output overflow, including children;
// this is supervision only, not a no-tools sandbox or provider transport.
export function runBoundedCodexProcess(
  command,
  args,
  {
    cwd,
    env = {},
    input = '',
    signal,
    deadlineMs = 30000,
    maxOutputBytes = MAX_BYTES,
    onStdoutLine,
  } = {},
) {
  return new Promise((resolve, reject) => {
    if (
      typeof command !== 'string' ||
      !command ||
      !Array.isArray(args) ||
      args.some((arg) => typeof arg !== 'string') ||
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 10 ||
      deadlineMs > 60000 ||
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes < 1 ||
      maxOutputBytes > MAX_BYTES
    )
      return reject(codexFailure('configuration'));
    if (signal?.aborted) return reject(codexFailure('cancelled'));
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '',
      stderr = '',
      bytes = 0,
      partialLine = '',
      problem = null,
      killTimer;
    const killGroup = () => {
      if (child.pid)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
    };
    const stop = (category) => {
      if (problem) return;
      problem = codexFailure(category);
      if (child.pid)
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      killTimer = setTimeout(killGroup, 100);
    };
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('deadline'), deadlineMs);
    const read = (chunk, channel) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) return stop('output-limit');
      if (channel === 'stdout') {
        const decoded = stdoutDecoder.write(chunk);
        stdout += decoded;
        if (onStdoutLine && !problem) {
          partialLine += decoded;
          const lines = partialLine.split('\n');
          partialLine = lines.pop();
          try {
            for (const line of lines) onStdoutLine(line);
          } catch {
            stop('unexpected-event');
          }
        }
      } else stderr += stderrDecoder.write(chunk);
    };
    child.stdout.on('data', (chunk) => read(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => read(chunk, 'stderr'));
    child.on('error', () => {
      problem ??= codexFailure('process');
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', async (code) => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (onStdoutLine && partialLine && !problem) {
        try {
          onStdoutLine(partialLine);
        } catch {
          problem = codexFailure('unexpected-event');
        }
      }
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      // The parent can exit before its descendants; still retire its group.
      killGroup();
      if (child.pid) {
        let present = true;
        for (let n = 0; n < 100; n++) {
          try {
            process.kill(-child.pid, 0);
          } catch (error) {
            if (error.code === 'ESRCH') present = false;
            break;
          }
          await delay(10);
        }
        if (present) problem = codexFailure('cleanup');
      }
      if (problem) return reject(problem);
      if (code !== 0) return reject(codexFailure('process'));
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

async function subscriptionRunner(environment, maxOutputBytes, signal) {
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']
      .filter((key) => environment[key])
      .map((key) => [key, environment[key]]),
  );
  if (!env.HOME || !env.PATH) throw codexFailure('configuration');
  const inspect = (args) =>
    runBoundedCodexProcess('codex', args, {
      env,
      signal,
      deadlineMs: 5000,
      maxOutputBytes: MAX_BYTES,
    });
  assertInspectedCodexVersion((await inspect(['--version'])).stdout.trim());
  const catalog = (await inspect(['features', 'list'])).stdout;
  codexFeatureDisables(catalog);
  // The CLI reports the authentication kind; never open/copy auth files.
  // Check before forced_login_method, which can log out mismatched auth.
  const status = await inspect(['login', 'status']);
  if (
    !/^Logged in using ChatGPT\s*$/.test((status.stdout + status.stderr).trim())
  )
    throw codexFailure('subscription-login-required');
  const directory = await mkdtemp(join(tmpdir(), 'talkqte-codex-lab-'));
  const schemaFile = join(directory, 'reply.schema.json');
  return {
    async run(request, { signal: operationSignal }) {
      await writeFile(schemaFile, JSON.stringify(request.schema), {
        mode: 0o600,
      });
      const args = codexExecArgs({
        cwd: directory,
        schemaFile,
        catalog,
        model: request.model,
        effort: request.effort,
      });
      const reader = createCodexEventReader();
      return runBoundedCodexProcess('codex', args, {
        cwd: directory,
        env,
        signal: operationSignal,
        deadlineMs: request.deadlineMs,
        maxOutputBytes,
        onStdoutLine: reader.accept,
        input: JSON.stringify({
          instructions: request.instructions,
          input: request.input,
        }),
      });
    },
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Offline run({role,...}, {signal}) must settle after abort. Subscription
 * execution is explicit and uses only CLI-managed saved ChatGPT auth. */
export async function openCodexLab({
  model,
  effort,
  deadlineMs,
  maxCalls,
  run,
  signal,
  environment = process.env,
  cliVersion = `codex-cli ${CODEX_SUPPORT.inspectedVersion}`,
  execution = 'offline-stand-in',
  maxOutputBytes = MAX_BYTES,
} = {}) {
  assertInspectedCodexVersion(cliVersion);
  if (
    model !== CODEX_SUPPORT.model ||
    !CODEX_SUPPORT.efforts.includes(effort) ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 10 ||
    deadlineMs > 60000 ||
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 100 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1024 ||
    maxOutputBytes > MAX_BYTES ||
    !['offline-stand-in', 'subscription'].includes(execution) ||
    (execution === 'subscription' && run !== undefined)
  )
    throw codexFailure('configuration');
  assertSubscriptionEnvironment(environment);
  if (signal?.aborted) throw codexFailure('cancelled');
  let runtime;
  if (execution === 'subscription') {
    runtime = await subscriptionRunner(environment, maxOutputBytes, signal);
    run = runtime.run;
  }
  if (signal?.aborted) {
    await runtime?.close();
    throw codexFailure('cancelled');
  }
  if (typeof run !== 'function') throw codexFailure('provider-unavailable');
  const metadata = Object.freeze({
    provider: 'codex',
    model,
    effort,
    execution,
    budgetUnit: 'runner-dispatch-attempts',
    actualProviderRequestBound: false,
    deadlineMs,
    maxCalls,
    maxInputBytes: MAX_INPUT,
    maxOutputBytes,
  });
  let calls = 0,
    terminal = false,
    active = null;
  const fail = (category) => {
    terminal = true;
    active?.controller.abort();
    return codexFailure(category, calls);
  };
  const stop = () => {
    terminal = true;
    active?.controller.abort();
  };
  signal?.addEventListener('abort', stop, { once: true });
  const request = async ({
    role,
    instructions,
    input,
    schema,
    signal: requestSignal,
  } = {}) => {
    if (terminal) throw codexFailure('terminal', calls);
    if (active) throw fail('concurrent-request');
    if (signal?.aborted || requestSignal?.aborted) throw fail('cancelled');
    let snapshot;
    try {
      if (
        !ROLES.has(role) ||
        typeof instructions !== 'string' ||
        !instructions.trim() ||
        instructions.length > 16000
      )
        throw new Error();
      snapshot = snapshotLabJson({ role, instructions, input, schema });
      if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_INPUT)
        throw new Error();
      validateCodexSchema(snapshot.schema);
    } catch {
      throw fail('invalid-request');
    }
    if (calls >= maxCalls) throw fail('call-cap');
    const controller = new AbortController();
    const started = performance.now();
    let cancelled = false,
      timedOut = false;
    const abort = () => {
      cancelled = true;
      terminal = true;
      controller.abort();
    };
    requestSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminal = true;
      controller.abort();
    }, deadlineMs);
    calls++;
    // Assign the operation before invoking a runner, including synchronous throws.
    const operation = { controller, done: null };
    active = operation;
    operation.done = Promise.resolve().then(() =>
      run(
        { ...snapshot, model, effort, deadlineMs },
        { signal: controller.signal },
      ),
    );
    try {
      const result = await operation.done;
      if (timedOut) throw fail('deadline');
      if (cancelled || terminal || signal?.aborted || requestSignal?.aborted)
        throw fail('cancelled');
      const parsed = parseCodexEvents(result.stdout);
      validateCodexSchema(snapshot.schema, parsed.value);
      return { ...parsed, elapsedMs: Math.round(performance.now() - started) };
    } catch (error) {
      const known = [
        'output-limit',
        'protocol',
        'unexpected-event',
        'schema',
        'deadline',
        'cancelled',
        'process',
        'cleanup',
      ];
      throw fail(
        timedOut
          ? 'deadline'
          : cancelled || controller.signal.aborted || signal?.aborted
            ? 'cancelled'
            : known.includes(error?.category)
              ? error.category
              : 'provider',
      );
    } finally {
      clearTimeout(timer);
      requestSignal?.removeEventListener('abort', abort);
      active = null;
    }
  };
  return Object.freeze({
    metadata,
    request,
    get calls() {
      return calls;
    },
    async close() {
      stop();
      signal?.removeEventListener('abort', stop);
      if (active) await active.done.catch(() => {});
      try {
        await runtime?.close();
      } catch {
        throw codexFailure('cleanup', calls);
      }
    },
  });
}
