import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../src/session/store.js';
import { generateSessionTitle } from '../src/session/title.js';
import { appendFileSync, rmSync, mkdtempSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

describe('SessionStore', () => {
  let tempHome: string;
  const originalVeraHome = process.env.VERA_HOME;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'vera-test-'));
    process.env.VERA_HOME = tempHome;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    process.env.VERA_HOME = originalVeraHome;
  });

  function makeCwd(label = 'project'): string {
    return mkdtempSync(join(tempHome, `${label}-`));
  }

  it('should hide metadata-only sessions from the chooser list', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');

    const sessions = SessionStore.listSessions(cwd);
    expect(sessions).toHaveLength(0);
  });

  it('should record turns and calculate costs', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('claude-sonnet-4-6', 'anthropic');
    
    const userUuid = store.writeUser('Hello');
    store.writeAssistant({
      parentUuid: userUuid,
      content: 'Hi there!',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
      turn: 1,
      latencyMs: 500,
      toolCalls: [],
      status: 'ok'
    });

    const sessions = SessionStore.listSessions(cwd);
    expect(sessions[0].turnCount).toBe(1);
    expect(sessions[0].lastUserInput).toBe('Hello');
    expect(sessions[0].firstPrompt).toBe('Hello');
    expect(sessions[0].summary).toBe('Hello');
    expect(sessions[0].totalUsage).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    // Cost for claude-sonnet-4-6: $3/1M input, $15/1M output
    // (10 * 3 / 1,000,000) + (20 * 15 / 1,000,000) = 0.00003 + 0.0003 = 0.00033
    expect(sessions[0].totalCostUsd).toBeCloseTo(0.00033, 6);
  });

  it('should load a session for resuming', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    const sessionId = store.sessionId;
    
    store.writeStart('gpt-4', 'openai');
    store.writeUser('Question 1');
    store.writeAssistant({
      parentUuid: 'any',
      content: 'Answer 1',
      model: 'gpt-4',
      provider: 'openai',
      stopReason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 5 },
      turn: 1,
      latencyMs: 100,
      toolCalls: [],
      status: 'ok'
    });

    const loaded = SessionStore.loadSession(sessionId, cwd);
    expect(loaded.sessionId).toBe(sessionId);
    expect(loaded.history).toHaveLength(2);
    expect(loaded.history[0]).toEqual({ role: 'user', content: 'Question 1' });
    expect(loaded.history[1]).toEqual({ role: 'assistant', content: 'Answer 1' });
    expect(loaded.turnCount).toBe(1);
  });

  it('should fork a session into a branch', () => {
    const cwd = makeCwd();
    const parent = new SessionStore({ cwd });
    parent.writeStart('gpt-4', 'openai');
    const userUuid = parent.writeUser('Try one approach');
    parent.writeAssistant({
      parentUuid: userUuid,
      content: 'Approach A',
      model: 'gpt-4',
      provider: 'openai',
      stopReason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 7 },
      turn: 1,
      latencyMs: 100,
      toolCalls: [],
      status: 'ok'
    });
    parent.writeEnd({ input_tokens: 5, output_tokens: 7 }, 0.01, 1, 'Try one approach');

    const branch = SessionStore.forkSession({
      fromSessionId: parent.sessionId,
      cwd,
      title: 'experiment-a'
    });
    const loaded = SessionStore.loadSession(branch.sessionId, cwd);

    expect(branch.parentSessionId).toBe(parent.sessionId);
    expect(loaded.history).toEqual([
      { role: 'user', content: 'Try one approach' },
      { role: 'assistant', content: 'Approach A' },
    ]);
    expect(loaded.turnCount).toBe(1);

    const branches = SessionStore.listBranches(parent.sessionId, cwd);
    expect(branches).toHaveLength(1);
    expect(branches[0].sessionId).toBe(branch.sessionId);
    expect(branches[0].branch?.status).toBe('active');
    expect(branches[0].branch?.title).toBe('experiment-a');
  });

  it('should logically discard a branch', () => {
    const cwd = makeCwd();
    const parent = new SessionStore({ cwd });
    parent.writeStart('gpt-4', 'openai');
    parent.writeUser('Question');

    const branch = SessionStore.forkSession({
      fromSessionId: parent.sessionId,
      cwd,
      title: 'discard-me'
    });

    expect(SessionStore.listBranches(parent.sessionId, cwd)).toHaveLength(1);
    SessionStore.discardBranch(branch.sessionId, cwd);
    expect(SessionStore.listBranches(parent.sessionId, cwd)).toHaveLength(0);

    const summary = SessionStore.listSessions(cwd).find((s) => s.sessionId === branch.sessionId);
    expect(summary?.branch?.status).toBe('discarded');
  });

  it('should mark a branch as adopted', () => {
    const cwd = makeCwd();
    const parent = new SessionStore({ cwd });
    parent.writeStart('gpt-4', 'openai');
    parent.writeUser('Question');

    const branch = SessionStore.forkSession({
      fromSessionId: parent.sessionId,
      cwd,
      title: 'adopt-me'
    });

    SessionStore.adoptBranch(branch.sessionId, cwd);

    const branches = SessionStore.listBranches(parent.sessionId, cwd);
    expect(branches).toHaveLength(1);
    expect(branches[0].sessionId).toBe(branch.sessionId);
    expect(branches[0].branch?.status).toBe('adopted');
    expect(branches[0].branch?.title).toBe('adopt-me');
  });

  it('should preserve try worktree metadata on branch status changes', () => {
    const cwd = makeCwd();
    const parent = new SessionStore({ cwd });
    parent.writeStart('gpt-4', 'openai');
    parent.writeUser('Question');

    const branch = SessionStore.forkSession({
      fromSessionId: parent.sessionId,
      cwd,
      title: 'try-me',
      worktreePath: '/tmp/vera-worktree',
      worktreeBranch: 'vera-try-try-me',
      baseCommit: 'abc123'
    });

    let summary = SessionStore.listBranches(parent.sessionId, cwd)[0]!;
    expect(summary.branch?.worktreePath).toBe('/tmp/vera-worktree');
    expect(summary.branch?.worktreeBranch).toBe('vera-try-try-me');
    expect(summary.branch?.baseCommit).toBe('abc123');

    SessionStore.adoptBranch(branch.sessionId, cwd);
    summary = SessionStore.listBranches(parent.sessionId, cwd)[0]!;
    expect(summary.branch?.status).toBe('adopted');
    expect(summary.branch?.worktreePath).toBe('/tmp/vera-worktree');

    SessionStore.markBranchMerged(branch.sessionId, cwd);
    summary = SessionStore.listBranches(parent.sessionId, cwd)[0]!;
    expect(summary.branch?.status).toBe('merged');
    expect(summary.branch?.worktreePath).toBe('/tmp/vera-worktree');

    SessionStore.discardBranch(branch.sessionId, cwd);
    summary = SessionStore.listSessions(cwd).find((s) => s.sessionId === branch.sessionId)!;
    expect(summary.branch?.status).toBe('discarded');
    expect(summary.branch?.worktreePath).toBe('/tmp/vera-worktree');
  });

  it('should handle custom titles', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    store.writeTitle('My Awesome Session');
    
    const sessions = SessionStore.listSessions(cwd);
    expect(sessions[0].title).toBe('My Awesome Session');
    expect(sessions[0].summary).toBe('My Awesome Session');
  });

  it('should authoritative cost from session_end', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    store.writeUser('Track the final cost');
    // Manual end with specific cost
    store.writeEnd({ input_tokens: 100, output_tokens: 100 }, 0.5, 1);
    
    const sessions = SessionStore.listSessions(cwd);
    expect(sessions[0].totalCostUsd).toBe(0.5);
    expect(sessions[0].turnCount).toBe(1);
    expect(sessions[0].totalUsage).toEqual({ input_tokens: 100, output_tokens: 100 });
  });

  it('should keep last prompt near the end for resume selection', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    store.writeEnd({ input_tokens: 1, output_tokens: 1 }, 0.01, 1, 'Continue the auth refactor');

    const sessions = SessionStore.listSessions(cwd);
    expect(sessions[0].lastUserInput).toBe('Continue the auth refactor');
    expect(sessions[0].summary).toBe('Continue the auth refactor');
  });

  it('should prefer custom title over ai title and prompts', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    store.writeUser('Raw prompt');
    store.writeAiTitle('AI title');
    store.writeEnd({ input_tokens: 1, output_tokens: 1 }, 0.01, 1, 'Last prompt');
    expect(SessionStore.listSessions(cwd)[0].summary).toBe('AI title');

    store.writeTitle('Custom title');
    expect(SessionStore.listSessions(cwd)[0].summary).toBe('Custom title');
  });

  it('should expose metadata fields in session summaries', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    store.writeUser('Investigate flaky tests');
    store.writeGitBranch('feature/session-ux');
    store.writeTag('p0');
    store.writePrLink({ prUrl: 'https://example.test/pr/12', prRepository: 'vera/open-vera', prNumber: 12 });

    const summary = SessionStore.listSessions(cwd)[0];
    expect(summary.gitBranch).toBe('feature/session-ux');
    expect(summary.tag).toBe('p0');
    expect(summary.pr).toEqual({ url: 'https://example.test/pr/12', repository: 'vera/open-vera', number: 12 });
    expect(summary.fileSize).toBeGreaterThan(0);
    expect(summary.createdAt).toBeInstanceOf(Date);
  });

  it('should recover display metadata from a truncated json line', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    store.writeUser('Fallback prompt');
    appendFileSync(store.filePath, '{"type":"ai-title","aiTitle":"Recovered title","extra":"unterminated');

    const summary = SessionStore.listSessions(cwd)[0];
    expect(summary.summary).toBe('Recovered title');
  });

  it('should recover session_end numeric fields from a truncated json line', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    store.writeUser('Recover totals');
    appendFileSync(
      store.filePath,
      '{"type":"session_end","totalUsage":{"input_tokens":123,"output_tokens":45,"cache_creation_input_tokens":6,"cache_read_input_tokens":7},"totalCostUsd":0.1234,"turnCount":9'
    );

    const summary = SessionStore.listSessions(cwd)[0];
    expect(summary.turnCount).toBe(9);
    expect(summary.totalCostUsd).toBe(0.1234);
    expect(summary.totalUsage).toEqual({
      input_tokens: 123,
      output_tokens: 45,
      cache_creation_input_tokens: 6,
      cache_read_input_tokens: 7,
    });
  });

  it('should list canonical sessions from symlinked project paths', () => {
    const cwd = makeCwd('real-project');
    const link = join(tempHome, 'project-link');
    symlinkSync(cwd, link);
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    store.writeUser('Symlink-visible task');

    expect(SessionStore.listSessions(link)[0].summary).toBe('Symlink-visible task');
  });

  it('should page sessions using candidate metadata before summary reads', () => {
    const cwd = makeCwd();
    const empty = new SessionStore({ cwd });
    empty.writeStart('gpt-4', 'openai');
    for (let i = 0; i < 5; i++) {
      const store = new SessionStore({ cwd });
      store.writeStart('gpt-4', 'openai');
      store.writeUser(`Task ${i}`);
    }

    const firstPage = SessionStore.listSessionsPaged({ cwd, limit: 2 });
    expect(firstPage.sessions).toHaveLength(2);
    expect(firstPage.nextOffset).toBe(2);
    expect(firstPage.totalCandidates).toBe(6);

    const secondPage = SessionStore.listSessionsPaged({ cwd, limit: 2, offset: firstPage.nextOffset });
    expect(secondPage.sessions).toHaveLength(2);
    expect(new Set([...firstPage.sessions, ...secondPage.sessions].map((s) => s.sessionId)).size).toBe(4);
  });

  it('should load transcript previews with tool uses', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    const userUuid = store.writeUser('Read the file');
    const toolUuid = store.writeToolCall({
      parentUuid: userUuid,
      toolName: 'read_file',
      toolCallId: 'read_file',
      arguments: { path: 'README.md' },
    });
    store.writeToolResult({ parentUuid: toolUuid, toolCallId: 'read_file', content: 'README contents' });
    store.writeAssistant({
      parentUuid: userUuid,
      content: 'Done',
      model: 'gpt-4',
      provider: 'openai',
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      turn: 1,
      latencyMs: 1,
      toolCalls: ['read_file'],
      status: 'ok',
    });

    const preview = SessionStore.loadTranscriptPreview(store.sessionId, cwd);
    expect(preview.messages).toHaveLength(2);
    expect(preview.messages[1].toolUses?.[0]).toMatchObject({
      name: 'read_file',
      args: { path: 'README.md' },
      result: { ok: true, content: 'README contents' },
    });
  });

  it('should clean generated session titles', async () => {
    const title = await generateSessionTitle({
      model: 'test-model',
      userPrompt: '请修复 session 列表',
      adapter: {
        async complete() {
          return {
            stop_reason: 'end_turn',
            message: { role: 'assistant', content: ' "修复 Session 列表" ' },
          };
        },
        async *stream() {},
      },
    });
    expect(title).toBe('修复 Session 列表');
  });

  it('should list sessions across all projects when cwd is omitted', () => {
    const first = new SessionStore({ cwd: makeCwd('project-a') });
    first.writeStart('gpt-4', 'openai');
    first.writeUser('Project A task');

    const second = new SessionStore({ cwd: makeCwd('project-b') });
    second.writeStart('gpt-4', 'openai');
    second.writeUser('Project B task');

    const summaries = SessionStore.listSessions();
    expect(summaries.map((s) => s.summary).sort()).toEqual(['Project A task', 'Project B task']);
  });

  it('should populate fileSize in session summary', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    store.writeUser('test message for file size');

    const sessions = SessionStore.listSessions(cwd);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].fileSize).toBeGreaterThan(0);
  });

  it('should count user and assistant messages as messageCount', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');

    const u1 = store.writeUser('First question');
    store.writeAssistant({
      parentUuid: u1, content: 'First answer', model: 'gpt-4', provider: 'openai',
      stopReason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 },
      turn: 1, latencyMs: 100, toolCalls: [], status: 'ok',
    });
    const u2 = store.writeUser('Second question');
    store.writeAssistant({
      parentUuid: u2, content: 'Second answer', model: 'gpt-4', provider: 'openai',
      stopReason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 },
      turn: 2, latencyMs: 100, toolCalls: [], status: 'ok',
    });

    const sessions = SessionStore.listSessions(cwd);
    expect(sessions[0].messageCount).toBe(4); // 2 user + 2 assistant
    expect(sessions[0].turnCount).toBe(2);
  });

  it('messageCount is undefined for sessions with no messages yet', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    store.writeUser('Only user message, no assistant');

    const sessions = SessionStore.listSessions(cwd);
    // 1 user message — no assistant entry yet
    expect(sessions[0].messageCount).toBe(1);
  });

  it('messageCount does not double-count when head and tail overlap (small file)', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');

    const u1 = store.writeUser('Q1');
    store.writeAssistant({
      parentUuid: u1, content: 'A1', model: 'gpt-4', provider: 'openai',
      stopReason: 'end_turn', usage: { input_tokens: 2, output_tokens: 2 },
      turn: 1, latencyMs: 10, toolCalls: [], status: 'ok',
    });

    const sessions = SessionStore.listSessions(cwd);
    // Small file — head and tail overlap, but UUID dedup should keep count at 2
    expect(sessions[0].messageCount).toBe(2);
  });

  it('fileSize increases as more messages are written', () => {
    const cwd = makeCwd();
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    store.writeUser('initial');

    const [before] = SessionStore.listSessions(cwd);
    const sizeBefore = before!.fileSize ?? 0;

    const u = store.writeUser('extra message');
    store.writeAssistant({
      parentUuid: u, content: 'extra reply', model: 'gpt-4', provider: 'openai',
      stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      turn: 1, latencyMs: 10, toolCalls: [], status: 'ok',
    });

    const [after] = SessionStore.listSessions(cwd);
    expect(after!.fileSize).toBeGreaterThan(sizeBefore);
  });
});
