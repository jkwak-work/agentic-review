const state = {
  bootstrap: null,
  review: null,
  connected: false,
  showChangedFiles: true,
  ignoreWhitespace: false,
  unifiedDiff: false,
  prefetchContextLines: 30,
  loadedContextLines: 0,
  hunkContext: new Map(),
  files: [],
  rawDiff: '',
  reviewedFiles: new Set(),
  invalidatedFiles: new Set(),
  hiddenThreads: new Set(),
  threads: new Map(),
  activeFile: null,
  composing: null,
  generalSelected: false,
  generalDraft: ''
};

let events = null;

const elements = {
  repoName: document.querySelector('#repo-name'),
  sessionButton: document.querySelector('#session-button'),
  sessionDot: document.querySelector('#session-dot'),
  sessionLabel: document.querySelector('#session-label'),
  refreshButton: document.querySelector('#refresh-button'),
  showChangedFiles: document.querySelector('#show-changed-files'),
  ignoreWhitespace: document.querySelector('#ignore-whitespace'),
  unifiedDiff: document.querySelector('#unified-diff'),
  contextPrefetch: document.querySelector('#context-prefetch'),
  fileCount: document.querySelector('#file-count'),
  fileList: document.querySelector('#file-list'),
  workspace: document.querySelector('.workspace'),
  sidebarResizer: document.querySelector('#sidebar-resizer'),
  reviewContent: document.querySelector('#review-content'),
  sessionModal: document.querySelector('#session-modal'),
  sessionForm: document.querySelector('#session-form'),
  worktreeInput: document.querySelector('#worktree-input'),
  branchInput: document.querySelector('#branch-input'),
  sessionInput: document.querySelector('#session-input'),
  sessionOptions: document.querySelector('#session-options'),
  sessionHelp: document.querySelector('#session-help'),
  sessionError: document.querySelector('#session-error'),
  sessionCancel: document.querySelector('#session-cancel'),
  toastRegion: document.querySelector('#toast-region')
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.payload = body;
    throw error;
  }
  return body;
}

function parsePath(line) {
  const value = line.slice(4).split('\t')[0];
  if (value === '/dev/null') return null;
  return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value;
}

function pairChangeBlock(deletions, additions) {
  const rows = [];
  const length = Math.max(deletions.length, additions.length);
  for (let index = 0; index < length; index += 1) {
    rows.push({
      type: deletions[index] && additions[index] ? 'changed' : deletions[index] ? 'deletion' : 'addition',
      old: deletions[index] || null,
      new: additions[index] || null
    });
  }
  return rows;
}

function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  let deletions = [];
  let additions = [];

  function flushChanges() {
    if (hunk && (deletions.length || additions.length)) {
      hunk.rows.push(...pairChangeBlock(deletions, additions));
      deletions = [];
      additions = [];
    }
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flushChanges();
      const header = line.slice('diff --git '.length);
      const separator = header.lastIndexOf(' b/');
      const oldPath = header.startsWith('a/') && separator >= 0 ? header.slice(2, separator) : null;
      const newPath = separator >= 0 ? header.slice(separator + 3) : null;
      file = {
        oldPath,
        newPath,
        path: newPath || oldPath || '',
        hunks: [],
        metadata: [],
        additions: 0,
        deletions: 0
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('--- ')) {
      file.oldPath = parsePath(line);
      continue;
    }
    if (line.startsWith('+++ ')) {
      file.newPath = parsePath(line);
      file.path = file.newPath || file.oldPath;
      continue;
    }
    if (line.startsWith('rename from ')) {
      file.oldPath = line.slice('rename from '.length);
      continue;
    }
    if (line.startsWith('rename to ')) {
      file.newPath = line.slice('rename to '.length);
      file.path = file.newPath;
      continue;
    }
    if (line.startsWith('@@')) {
      flushChanges();
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (!match) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      hunk = { header: line, context: match[3].trim(), rows: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (line && !line.startsWith('index ')) file.metadata.push(line);
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      deletions.push({ line: oldLine, text: line.slice(1) });
      oldLine += 1;
      file.deletions += 1;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
      file.additions += 1;
    } else {
      flushChanges();
      if (line.startsWith(' ')) {
        hunk.rows.push({
          type: 'context',
          old: { line: oldLine, text: line.slice(1) },
          new: { line: newLine, text: line.slice(1) }
        });
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  flushChanges();
  return files.filter((entry) => entry.path);
}

function basename(filePath) {
  return filePath.split('/').pop();
}

function directory(filePath) {
  const parts = filePath.split('/');
  parts.pop();
  return parts.length ? `${parts.join('/')}/` : '';
}

function threadKey(file, side, line) {
  return `${file}:${side}:${line}`;
}

function threadsAt(file, side, line) {
  return Array.from(state.threads.values()).filter(
    (thread) => threadKey(thread.file, thread.side, thread.line) === threadKey(file, side, line)
  );
}

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function showToast(message, tone = '') {
  const toast = make('div', `toast ${tone}`, message);
  elements.toastRegion.append(toast);
  setTimeout(() => toast.remove(), 12600);
}

function selectFile(filePath) {
  state.activeFile = filePath;
  state.composing = null;
  state.generalSelected = false;
  renderSidebar();
  renderReview();
}

function selectGeneralDiscussion() {
  state.composing = null;
  state.generalSelected = true;
  renderSidebar();
  renderReview();
}

function renderSidebar() {
  elements.fileCount.textContent = state.files.length;
  elements.fileList.replaceChildren();
  const generalThreads = Array.from(state.threads.values()).filter((thread) => thread.kind === 'general');
  const generalButton = make('button', `general-item${state.generalSelected ? ' active' : ''}`);
  generalButton.type = 'button';
  generalButton.title = 'Discuss a request that is not attached to a specific code line';
  generalButton.append(
    make('span', 'general-icon', '💬'),
    make('span', 'general-label', 'General discussion')
  );
  if (generalThreads.length) generalButton.append(make('span', 'general-count', String(generalThreads.length)));
  generalButton.addEventListener('click', selectGeneralDiscussion);
  elements.fileList.append(generalButton);
  for (const file of state.files) {
    const isReviewed = state.reviewedFiles.has(file.path);
    const wasInvalidated = state.invalidatedFiles.has(file.path);
    const item = make(
      'div',
      `file-item${file.path === state.activeFile ? ' active' : ''}${isReviewed ? ' reviewed' : ''}${wasInvalidated ? ' review-invalidated' : ''}`
    );
    const reviewedCheckbox = make('input', 'file-review-checkbox');
    reviewedCheckbox.type = 'checkbox';
    reviewedCheckbox.checked = isReviewed;
    reviewedCheckbox.title = `${isReviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}: ${file.path}`;
    reviewedCheckbox.setAttribute('aria-label', reviewedCheckbox.title);
    reviewedCheckbox.addEventListener('change', () => {
      setFileReviewed(file.path, reviewedCheckbox.checked, reviewedCheckbox);
    });
    const selectButton = make('button', 'file-select');
    selectButton.type = 'button';
    selectButton.title = file.path;
    selectButton.addEventListener('click', () => selectFile(file.path));
    const name = make('span', 'file-name');
    name.append(make('span', 'file-dir', directory(file.path)), basename(file.path));
    const stats = make('span', 'file-stats');
    if (wasInvalidated) stats.append(make('span', 'review-state invalidated', '↻'));
    stats.append(make('span', 'added', `+${file.additions}`), make('span', 'deleted', `−${file.deletions}`));
    selectButton.append(name, stats);
    item.append(reviewedCheckbox, selectButton);
    elements.fileList.append(item);
  }
}

async function setFileReviewed(file, reviewed, checkbox) {
  checkbox.disabled = true;
  try {
    await api(`/api/reviews/${state.review.id}/reviewed-files`, {
      method: 'POST',
      body: JSON.stringify({ file, reviewed })
    });
    if (reviewed) {
      state.reviewedFiles.add(file);
      state.invalidatedFiles.delete(file);
      showToast(`${basename(file)} marked as reviewed`);
    } else {
      state.reviewedFiles.delete(file);
    }
    renderSidebar();
  } catch (error) {
    checkbox.disabled = false;
    checkbox.checked = !reviewed;
    showToast(error.message, 'error');
  }
}

function renderThread(thread) {
  if (state.hiddenThreads.has(thread.id)) {
    const hidden = make('div', 'thread thread-hidden');
    const summary = make('span', '', `Conversation hidden · ${thread.comments.length} message${thread.comments.length === 1 ? '' : 's'}`);
    const show = make('button', 'thread-visibility', 'Show conversation');
    show.type = 'button';
    show.setAttribute('aria-expanded', 'false');
    show.addEventListener('click', () => {
      state.hiddenThreads.delete(thread.id);
      renderReview();
    });
    hidden.append(summary, show);
    return hidden;
  }

  const container = make('div', 'thread');
  const toolbar = make('div', 'thread-toolbar');
  toolbar.append(make('span', '', `${thread.comments.length} message${thread.comments.length === 1 ? '' : 's'}`));
  const hide = make('button', 'thread-visibility', 'Hide conversation');
  hide.type = 'button';
  hide.setAttribute('aria-expanded', 'true');
  hide.addEventListener('click', () => {
    state.hiddenThreads.add(thread.id);
    renderReview();
  });
  toolbar.append(hide);
  container.append(toolbar);
  for (const comment of thread.comments) {
    const item = make('article', `comment ${comment.author}`);
    const header = make('header', 'comment-header');
    header.append(
      make('strong', '', comment.author === 'you' ? 'You' : 'LLM agent'),
      make('span', '', new Date(comment.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    );
    const body = make('div', 'comment-body', comment.body);
    item.append(header, body);
    container.append(item);
  }
  const status = make('div', `thread-status ${thread.status}`);
  if (thread.status === 'queued') {
    status.append(make('span', '', 'Queued — waiting for the current agent reply'));
    if (!thread.temporary) {
      const cancel = make('button', 'queue-cancel', 'Delete');
      cancel.type = 'button';
      cancel.addEventListener('click', () => cancelQueuedThread(thread.id, cancel));
      status.append(cancel);
    }
  }
  if (thread.status === 'sending') status.textContent = 'Sending to tmux…';
  if (thread.status === 'sent') status.textContent = 'Waiting for the agent…';
  if (thread.status === 'failed') status.textContent = `Delivery failed: ${thread.error || 'unknown error'}`;
  if (thread.status === 'timed_out') status.textContent = thread.error || 'The agent reply timed out.';
  if (thread.status !== 'replied') container.append(status);
  return container;
}

async function cancelQueuedThread(threadId, button) {
  button.disabled = true;
  button.textContent = 'Deleting…';
  try {
    await api(`/api/reviews/${state.review.id}/threads/${threadId}`, { method: 'DELETE' });
    state.threads.delete(threadId);
    state.hiddenThreads.delete(threadId);
    renderSidebar();
    renderReview();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Delete';
    showToast(error.message, 'error');
  }
}

async function submitComment({ kind = 'inline', file = null, side = null, line = null, body }) {
  const text = body.trim();
  if (!text) return;
  const optimisticKey = crypto.randomUUID();
  const optimistic = {
    id: optimisticKey,
    reviewId: state.review.id,
    kind,
    file,
    side,
    line,
    status: 'queued',
    temporary: true,
    comments: [{ id: optimisticKey, author: 'you', body: text, createdAt: new Date().toISOString() }]
  };
  state.threads.set(optimisticKey, optimistic);
  if (kind === 'general') state.generalDraft = '';
  else state.composing = null;
  renderSidebar();
  renderReview();
  try {
    const thread = await api(`/api/reviews/${state.review.id}/comments`, {
      method: 'POST', body: JSON.stringify({ kind, file, side, line, body: text })
    });
    state.threads.delete(optimisticKey);
    state.threads.set(thread.id, thread);
    renderSidebar();
    renderReview();
  } catch (error) {
    state.threads.delete(optimisticKey);
    if (kind === 'general') state.generalDraft = text;
    if (error.payload?.id) state.threads.set(error.payload.id, error.payload);
    renderSidebar();
    renderReview();
    showToast(error.message, 'error');
  }
}

function renderComposer(file, side, line) {
  const form = make('form', 'comment-form');
  const title = make('div', 'comment-form-title', `Comment on ${side === 'old' ? 'old' : 'new'} line ${line}`);
  const textarea = make('textarea');
  textarea.placeholder = 'Leave a review comment for the agent…';
  textarea.rows = 3;
  textarea.required = true;
  const actions = make('div', 'comment-form-actions');
  const cancel = make('button', 'button subtle', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => { state.composing = null; renderReview(); });
  const submit = make('button', 'button primary', 'Send to agent');
  submit.type = 'submit';
  actions.append(cancel, submit);
  form.append(title, textarea, actions);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Sending…';
    await submitComment({ file, side, line, body: textarea.value });
  });
  setTimeout(() => textarea.focus(), 0);
  return form;
}

function renderGeneralComposer() {
  const form = make('form', 'comment-form general-composer');
  const title = make('div', 'comment-form-title', 'Send a general request to the agent');
  const textarea = make('textarea');
  textarea.placeholder = 'Ask a question or request work that is not tied to a specific line…';
  textarea.rows = 4;
  textarea.required = true;
  textarea.value = state.generalDraft;
  textarea.addEventListener('input', () => { state.generalDraft = textarea.value; });
  const actions = make('div', 'comment-form-actions');
  const submit = make('button', 'button primary', 'Send to agent');
  submit.type = 'submit';
  actions.append(submit);
  form.append(title, textarea, actions);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!textarea.value.trim()) return;
    submit.disabled = true;
    submit.textContent = 'Sending…';
    await submitComment({ kind: 'general', body: textarea.value });
  });
  return form;
}

function renderGeneralDiscussion() {
  const page = make('section', 'general-discussion');
  const header = make('div', 'general-header');
  header.append(
    make('h1', '', 'General discussion'),
    make('p', '', 'Send requests or questions that are not attached to a specific code line.')
  );
  const conversation = make('div', 'general-conversation');
  const generalThreads = Array.from(state.threads.values()).filter((thread) => thread.kind === 'general');
  if (!generalThreads.length) {
    conversation.append(make('div', 'general-empty', 'No general messages yet.'));
  } else {
    for (const thread of generalThreads) conversation.append(renderThread(thread));
  }
  page.append(header, conversation, renderGeneralComposer());
  elements.reviewContent.append(page);
}

function lineCell(file, side, line, rowType) {
  const cell = make('td', `line-number ${side} ${rowType}`);
  if (!line) return cell;
  const button = make('button', 'line-button', String(line));
  button.type = 'button';
  button.title = `Comment on ${side} line ${line}`;
  if (threadsAt(file, side, line).length) button.classList.add('has-thread');
  button.addEventListener('click', () => {
    state.composing = { file, side, line };
    renderReview();
  });
  cell.append(button);
  return cell;
}

function codeCell(entry, rowType, side) {
  const cell = make('td', `code ${side} ${rowType}`);
  if (entry) {
    cell.append(make('span', 'change-marker', rowType === 'addition' ? '+' : rowType === 'deletion' ? '−' : ' '));
    cell.append(make('code', '', entry.text));
  }
  return cell;
}

function hunkContextKey(file, hunkIndex) {
  return `${file}\0${hunkIndex}`;
}

function hunkView(file, hunk, hunkIndex) {
  const key = hunkContextKey(file, hunkIndex);
  const context = state.hunkContext.get(key) || { above: 3, below: 3 };
  state.hunkContext.set(key, context);
  const changed = hunk.rows.map((row, index) => row.type === 'context' ? -1 : index).filter((index) => index >= 0);
  if (!changed.length) return { hunk, context, cachedAbove: false, cachedBelow: false, loadAbove: false, loadBelow: false };
  const firstChange = changed[0];
  const lastChange = changed[changed.length - 1];
  const start = Math.max(0, firstChange - context.above);
  const end = Math.min(hunk.rows.length, lastChange + context.below + 1);
  const availableAbove = firstChange;
  const availableBelow = hunk.rows.length - lastChange - 1;
  return {
    hunk: { ...hunk, rows: hunk.rows.slice(start, end) },
    context,
    cachedAbove: start > 0,
    cachedBelow: end < hunk.rows.length,
    loadAbove: start === 0 && availableAbove >= state.loadedContextLines && state.loadedContextLines < 500,
    loadBelow: end === hunk.rows.length && availableBelow >= state.loadedContextLines && state.loadedContextLines < 500
  };
}

function rerenderPreservingHunk(hunkIndex) {
  const selector = `.hunk[data-hunk-index="${hunkIndex}"] [data-change-anchor="true"]`;
  const oldTop = elements.reviewContent.querySelector(selector)?.getBoundingClientRect().top;
  renderReview();
  const newTop = elements.reviewContent.querySelector(selector)?.getBoundingClientRect().top;
  if (oldTop !== undefined && newTop !== undefined) elements.reviewContent.scrollTop += newTop - oldTop;
}

function expandHunkContext(file, hunkIndex, direction, view) {
  view.context[direction] = Math.min(500, view.context[direction] + 10);
  state.hunkContext.set(hunkContextKey(file, hunkIndex), view.context);
  const hasCachedRows = direction === 'above' ? view.cachedAbove : view.cachedBelow;
  const canLoadMore = direction === 'above' ? view.loadAbove : view.loadBelow;
  if (hasCachedRows || !canLoadMore) {
    rerenderPreservingHunk(hunkIndex);
    return;
  }
  const requestedContext = Math.min(500, Math.max(
    state.prefetchContextLines,
    state.loadedContextLines * 2,
    view.context[direction]
  ));
  refreshDiff({ preserveScroll: true, requestedContext, anchorHunkIndex: hunkIndex });
}

function contextExpander(direction, file, hunkIndex, view) {
  const container = make('div', `context-expander ${direction}`);
  const hasCachedRows = direction === 'above' ? view.cachedAbove : view.cachedBelow;
  const canLoadMore = direction === 'above' ? view.loadAbove : view.loadBelow;
  const expandable = hasCachedRows || canLoadMore;
  const button = make(
    'button',
    'context-button',
    expandable
      ? `${direction === 'above' ? '↑' : '↓'} ${hasCachedRows ? 'Show' : 'Load'} more ${direction}`
      : `No more context ${direction}`
  );
  button.type = 'button';
  button.disabled = !expandable;
  button.addEventListener('click', () => expandHunkContext(file, hunkIndex, direction, view));
  container.append(button);
  return container;
}

function appendThreadRows(body, file, locations, colSpan, unified = false) {
  for (const location of locations) {
    const found = threadsAt(file, location.side, location.line);
    const isComposing = state.composing && threadKey(state.composing.file, state.composing.side, state.composing.line) ===
      threadKey(file, location.side, location.line);
    if (!found.length && !isComposing) continue;
    const threadRow = document.createElement('tr');
    threadRow.className = 'thread-row';
    const threadCell = make('td', `thread-cell ${unified ? 'unified' : location.side}`);
    threadCell.colSpan = colSpan;
    for (const thread of found) threadCell.append(renderThread(thread));
    if (isComposing) threadCell.append(renderComposer(file, location.side, location.line));
    threadRow.append(threadCell);
    body.append(threadRow);
  }
}

function renderSideBySideHunk(file, hunk) {
  const table = make('table', 'diff-table side-by-side');
  const colgroup = document.createElement('colgroup');
  for (const className of ['line-col', 'code-col', 'line-col', 'code-col']) colgroup.append(make('col', className));
  table.append(colgroup);
  const body = document.createElement('tbody');
  let anchored = false;
  for (const row of hunk.rows) {
    const tr = document.createElement('tr');
    if (!anchored && row.type !== 'context') {
      tr.dataset.changeAnchor = 'true';
      anchored = true;
    }
    const oldType = row.old && row.type !== 'context' ? 'deletion' : row.old ? 'context' : 'empty';
    const newType = row.new && row.type !== 'context' ? 'addition' : row.new ? 'context' : 'empty';
    tr.append(
      lineCell(file, 'old', row.old?.line, oldType),
      codeCell(row.old, oldType, 'old'),
      lineCell(file, 'new', row.new?.line, newType),
      codeCell(row.new, newType, 'new')
    );
    body.append(tr);
    const locations = [];
    if (row.old) locations.push({ side: 'old', line: row.old.line });
    if (row.new) locations.push({ side: 'new', line: row.new.line });
    appendThreadRows(body, file, locations, 4);
  }
  table.append(body);
  return table;
}

function renderUnifiedHunk(file, hunk) {
  const table = make('table', 'diff-table unified');
  const colgroup = document.createElement('colgroup');
  for (const className of ['line-col', 'line-col', 'unified-code-col']) colgroup.append(make('col', className));
  table.append(colgroup);
  const body = document.createElement('tbody');
  let anchored = false;

  for (const row of hunk.rows) {
    if (row.type === 'context') {
      const tr = document.createElement('tr');
      tr.append(
        lineCell(file, 'old', row.old?.line, 'context'),
        lineCell(file, 'new', row.new?.line, 'context'),
        codeCell(row.new || row.old, 'context', 'unified')
      );
      body.append(tr);
      const locations = [];
      if (row.old) locations.push({ side: 'old', line: row.old.line });
      if (row.new) locations.push({ side: 'new', line: row.new.line });
      appendThreadRows(body, file, locations, 3, true);
      continue;
    }
    if (row.old) {
      const deletion = document.createElement('tr');
      if (!anchored) {
        deletion.dataset.changeAnchor = 'true';
        anchored = true;
      }
      deletion.append(
        lineCell(file, 'old', row.old.line, 'deletion'),
        lineCell(file, 'new', null, 'deletion'),
        codeCell(row.old, 'deletion', 'unified')
      );
      body.append(deletion);
      appendThreadRows(body, file, [{ side: 'old', line: row.old.line }], 3, true);
    }
    if (row.new) {
      const addition = document.createElement('tr');
      if (!anchored) {
        addition.dataset.changeAnchor = 'true';
        anchored = true;
      }
      addition.append(
        lineCell(file, 'old', null, 'addition'),
        lineCell(file, 'new', row.new.line, 'addition'),
        codeCell(row.new, 'addition', 'unified')
      );
      body.append(addition);
      appendThreadRows(body, file, [{ side: 'new', line: row.new.line }], 3, true);
    }
  }
  table.append(body);
  return table;
}

function renderReview() {
  elements.reviewContent.replaceChildren();
  if (state.generalSelected) {
    renderGeneralDiscussion();
    return;
  }
  const file = state.files.find((entry) => entry.path === state.activeFile);
  if (!file) {
    const empty = make('div', 'empty-state');
    empty.append(make('div', 'empty-icon', '✓'), make('h1', '', 'No changes to display'), make('p', '', 'No changes match the current base branch and diff options.'));
    elements.reviewContent.append(empty);
    return;
  }

  const fileHeader = make('div', 'file-header');
  const title = make('div');
  title.append(make('h1', '', file.path), make('p', '', `${file.additions} additions and ${file.deletions} deletions`));
  const fileActions = make('div', 'file-actions');
  const hasExpandedContext = Array.from(state.hunkContext.entries()).some(
    ([key, value]) => key.startsWith(`${file.path}\0`) && (value.above > 3 || value.below > 3)
  );
  if (hasExpandedContext) {
    const resetContext = make('button', 'button subtle', 'Reset context');
    resetContext.type = 'button';
    resetContext.addEventListener('click', () => {
      for (const key of Array.from(state.hunkContext.keys())) {
        if (key.startsWith(`${file.path}\0`)) state.hunkContext.delete(key);
      }
      renderReview();
    });
    fileActions.append(resetContext);
  }
  fileHeader.append(title, fileActions);
  elements.reviewContent.append(fileHeader);

  if (!file.hunks.length) {
    const notice = make('div', 'binary-notice', file.metadata.join('\n') || 'This file has no textual diff.');
    elements.reviewContent.append(notice);
    return;
  }

  file.hunks.forEach((hunk, hunkIndex) => {
    const view = hunkView(file.path, hunk, hunkIndex);
    const wrapper = make('section', 'hunk');
    wrapper.dataset.hunkIndex = String(hunkIndex);
    wrapper.append(contextExpander('above', file.path, hunkIndex, view));
    const hunkHeader = make('div', 'hunk-header');
    hunkHeader.append(make('code', '', hunk.header));
    wrapper.append(hunkHeader);
    wrapper.append(state.unifiedDiff ? renderUnifiedHunk(file.path, view.hunk) : renderSideBySideHunk(file.path, view.hunk));
    wrapper.append(contextExpander('below', file.path, hunkIndex, view));
    elements.reviewContent.append(wrapper);
  });
}

function renderSession() {
  elements.sessionDot.classList.toggle('connected', state.connected);
  elements.sessionLabel.replaceChildren();
  if (state.review) {
    const paneLabel = make('span', 'session-pane', `· ${state.review.paneId}`);
    paneLabel.title = `tmux pane ID ${state.review.paneId} — review prompts are sent to this pinned pane`;
    elements.sessionLabel.append(
      make('span', 'session-name', state.review.session),
      paneLabel
    );
    elements.sessionButton.title = `${state.review.session} · ${state.review.paneId}`;
  } else {
    elements.sessionLabel.textContent = 'Configure review';
    elements.sessionButton.title = '';
  }
  elements.repoName.textContent = state.review
    ? `${state.review.worktree} · base ${state.review.baseBranch}`
    : 'Configure this review';
  elements.repoName.title = state.review?.worktree || '';
}

function render() {
  renderSidebar();
  renderReview();
  renderSession();
}

function showReviewModal(required = false) {
  const bootstrap = state.bootstrap;
  elements.worktreeInput.value = state.review?.worktree || bootstrap?.suggestedWorktree || '';
  elements.branchInput.value = state.review?.baseBranch || bootstrap?.defaultBranch || '';
  elements.sessionInput.value = state.review?.session || bootstrap?.suggestedSession || '';
  elements.sessionOptions.replaceChildren();
  for (const session of bootstrap?.sessions || []) {
    const option = document.createElement('option');
    option.value = session;
    elements.sessionOptions.append(option);
  }
  elements.sessionHelp.textContent = bootstrap?.sessions?.length
    ? 'This browser tab owns one worktree, base branch, and tmux-session binding.'
    : 'No tmux sessions are running. Start the LLM agent in tmux, then configure this page.';
  elements.sessionError.textContent = '';
  elements.sessionCancel.classList.toggle('hidden', required);
  elements.sessionModal.classList.remove('hidden');
  setTimeout(() => elements.worktreeInput.focus(), 0);
}

function hideReviewModal() {
  elements.sessionModal.classList.add('hidden');
}

async function loadBootstrap() {
  state.bootstrap = await api('/api/bootstrap');
}

async function refreshStatus() {
  if (!state.review) return;
  const wasConnected = state.connected;
  const result = await api(`/api/reviews/${state.review.id}/status`);
  state.connected = result.connected;
  state.bootstrap.sessions = result.sessions;
  renderSession();
  if (wasConnected && !result.connected) showToast(`tmux session disconnected: ${state.review.session}`, 'error');
}

function startEvents() {
  if (events) events.close();
  events = new EventSource(`/api/reviews/${state.review.id}/events`);
  events.addEventListener('thread', (event) => {
    const thread = JSON.parse(event.data);
    if (thread.reviewId !== state.review?.id) return;
    state.threads.set(thread.id, thread);
    renderSidebar();
    renderReview();
    if (thread.status === 'replied') {
      showToast(thread.kind === 'general'
        ? 'Agent replied in General discussion'
        : `Agent replied on ${thread.file}:${thread.line}`);
    }
  });
  events.addEventListener('thread-deleted', (event) => {
    const id = JSON.parse(event.data).id;
    state.threads.delete(id);
    state.hiddenThreads.delete(id);
    renderSidebar();
    renderReview();
  });
}

let refreshingDiff = false;

async function refreshDiff({ background = false, preserveScroll = false, requestedContext = null, anchorHunkIndex = null } = {}) {
  if (!state.review || refreshingDiff) return;
  refreshingDiff = true;
  if (!background) {
    elements.refreshButton.disabled = true;
    elements.refreshButton.textContent = 'Refreshing…';
  }
  try {
    const query = new URLSearchParams();
    if (state.ignoreWhitespace) query.set('ignoreWhitespace', '1');
    const contextRequest = Math.min(500, Math.max(
      3,
      requestedContext || 0,
      state.prefetchContextLines,
      state.loadedContextLines
    ));
    query.set('context', String(contextRequest));
    const queryString = query.size ? `?${query}` : '';
    const anchorSelector = anchorHunkIndex === null
      ? null
      : `.hunk[data-hunk-index="${anchorHunkIndex}"] [data-change-anchor="true"]`;
    const previousAnchorTop = anchorSelector
      ? elements.reviewContent.querySelector(anchorSelector)?.getBoundingClientRect().top
      : undefined;
    const result = await api(`/api/reviews/${state.review.id}/diff${queryString}`);
    const previousDiff = state.rawDiff;
    const previousScrollTop = elements.reviewContent.scrollTop;
    const previousActiveFile = state.activeFile;
    state.rawDiff = result.diff;
    state.loadedContextLines = result.contextLines || contextRequest;
    state.files = parseDiff(result.diff);
    state.threads = new Map(result.threads.map((thread) => [thread.id, thread]));
    state.reviewedFiles = new Set(result.reviewedFiles || []);
    for (const file of result.invalidatedFiles || []) {
      state.invalidatedFiles.add(file);
      showToast(`${basename(file)} changed and needs review again`, 'warning');
    }
    if (!state.files.some((file) => file.path === state.activeFile)) state.activeFile = state.files[0]?.path || null;
    if (background && (state.composing || state.generalSelected)) {
      renderSidebar();
    } else if (!background || previousDiff !== result.diff || (result.invalidatedFiles || []).length) {
      render();
      const nextAnchorTop = anchorSelector
        ? elements.reviewContent.querySelector(anchorSelector)?.getBoundingClientRect().top
        : undefined;
      if (previousAnchorTop !== undefined && nextAnchorTop !== undefined) {
        elements.reviewContent.scrollTop += nextAnchorTop - previousAnchorTop;
      } else if ((background || preserveScroll) && previousDiff && state.activeFile === previousActiveFile) {
        elements.reviewContent.scrollTop = previousScrollTop;
      }
    } else {
      renderSidebar();
    }
  } catch (error) {
    if (!background) {
      elements.reviewContent.replaceChildren();
      const empty = make('div', 'empty-state error-state');
      empty.append(make('div', 'empty-icon', '!'), make('h1', '', 'Could not read changes'), make('p', '', error.message));
      elements.reviewContent.append(empty);
    }
  } finally {
    refreshingDiff = false;
    if (!background) {
      elements.refreshButton.disabled = false;
      elements.refreshButton.textContent = 'Refresh changes';
    }
  }
}

let worktreeLookupTimer = null;
let worktreeLookupVersion = 0;
let branchManuallyEdited = false;
elements.branchInput.addEventListener('input', () => { branchManuallyEdited = true; });
elements.worktreeInput.addEventListener('input', () => {
  const enteredPath = elements.worktreeInput.value.trim();
  const directoryName = enteredPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  elements.sessionInput.value = directoryName;
  branchManuallyEdited = false;
  elements.branchInput.value = '';
  elements.branchInput.placeholder = enteredPath ? 'Detecting default branch…' : '';
  elements.sessionError.textContent = '';
  const version = ++worktreeLookupVersion;
  clearTimeout(worktreeLookupTimer);
  if (!enteredPath) return;
  worktreeLookupTimer = setTimeout(async () => {
    try {
      const info = await api(`/api/worktree-info?path=${encodeURIComponent(enteredPath)}`);
      if (version !== worktreeLookupVersion) return;
      if (!branchManuallyEdited) elements.branchInput.value = info.defaultBranch || '';
      elements.branchInput.placeholder = '';
    } catch (error) {
      if (version !== worktreeLookupVersion) return;
      elements.branchInput.placeholder = '';
      elements.sessionError.textContent = error.message;
    }
  }, 350);
});

elements.refreshButton.addEventListener('click', () => refreshDiff());
elements.showChangedFiles.addEventListener('change', () => {
  setSidebarVisibility(elements.showChangedFiles.checked);
});
elements.ignoreWhitespace.addEventListener('change', () => {
  state.ignoreWhitespace = elements.ignoreWhitespace.checked;
  localStorage.setItem('agentic-review-ignore-whitespace', String(state.ignoreWhitespace));
  state.rawDiff = '';
  refreshDiff();
});
elements.unifiedDiff.addEventListener('change', () => {
  state.unifiedDiff = elements.unifiedDiff.checked;
  localStorage.setItem('agentic-review-unified-diff', String(state.unifiedDiff));
  const scrollTop = elements.reviewContent.scrollTop;
  renderReview();
  elements.reviewContent.scrollTop = scrollTop;
});
elements.contextPrefetch.addEventListener('change', () => {
  const value = Math.max(10, Math.min(500, Number.parseInt(elements.contextPrefetch.value, 10) || 30));
  state.prefetchContextLines = value;
  elements.contextPrefetch.value = String(value);
  localStorage.setItem('agentic-review-context-prefetch', String(value));
  if (state.review && value > state.loadedContextLines) {
    refreshDiff({ preserveScroll: true, requestedContext: value });
  }
});
elements.sessionButton.addEventListener('click', async () => {
  await loadBootstrap();
  showReviewModal(false);
});
elements.sessionCancel.addEventListener('click', hideReviewModal);
elements.sessionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.review && state.threads.size && !window.confirm('Changing this review clears its current in-memory threads. Continue?')) return;
  elements.sessionError.textContent = '';
  try {
    const previousReview = state.review;
    const result = await api('/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        worktree: elements.worktreeInput.value.trim(),
        session: elements.sessionInput.value.trim(),
        baseBranch: elements.branchInput.value.trim()
      })
    });
    state.review = result.review;
    state.connected = true;
    state.files = [];
    state.rawDiff = '';
    state.loadedContextLines = 0;
    state.hunkContext = new Map();
    state.reviewedFiles = new Set();
    state.invalidatedFiles = new Set();
    state.hiddenThreads = new Set();
    state.threads = new Map();
    state.activeFile = null;
    state.composing = null;
    state.generalSelected = false;
    state.generalDraft = '';
    document.title = `${state.review.label} · agentic-review`;
    hideReviewModal();
    startEvents();
    if (previousReview) {
      api(`/api/reviews/${previousReview.id}`, { method: 'DELETE' }).catch(() => {});
    }
    await refreshDiff();
    showToast(`Reviewing ${state.review.label} with ${state.review.session}`);
  } catch (error) {
    elements.sessionError.textContent = error.message;
  }
});

state.showChangedFiles = localStorage.getItem('agentic-review-show-changed-files') !== 'false';
state.ignoreWhitespace = localStorage.getItem('agentic-review-ignore-whitespace') === 'true';
state.unifiedDiff = localStorage.getItem('agentic-review-unified-diff') === 'true';
const savedContextPrefetch = Number.parseInt(localStorage.getItem('agentic-review-context-prefetch'), 10);
state.prefetchContextLines = Math.max(10, Math.min(500, Number.isFinite(savedContextPrefetch) ? savedContextPrefetch : 30));
elements.showChangedFiles.checked = state.showChangedFiles;
elements.ignoreWhitespace.checked = state.ignoreWhitespace;
elements.unifiedDiff.checked = state.unifiedDiff;
elements.contextPrefetch.value = String(state.prefetchContextLines);

loadBootstrap()
  .then(() => showReviewModal(true))
  .catch((error) => showToast(error.message, 'error'));

setInterval(() => refreshStatus().catch(() => {}), 10000);
setInterval(() => {
  if (!document.hidden) refreshDiff({ background: true }).catch(() => {});
}, 8000);

window.addEventListener('pagehide', () => {
  if (state.review) {
    fetch(`/api/reviews/${state.review.id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  }
});

const defaultSidebarWidth = 250;

function setSidebarVisibility(visible, persist = true) {
  state.showChangedFiles = visible;
  elements.showChangedFiles.checked = visible;
  elements.workspace.classList.toggle('sidebar-hidden', !visible);
  if (persist) localStorage.setItem('agentic-review-show-changed-files', String(visible));
}

setSidebarVisibility(state.showChangedFiles, false);

function sidebarWidthBounds() {
  return { min: 180, max: Math.max(180, Math.min(600, elements.workspace.clientWidth - 320)) };
}

function setSidebarWidth(width, persist = true) {
  const bounds = sidebarWidthBounds();
  const nextWidth = Math.round(Math.max(bounds.min, Math.min(bounds.max, width)));
  elements.workspace.style.setProperty('--sidebar-width', `${nextWidth}px`);
  elements.sidebarResizer.setAttribute('aria-valuemax', String(bounds.max));
  elements.sidebarResizer.setAttribute('aria-valuenow', String(nextWidth));
  if (persist) localStorage.setItem('agentic-review-sidebar-width', String(nextWidth));
}

const savedSidebarWidth = Number(localStorage.getItem('agentic-review-sidebar-width'));
setSidebarWidth(Number.isFinite(savedSidebarWidth) && savedSidebarWidth > 0 ? savedSidebarWidth : defaultSidebarWidth, false);

elements.sidebarResizer.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  elements.sidebarResizer.setPointerCapture(event.pointerId);
  elements.sidebarResizer.classList.add('dragging');
  document.body.classList.add('resizing-sidebar');
});

elements.sidebarResizer.addEventListener('pointermove', (event) => {
  if (!elements.sidebarResizer.hasPointerCapture(event.pointerId)) return;
  const workspaceLeft = elements.workspace.getBoundingClientRect().left;
  setSidebarWidth(event.clientX - workspaceLeft);
});

function stopSidebarResize(event) {
  if (elements.sidebarResizer.hasPointerCapture(event.pointerId)) {
    elements.sidebarResizer.releasePointerCapture(event.pointerId);
  }
  elements.sidebarResizer.classList.remove('dragging');
  document.body.classList.remove('resizing-sidebar');
}

elements.sidebarResizer.addEventListener('pointerup', stopSidebarResize);
elements.sidebarResizer.addEventListener('pointercancel', stopSidebarResize);
elements.sidebarResizer.addEventListener('dblclick', () => setSidebarWidth(defaultSidebarWidth));
elements.sidebarResizer.addEventListener('keydown', (event) => {
  const currentWidth = Number.parseInt(getComputedStyle(elements.workspace).getPropertyValue('--sidebar-width'), 10);
  if (event.key === 'ArrowLeft') setSidebarWidth(currentWidth - 20);
  else if (event.key === 'ArrowRight') setSidebarWidth(currentWidth + 20);
  else if (event.key === 'Home') setSidebarWidth(defaultSidebarWidth);
  else return;
  event.preventDefault();
});

window.addEventListener('resize', () => {
  const currentWidth = Number.parseInt(getComputedStyle(elements.workspace).getPropertyValue('--sidebar-width'), 10);
  setSidebarWidth(currentWidth, false);
});
