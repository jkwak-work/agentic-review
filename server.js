#!/usr/bin/env node

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const HOST = '127.0.0.1';
const requestedPort = Number(process.env.AGENTIC_REVIEW_PORT || 4173);
const replyTimeoutMs = Math.max(1000, Number(process.env.AGENTIC_REVIEW_REPLY_TIMEOUT_MS) || 5 * 60 * 1000);
const configuredSubmitDelayMs = Number(process.env.AGENTIC_REVIEW_SUBMIT_DELAY_MS);
const submitDelayMs = Number.isFinite(configuredSubmitDelayMs) && configuredSubmitDelayMs >= 0
  ? configuredSubmitDelayMs
  : 5000;
const publicDir = path.join(__dirname, 'public');
const suggestedWorktree = path.resolve(process.env.AGENTIC_REVIEW_REPO || process.cwd());
const authToken = crypto.randomBytes(24).toString('hex');
const reviews = new Map();
const threads = new Map();
const eventClients = new Set();
let listeningPort = requestedPort;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 20 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

function runAccepting(command, args, acceptedExitCodes, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 20 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (!error || acceptedExitCodes.includes(error.code)) resolve(stdout);
      else {
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function runWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listTmuxSessions() {
  try {
    const output = await run('tmux', ['list-sessions', '-F', '#{session_name}']);
    return output.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (/no server running|failed to connect/i.test(error.stderr || '') || error.code === 'ENOENT') return [];
    throw error;
  }
}

async function listTmuxPanes(session) {
  const output = await run('tmux', [
    'list-panes', '-s', '-t', `=${session}`, '-F',
    '#{pane_id}|#{pane_pid}|#{window_active}|#{pane_active}|#{window_index}|#{pane_index}'
  ]);
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, pid, windowActive, paneActive, windowIndex, paneIndex] = line.split('|');
    return {
      id,
      pid: Number(pid),
      active: windowActive === '1' && paneActive === '1',
      windowIndex: Number(windowIndex),
      paneIndex: Number(paneIndex)
    };
  });
}

async function selectAgentPane(session) {
  const panes = await listTmuxPanes(session);
  if (!panes.length) throw new Error(`tmux session has no panes: ${session}`);
  panes.sort((left, right) => left.windowIndex - right.windowIndex || left.paneIndex - right.paneIndex);
  return panes[0];
}

async function validateWorktree(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A worktree path is required.');
  const worktree = path.resolve(value.trim());
  let stats;
  try { stats = fs.statSync(worktree); }
  catch { throw new Error(`Worktree does not exist: ${worktree}`); }
  if (!stats.isDirectory()) throw new Error('The worktree path must be a directory.');
  try {
    const root = (await run('git', ['rev-parse', '--show-toplevel'], { cwd: worktree })).trim();
    if (!root) throw new Error();
  } catch {
    throw new Error(`Not a readable Git worktree: ${worktree}`);
  }
  return worktree;
}

async function branchRef(worktree, branch) {
  if (typeof branch !== 'string' || !branch.trim()) throw new Error('A base branch is required.');
  const name = branch.trim();
  try {
    await run('git', ['check-ref-format', '--branch', name], { cwd: worktree });
  } catch {
    throw new Error(`Invalid branch name: ${name}`);
  }
  const candidates = name.includes('/') ? [name] : [name, `origin/${name}`];
  for (const candidate of candidates) {
    try {
      await run('git', ['rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`], { cwd: worktree });
      return candidate;
    } catch {}
  }
  throw new Error(`Branch not found: ${name}`);
}

async function detectDefaultBranch(worktree) {
  try {
    const remoteHead = (await run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: worktree })).trim();
    if (remoteHead) return remoteHead.startsWith('origin/') ? remoteHead.slice('origin/'.length) : remoteHead;
  } catch {}
  for (const name of ['main', 'master']) {
    try {
      await branchRef(worktree, name);
      return name;
    } catch {}
  }
  try {
    return (await run('git', ['branch', '--show-current'], { cwd: worktree })).trim();
  } catch {
    return '';
  }
}

async function worktreeInfo(value) {
  const worktree = await validateWorktree(value);
  return {
    worktree,
    suggestedSession: path.basename(worktree),
    defaultBranch: await detectDefaultBranch(worktree)
  };
}

async function createReview(worktreeValue, sessionValue, baseBranchValue) {
  const worktree = await validateWorktree(worktreeValue);
  const sessions = await listTmuxSessions();
  if (typeof sessionValue !== 'string' || !sessions.includes(sessionValue)) {
    throw new Error('Choose an existing tmux session.');
  }
  const pane = await selectAgentPane(sessionValue);
  const baseBranch = String(baseBranchValue || '').trim();
  const baseRef = await branchRef(worktree, baseBranch);
  const review = {
    id: crypto.randomUUID(),
    worktree,
    session: sessionValue,
    paneId: pane.id,
    baseBranch,
    baseRef,
    label: path.basename(worktree),
    reviewedFiles: new Map(),
    commentQueue: [],
    activeThreadId: null,
    queueTimer: null,
    createdAt: new Date().toISOString()
  };
  reviews.set(review.id, review);
  return review;
}

function publicReview(review) {
  return {
    id: review.id,
    worktree: review.worktree,
    session: review.session,
    paneId: review.paneId,
    baseBranch: review.baseBranch,
    label: review.label,
    createdAt: review.createdAt
  };
}

function getReview(id) {
  const review = reviews.get(id);
  if (!review) {
    const error = new Error('This review context no longer exists. Reload and configure the page again.');
    error.status = 404;
    throw error;
  }
  return review;
}

async function reviewStatus(review) {
  const sessions = await listTmuxSessions();
  let connected = false;
  if (sessions.includes(review.session)) {
    try { connected = (await listTmuxPanes(review.session)).some((pane) => pane.id === review.paneId); } catch {}
  }
  return { review: publicReview(review), connected, sessions };
}

async function getDiff(review, { ignoreWhitespace = false, contextLines = 3 } = {}) {
  try {
    const mergeBase = (await run('git', ['merge-base', review.baseRef, 'HEAD'], { cwd: review.worktree })).trim();
    const tracked = await run('git', [
      'diff', mergeBase, '--no-ext-diff', '--no-color', '--find-renames',
      ...(ignoreWhitespace ? ['--ignore-all-space'] : []),
      `--unified=${contextLines}`, '--src-prefix=a/', '--dst-prefix=b/'
    ], { cwd: review.worktree });

    const untrackedOutput = await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: review.worktree });
    const untrackedFiles = untrackedOutput.split('\0').filter(Boolean);
    const untrackedDiffs = [];
    const gitVersion = await run('git', ['--version'], { cwd: review.worktree });
    const nullDevice = /windows/i.test(gitVersion) ? 'NUL' : '/dev/null';
    for (const file of untrackedFiles) {
      if (!safeRelativeFile(review, file)) continue;
      const diff = await runAccepting('git', [
        'diff', '--no-index', '--no-ext-diff', '--no-color', `--unified=${contextLines}`,
        ...(ignoreWhitespace ? ['--ignore-all-space'] : []),
        '--src-prefix=a/', '--dst-prefix=b/', '--', nullDevice, file
      ], [1], { cwd: review.worktree });
      if (diff) untrackedDiffs.push(diff);
    }
    return [tracked, ...untrackedDiffs].filter(Boolean).join('\n');
  } catch (error) {
    throw new Error(`Could not compare ${review.worktree} with ${review.baseBranch}: ${error.stderr?.trim() || error.message}`);
  }
}

function patchPath(line) {
  if (!line) return null;
  const value = line.slice(4).split('\t')[0];
  if (value === '/dev/null') return null;
  return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value;
}

function fileDiffFingerprints(diff) {
  const fingerprints = new Map();
  const patches = diff.split(/(?=^diff --git )/m).filter((entry) => entry.startsWith('diff --git '));
  for (const patch of patches) {
    const lines = patch.split('\n');
    const renamedTo = lines.find((line) => line.startsWith('rename to '));
    const newHeader = lines.find((line) => line.startsWith('+++ '));
    const oldHeader = lines.find((line) => line.startsWith('--- '));
    let file = renamedTo ? renamedTo.slice('rename to '.length) : patchPath(newHeader) || patchPath(oldHeader);
    if (!file) {
      const header = lines[0].slice('diff --git '.length);
      const separator = header.lastIndexOf(' b/');
      file = separator >= 0 ? header.slice(separator + 3) : null;
    }
    if (file) fingerprints.set(file, crypto.createHash('sha256').update(patch).digest('hex'));
  }
  return fingerprints;
}

function reviewedState(review, diff) {
  const current = fileDiffFingerprints(diff);
  const invalidatedFiles = [];
  for (const [file, fingerprint] of review.reviewedFiles) {
    if (current.get(file) !== fingerprint) {
      review.reviewedFiles.delete(file);
      invalidatedFiles.push(file);
    }
  }
  return { current, reviewedFiles: Array.from(review.reviewedFiles.keys()), invalidatedFiles };
}

function reviewThreads(reviewId) {
  return Array.from(threads.values()).filter((thread) => thread.reviewId === reviewId);
}

function broadcast(reviewId, type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of eventClients) {
    if (client.reviewId === reviewId) client.response.write(message);
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Request body must be valid JSON.')); }
    });
    request.on('error', reject);
  });
}

function safeRelativeFile(review, file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.includes('\0')) return false;
  const resolved = path.resolve(review.worktree, file);
  return resolved === review.worktree || resolved.startsWith(review.worktree + path.sep);
}

function buildAgentPrompt(review, thread) {
  const replyUrl = `http://${HOST}:${listeningPort}/api/replies`;
  const isGeneral = thread.kind === 'general';
  const location = !isGeneral && (thread.side === 'old'
    ? `the HEAD version at line ${thread.line}`
    : `the working-tree version at line ${thread.line}`);

  return [
    `[agentic-review ${isGeneral ? 'general' : 'inline review'} request]`,
    `Review context: ${review.id}`,
    `Worktree: ${review.worktree}`,
    `Base branch: ${review.baseBranch}`,
    `Request type: ${isGeneral ? 'General discussion (not attached to a code line)' : 'Inline code review'}`,
    ...(!isGeneral ? [`File: ${thread.file}`, `Location: ${location}`] : []),
    `Thread ID: ${thread.id}`,
    '',
    isGeneral ? 'Reviewer message:' : 'Reviewer comment:',
    thread.comments[0].body,
    '',
    ...(isGeneral
      ? [
          'Treat the reviewer message as a worktree-scoped request or question.',
          'If it requests work or a code change, perform that work in this worktree now, before replying. Do not merely describe, propose, or promise it.'
        ]
      : [
          'Treat the reviewer comment as an actionable code-review instruction.',
          'If the comment requests or clearly calls for a code change, make that change in this worktree now, before replying. Do not merely describe, propose, or promise the edit.'
        ]),
    'Inspect the surrounding code, preserve the project style, and run appropriate focused checks when practical. In the reply, summarize the changes actually made and any verification performed.',
    'If the comment is only a question or asks for explanation, answer it without modifying files.',
    'Send the reply back to agentic-review by running this command, replacing REPLY_TEXT with your response:',
    `curl -sS -X POST ${replyUrl} -H "Authorization: Bearer ${authToken}" -H "Content-Type: application/json" --data-binary '{"threadId":"${thread.id}","body":"REPLY_TEXT"}'`,
    'The request body must be valid JSON, so escape quotes and newlines in REPLY_TEXT. Prefer generating the JSON payload with a language JSON serializer when the reply is multiline.',
    `[end agentic-review ${isGeneral ? 'general' : 'inline review'} request]`
  ].join('\n');
}

async function injectIntoTmux(review, prompt) {
  const sessions = await listTmuxSessions();
  if (!sessions.includes(review.session)) throw new Error(`tmux session is no longer running: ${review.session}`);
  const panes = await listTmuxPanes(review.session);
  if (!panes.some((pane) => pane.id === review.paneId)) throw new Error(`tmux agent pane is no longer running: ${review.paneId}`);
  const bufferName = `agentic-review-${crypto.randomBytes(6).toString('hex')}`;
  await runWithInput('tmux', ['load-buffer', '-b', bufferName, '-'], prompt, { cwd: review.worktree });
  try {
    await run('tmux', ['paste-buffer', '-d', '-b', bufferName, '-t', review.paneId], { cwd: review.worktree });
    await delay(submitDelayMs);
    await run('tmux', ['send-keys', '-t', review.paneId, 'Enter'], { cwd: review.worktree });
  } catch (error) {
    await run('tmux', ['delete-buffer', '-b', bufferName], { cwd: review.worktree }).catch(() => {});
    throw error;
  }
}

function clearQueueTimer(review) {
  if (review.queueTimer) clearTimeout(review.queueTimer);
  review.queueTimer = null;
}

function finishActiveThread(review, thread) {
  if (review.activeThreadId !== thread.id) return;
  clearQueueTimer(review);
  review.activeThreadId = null;
  void dispatchNext(review);
}

async function dispatchNext(review) {
  if (review.activeThreadId || !reviews.has(review.id)) return;
  let thread = null;
  while (review.commentQueue.length && !thread) {
    const candidate = threads.get(review.commentQueue.shift());
    if (candidate?.status === 'queued') thread = candidate;
  }
  if (!thread) return;

  review.activeThreadId = thread.id;
  thread.status = 'sending';
  broadcast(review.id, 'thread', thread);
  try {
    await injectIntoTmux(review, buildAgentPrompt(review, thread));
    thread.status = 'sent';
    thread.sentAt = new Date().toISOString();
    broadcast(review.id, 'thread', thread);
    review.queueTimer = setTimeout(() => {
      if (review.activeThreadId !== thread.id || thread.status !== 'sent') return;
      thread.status = 'timed_out';
      thread.error = `No agent reply arrived within ${Math.round(replyTimeoutMs / 1000)} seconds.`;
      broadcast(review.id, 'thread', thread);
      finishActiveThread(review, thread);
    }, replyTimeoutMs);
  } catch (error) {
    thread.status = 'failed';
    thread.error = error.message;
    broadcast(review.id, 'thread', thread);
    finishActiveThread(review, thread);
  }
}

function serveStatic(requestPath, response) {
  const routes = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
  const filename = routes[requestPath];
  if (!filename) return false;
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const data = fs.readFileSync(path.join(publicDir, filename));
  response.writeHead(200, {
    'Content-Type': `${types[path.extname(filename)]}; charset=utf-8`,
    'Cache-Control': 'no-store'
  });
  response.end(data);
  return true;
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    const sessions = await listTmuxSessions();
    let defaultBranch = '';
    try { defaultBranch = (await worktreeInfo(suggestedWorktree)).defaultBranch; } catch {}
    return sendJson(response, 200, {
      suggestedWorktree,
      suggestedSession: path.basename(suggestedWorktree),
      defaultBranch,
      sessions
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/worktree-info') {
    try {
      return sendJson(response, 200, await worktreeInfo(url.searchParams.get('path')));
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/reviews') {
    const body = await readJson(request);
    try {
      const review = await createReview(body.worktree, body.session, body.baseBranch);
      return sendJson(response, 201, { review: publicReview(review) });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  const queuedThreadMatch = /^\/api\/reviews\/([^/]+)\/threads\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'DELETE' && queuedThreadMatch) {
    const review = getReview(queuedThreadMatch[1]);
    const thread = threads.get(queuedThreadMatch[2]);
    if (!thread || thread.reviewId !== review.id) return sendJson(response, 404, { error: 'Thread not found.' });
    if (thread.status !== 'queued') {
      return sendJson(response, 409, { error: 'Only comments still waiting in the queue can be deleted.' });
    }
    review.commentQueue = review.commentQueue.filter((id) => id !== thread.id);
    threads.delete(thread.id);
    broadcast(review.id, 'thread-deleted', { id: thread.id });
    return sendJson(response, 200, { ok: true });
  }

  const reviewMatch = /^\/api\/reviews\/([^/]+)(?:\/(diff|status|comments|events|reviewed-files))?$/.exec(url.pathname);
  if (reviewMatch) {
    const review = getReview(reviewMatch[1]);
    const action = reviewMatch[2];

    if (request.method === 'GET' && !action) {
      return sendJson(response, 200, { review: publicReview(review) });
    }
    if (request.method === 'DELETE' && !action) {
      clearQueueTimer(review);
      reviews.delete(review.id);
      for (const thread of reviewThreads(review.id)) threads.delete(thread.id);
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === 'GET' && action === 'status') {
      return sendJson(response, 200, await reviewStatus(review));
    }
    if (request.method === 'GET' && action === 'diff') {
      const ignoreWhitespace = url.searchParams.get('ignoreWhitespace') === '1';
      const requestedContext = Number.parseInt(url.searchParams.get('context') || '3', 10);
      const contextLines = Math.max(3, Math.min(500, Number.isFinite(requestedContext) ? requestedContext : 3));
      const fullDiff = await getDiff(review);
      const diff = ignoreWhitespace || contextLines !== 3
        ? await getDiff(review, { ignoreWhitespace, contextLines })
        : fullDiff;
      const state = reviewedState(review, fullDiff);
      return sendJson(response, 200, {
        diff,
        contextLines,
        threads: reviewThreads(review.id),
        reviewedFiles: state.reviewedFiles,
        invalidatedFiles: state.invalidatedFiles
      });
    }
    if (request.method === 'POST' && action === 'reviewed-files') {
      const body = await readJson(request);
      if (!safeRelativeFile(review, body.file)) {
        return sendJson(response, 400, { error: 'A valid changed file is required.' });
      }
      if (body.reviewed === false) {
        review.reviewedFiles.delete(body.file);
        return sendJson(response, 200, { file: body.file, reviewed: false });
      }
      const diff = await getDiff(review);
      const current = fileDiffFingerprints(diff);
      const fingerprint = current.get(body.file);
      if (!fingerprint) {
        return sendJson(response, 400, { error: 'The file is not present in the current diff.' });
      }
      review.reviewedFiles.set(body.file, fingerprint);
      return sendJson(response, 200, { file: body.file, reviewed: true });
    }
    if (request.method === 'GET' && action === 'events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      response.write(': connected\n\n');
      const client = { reviewId: review.id, response };
      eventClients.add(client);
      request.on('close', () => eventClients.delete(client));
      return;
    }
    if (request.method === 'POST' && action === 'comments') {
      const body = await readJson(request);
      const kind = body.kind === 'general' ? 'general' : 'inline';
      const invalidKind = body.kind !== undefined && !['general', 'inline'].includes(body.kind);
      const invalidInlineLocation = kind === 'inline' && (
        !safeRelativeFile(review, body.file) || !['old', 'new'].includes(body.side) ||
        !Number.isInteger(body.line) || body.line < 1
      );
      if (invalidKind) {
        return sendJson(response, 400, { error: 'Comment kind must be inline or general.' });
      }
      if (typeof body.body !== 'string' || !body.body.trim()) {
        return sendJson(response, 400, { error: 'A non-empty comment is required.' });
      }
      if (invalidInlineLocation) {
        return sendJson(response, 400, { error: 'A file, side, line, and non-empty comment are required.' });
      }
      const now = new Date().toISOString();
      const thread = {
        id: crypto.randomUUID(),
        reviewId: review.id,
        kind,
        file: kind === 'inline' ? body.file : null,
        side: kind === 'inline' ? body.side : null,
        line: kind === 'inline' ? body.line : null,
        status: 'queued',
        queuedAt: now,
        comments: [{ id: crypto.randomUUID(), author: 'you', body: body.body.trim(), createdAt: now }]
      };
      threads.set(thread.id, thread);
      review.commentQueue.push(thread.id);
      broadcast(review.id, 'thread', thread);
      void dispatchNext(review);
      return sendJson(response, 202, thread);
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/replies') {
    if (request.headers.authorization !== `Bearer ${authToken}`) {
      return sendJson(response, 401, { error: 'Invalid reply token.' });
    }
    const body = await readJson(request);
    const thread = threads.get(body.threadId);
    if (!thread || typeof body.body !== 'string' || !body.body.trim()) {
      return sendJson(response, 400, { error: 'A known threadId and non-empty body are required.' });
    }
    thread.comments.push({
      id: crypto.randomUUID(),
      author: 'agent',
      body: body.body.trim(),
      createdAt: new Date().toISOString()
    });
    thread.status = 'replied';
    delete thread.error;
    broadcast(thread.reviewId, 'thread', thread);
    const review = reviews.get(thread.reviewId);
    if (review) finishActiveThread(review, thread);
    return sendJson(response, 201, { ok: true, thread });
  }

  return sendJson(response, 404, { error: 'Not found.' });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || HOST}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else if (!serveStatic(url.pathname, response)) sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    if (!error.status || error.status >= 500) console.error(error);
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.message || 'Internal server error.' });
    else response.end();
  }
});

server.listen(requestedPort, HOST, () => {
  listeningPort = server.address().port;
  console.log(`agentic-review is ready for browser-scoped reviews.`);
  console.log(`Open http://${HOST}:${listeningPort}`);
});
