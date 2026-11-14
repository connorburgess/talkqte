import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isMain } from './is-main.mjs';

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

// These patterns catch common attribution footers. Human review remains necessary.
export function hasToolCredit(text) {
  return /^(?:\s*[*_>-]*\s*)(?:co-authored-by:\s*(?:codex|claude|chatgpt|cursor|copilot|github copilot)\b|(?:generated|written|created|powered)\s+(?:with|by)\s+(?:codex|claude|chatgpt|cursor|copilot|github copilot|anthropic|openai)\b)/im.test(
    text,
  );
}

export function checkCommit(commit) {
  const raw = git(['show', '--no-patch', '--format=%an%x00%ae%x00%B', commit]);
  const [name, email, message] = raw.split('\0');
  const author = `${name} <${email}>`;
  const trailers = git(['interpret-trailers', '--parse'], { input: message });
  const signoffs = trailers
    .split('\n')
    .filter((line) => /^Signed-off-by:/i.test(line))
    .map((line) => line.slice(line.indexOf(':') + 1).trim());
  const failures = [];
  if (!signoffs.includes(author))
    failures.push(
      `${commit.slice(0, 12)} needs a contribution sign-off matching its author.`,
    );
  if (hasToolCredit(message))
    failures.push(`${commit.slice(0, 12)} contains a tool attribution credit.`);
  return failures;
}

export function checkRange(base, head, event = {}) {
  if (![base, head].every((value) => /^[a-f0-9]{40}$/i.test(value || '')))
    throw new Error('Contribution base and head must be full commit SHAs.');
  const commits = git(['rev-list', `${base}..${head}`])
    .split('\n')
    .filter(Boolean);
  if (!commits.length) throw new Error('No contribution commits were found.');
  const failures = commits.flatMap(checkCommit);
  const pr = event.pull_request;
  if (pr && hasToolCredit(`${pr.title || ''}\n${pr.body || ''}`))
    failures.push('The pull request contains a tool attribution credit.');
  return { commits: commits.length, failures };
}

if (isMain(import.meta.url)) {
  try {
    const event = process.env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
      : {};
    const result = checkRange(
      process.env.CONTRIBUTION_BASE,
      process.env.CONTRIBUTION_HEAD,
      event,
    );
    if (result.failures.length) {
      console.error(result.failures.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(
        `Verified contribution metadata for ${result.commits} commits.`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
