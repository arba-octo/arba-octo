import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const AUTHOR = 'arba-octo';
const LIMIT = 2;
const START = '<!-- contributions:start -->';
const END = '<!-- contributions:end -->';
const SECTIONS = [
  { state: 'merged', title: 'Merged' },
  { state: 'open', title: 'Open' },
];

function searchQuery(state) {
  return `is:pr author:${AUTHOR} is:public -user:${AUTHOR} is:${state}`;
}

function escapeHtml(title) {
  return title
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchPullRequests(state, fetchImpl, token) {
  const url = new URL('https://api.github.com/search/issues');
  url.searchParams.set('q', searchQuery(state));
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', String(LIMIT));

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `${AUTHOR}-profile`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub search for ${state} PRs failed (HTTP ${response.status}).`);
  }

  const data = await response.json();
  if (
    !data ||
    data.incomplete_results !== false ||
    !Number.isSafeInteger(data.total_count) ||
    data.total_count < 0 ||
    !Array.isArray(data.items) ||
    data.items.length !== Math.min(LIMIT, data.total_count)
  ) {
    throw new Error(`GitHub returned an incomplete or invalid ${state} PR list.`);
  }

  const seen = new Set();
  return data.items.map((item) => {
    const match = typeof item?.repository_url === 'string'
      ? /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(item.repository_url)
      : null;
    if (
      !match ||
      match[1].toLowerCase() === AUTHOR ||
      typeof item.user?.login !== 'string' ||
      item.user.login.toLowerCase() !== AUTHOR ||
      !Number.isSafeInteger(item.number) ||
      item.number < 1 ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      item.state !== (state === 'open' ? 'open' : 'closed')
    ) {
      throw new Error(`GitHub returned an invalid ${state} PR.`);
    }

    const repository = `${match[1]}/${match[2]}`;
    const repositoryUrl = `https://github.com/${repository}`;
    const prUrl = `${repositoryUrl}/pull/${item.number}`;
    const mergedAt = item.pull_request?.merged_at;
    if (
      item.html_url !== prUrl ||
      item.pull_request?.html_url !== prUrl ||
      (state === 'merged'
        ? typeof mergedAt !== 'string' || !Number.isFinite(Date.parse(mergedAt))
        : mergedAt !== null) ||
      seen.has(prUrl)
    ) {
      throw new Error(`GitHub returned an invalid or duplicate ${state} PR.`);
    }
    seen.add(prUrl);
    return { repository, repositoryUrl, number: item.number, title: item.title, url: prUrl };
  });
}

function renderSection({ state, title }, items) {
  const searchUrl = new URL('https://github.com/pulls');
  searchUrl.searchParams.set('q', `${searchQuery(state)} sort:updated-desc`);
  const rows = items.map((item) =>
    `<tr><td><sub><a href="${item.repositoryUrl}">${escapeHtml(item.repository.split('/')[1])}</a></sub></td><td><sub><a href="${item.url}" title="${escapeHtml(item.title)}">#${item.number}</a></sub></td></tr>`,
  );
  return [
    '<table>',
    `<tr><th colspan="2"><sub>${title}</sub></th></tr>`,
    rows.join('\n') || '<tr><td colspan="2"><sub>—</sub></td></tr>',
    '</table>',
    `<sub><a href="${escapeHtml(searchUrl.href)}">All</a></sub>`,
  ].join('\n');
}

export async function updateReadme({
  readmePath = new URL('../README.md', import.meta.url),
  fetchImpl = fetch,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
} = {}) {
  const original = await readFile(readmePath, 'utf8');
  const start = original.indexOf(START);
  const end = original.indexOf(END);
  if (
    start === -1 ||
    end < start + START.length ||
    original.indexOf(START, start + START.length) !== -1 ||
    original.indexOf(END, end + END.length) !== -1
  ) {
    throw new Error('README must contain exactly one ordered pair of contribution markers.');
  }

  const results = await Promise.all(
    SECTIONS.map(({ state }) => fetchPullRequests(state, fetchImpl, token)),
  );
  const content = [
    '<table><tr>',
    ...SECTIONS.map((section, index) =>
      `<td valign="top">\n${renderSection(section, results[index])}\n</td>`,
    ),
    '</tr></table>',
  ].join('\n');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const block = `\n\n${content}\n\n`.replace(/\n/g, newline);
  const updated = original.slice(0, start + START.length) + block + original.slice(end);
  if (updated === original) return false;

  await writeFile(readmePath, updated, 'utf8');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const changed = await updateReadme();
    console.log(changed ? 'Updated contribution tables.' : 'Contribution tables are unchanged.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
