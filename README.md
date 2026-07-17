# agent-diff

`agent-diff` is a local, GitHub-style review surface for code changed by an LLM agent. It reads a Git working-tree diff, supports both line-specific comments and general requests, sends each message to an agent running in tmux, and displays the agent's socket-delivered reply in the originating conversation.

The prototype keeps every conversation in memory. It does not create review files, modify the repository, or send code to a hosted service.

## What works

- Side-by-side diffs for committed, staged, unstaged, and untracked changes since a configurable base branch
- Optional unified layout and Git-backed whitespace filtering
- Expandable context above and below each diff hunk
- Horizontal review-pane scrolling for long source lines
- A resizable changed-file sidebar that can be hidden for more review space
- Inline comments on either side of a diff
- A General discussion screen for requests not tied to a code line
- Per-file reviewed marks that are removed when the file's diff changes
- Serialized comment delivery with cancellable queued comments
- Collapsible inline and general conversations that retain their full history
- A required worktree/base-branch/session setup form for every browser tab
- Independent review contexts across multiple browser tabs
- Safe prompt injection through `tmux load-buffer` / `paste-buffer`
- Authenticated replies over a localhost HTTP socket
- Live replies through server-sent events

## Requirements

- Node.js 18 or newer
- Git
- tmux
- A terminal-based LLM agent running inside tmux

On Windows, run the prototype and the agent inside WSL so that tmux is available. Open the UI from either the WSL or Windows browser at the printed localhost address.

## Run it

For development, run from this directory:

```bash
npm start
```

Then open `http://127.0.0.1:4173`. Each browser tab asks for the Git worktree path, base branch, and tmux session name it should use.

To use it as a command, link it once:

```bash
cd /path/to/agent-diff
npm link
cd /path/to/repository
agent-diff
```

In that form, the current directory is suggested in the setup form. Entering a worktree automatically derives the session name from its directory and detects its default branch. Both suggestions remain editable.

Set a different suggested worktree with an environment variable:

```bash
AGENT_DIFF_REPO=/path/to/repository npm start
```

Override the port with `AGENT_DIFF_PORT`.

For the smoothest startup, name the agent's tmux session after the repository directory:

```bash
tmux new-session -s "$(basename /path/to/repository)"
```

Then launch the LLM agent in that session. The setup form lists existing sessions and accepts any exact session name.

## Review loop

1. Open agent-diff in a browser tab.
2. Enter the worktree path. Confirm or edit the derived base branch and tmux session name.
3. Start the review. The diff includes feature-branch commits plus staged, unstaged, and untracked changes since the merge base.
4. Select a changed file from the sidebar.
5. Click an old or new line number.
6. Write the inline comment and select **Send to agent**.
7. agent-diff queues the comment. If no earlier comment is waiting for a reply, it pastes the request into that page's tmux session and presses Enter.
8. The request tells the agent how to inspect the location and includes the configured base branch, a reply URL, thread ID, and bearer token.
9. The agent posts its response to the localhost endpoint; the reply appears in the originating browser tab immediately.

For a request that is not tied to a line, select **General discussion** at the top of the **Changed files** pane. Its chat screen accepts questions and work requests and uses the same serialized delivery queue as inline comments. A count beside the item shows how many general conversations exist in the current review.

Only one comment per review context waits for the agent at a time. Later comments remain visibly queued and can be deleted before delivery. An agent reply, delivery failure, or reply timeout advances the queue. The default timeout is five minutes and can be changed with `AGENT_DIFF_REPLY_TIMEOUT_MS`.

After pasting a prompt, agent-diff waits one second before sending Enter as a separate tmux input. This gives terminal agents time to finish processing the multiline paste before submission. Adjust the delay in milliseconds for faster or slower agents using `AGENT_DIFF_SUBMIT_DELAY_MS`.

After finishing a file, select its checkbox in the **Changed files** list. agent-diff stores a fingerprint of that file's current patch. It checks for local changes in the background; if the patch changes, the checkbox is cleared, the file receives a needs-review indicator, and a notification is shown.

Select **Hide conversation** when a discussion is finished. Its comments and replies collapse into a compact summary without being deleted; **Show conversation** restores the thread.

Use **Ignore whitespace** to suppress whitespace-only changes and **Unified diff** to switch from the default side-by-side layout. These visualization preferences are saved in the browser. Reviewed fingerprints always use the complete unfiltered patch.

Clear **Show changed files** to hide the left sidebar and give the diff the full page width. Re-enable it to restore the sidebar at its previous width. This preference is also saved in the browser.

Each page preloads 30 context lines from Git while initially showing only three. **Show more above** and **Show more below** reveal those cached rows entirely in the browser and keep the first changed line stationary. When the cache is exhausted, agent-diff requests a larger buffer and continues up to 500 lines. Change the preload size with the **Context cache** option in the top bar, or use **Reset context** to collapse a file back to three visible lines.

Open another browser tab to review another worktree or communicate with another agent. The server keeps each page's worktree/base-branch/session binding under a unique review-context ID so requests cannot accidentally combine values from different pages.

The injected prompt treats each comment as a code-review instruction. When a comment requests a change, the agent is told to edit the worktree and run appropriate focused checks before replying—not merely promise the edit. Questions and explanation-only comments are answered without modifying files.

## Current prototype boundaries

- Review contexts and threads disappear when the server stops; reloading a page currently starts a new setup flow.
- Reviewed marks and queued comments are also transient and belong to the browser page's review context.
- The app pins review delivery to the selected session's first pane (`session:0.0`), regardless of later window switching.
- Comments and replies are plain text; Markdown rendering and suggested patches are future work.
- The localhost reply token is shared only in the injected prompt and changes on each server start.

## Architecture

The Node server owns four small responsibilities: invoke Git, keep transient threads, paste review prompts into tmux, and expose the localhost reply/event endpoints. The browser parses unified diffs and renders the review interface. There are no runtime package dependencies and no build step.

Useful endpoints while developing:

- `GET /api/bootstrap` — setup suggestions and available tmux sessions
- `GET /api/worktree-info?path=...` — derived session name and detected default branch
- `POST /api/reviews` — validate and create a page-scoped review context
- `GET /api/reviews/:id/status` — context and connection state
- `GET /api/reviews/:id/diff` — that context's unified diff and threads
- `POST /api/reviews/:id/comments` — create and enqueue a scoped inline or general comment
- `DELETE /api/reviews/:id/threads/:threadId` — delete a comment that is still queued
- `POST /api/reviews/:id/reviewed-files` — mark or unmark a file at its current patch fingerprint
- `DELETE /api/reviews/:id` — release a page's transient context
- `POST /api/replies` — authenticated callback used by the agent
- `GET /api/reviews/:id/events` — live updates for one browser page

Run static checks with:

```bash
npm run check
```
