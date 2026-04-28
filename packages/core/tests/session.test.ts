import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../src/session/store.js';
import { rmSync, mkdtempSync } from 'node:fs';
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

  it('should create a session file and write start entry', () => {
    const store = new SessionStore({ cwd: '/test/project' });
    store.writeStart('gpt-4', 'openai');
    
    const sessions = SessionStore.listSessions('/test/project');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].model).toBe('gpt-4');
    expect(sessions[0].provider).toBe('openai');
  });

  it('should record turns and calculate costs', () => {
    const store = new SessionStore({ cwd: '/test/project' });
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

    const sessions = SessionStore.listSessions('/test/project');
    expect(sessions[0].turnCount).toBe(1);
    // Cost for claude-sonnet-4-6: $3/1M input, $15/1M output
    // (10 * 3 / 1,000,000) + (20 * 15 / 1,000,000) = 0.00003 + 0.0003 = 0.00033
    expect(sessions[0].totalCostUsd).toBeCloseTo(0.00033, 6);
  });

  it('should load a session for resuming', () => {
    const cwd = '/test/project';
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

  it('should handle custom titles', () => {
    const cwd = '/test/project';
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    store.writeTitle('My Awesome Session');
    
    const sessions = SessionStore.listSessions(cwd);
    expect(sessions[0].title).toBe('My Awesome Session');
  });

  it('should authoritative cost from session_end', () => {
    const cwd = '/test/project';
    const store = new SessionStore({ cwd });
    store.writeStart('gpt-4', 'openai');
    // Manual end with specific cost
    store.writeEnd({ input_tokens: 100, output_tokens: 100 }, 0.5, 1);
    
    const sessions = SessionStore.listSessions(cwd);
    expect(sessions[0].totalCostUsd).toBe(0.5);
    expect(sessions[0].turnCount).toBe(1);
  });
});
