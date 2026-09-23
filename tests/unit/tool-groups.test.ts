import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BG_ENABLE_TOOL_NAME,
  parseToolActivationMode,
  registerToolGroups,
  TOOL_GROUPS,
  usedGroupsFromMessages,
} from '../../src/tool-groups.js';

const ALWAYS = ['bg_run', 'bg_status', 'bg_logs', 'bg_kill'];
const ALL_OPTIONAL = [...TOOL_GROUPS.fusion, ...TOOL_GROUPS.delegate, ...TOOL_GROUPS.attested, 'bg_result'];

type Handler = (event: unknown, ctx: unknown) => unknown;
function fakePi(registered: string[]) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, { execute: (id: string, p: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }>();
  const state = { active: [...registered], setCalls: 0 };
  const pi = {
    on: (name: string, h: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), h]); return () => undefined; },
    registerTool: (t: { name: string; execute: never }) => { tools.set(t.name, t); registered.push(t.name); state.active.push(t.name); },
    getAllTools: () => registered.map((name) => ({ name })),
    getActiveTools: () => [...state.active],
    setActiveTools: (names: string[]) => { state.setCalls += 1; state.active = names.filter((n) => registered.includes(n)); },
  };
  const emit = async (name: string, ctx: unknown = {}) => { for (const h of handlers.get(name) ?? []) await h({}, ctx); };
  return { pi: pi as never, state, tools, emit };
}
const deps = (messages: unknown[] = [], hasResultTask = false) => ({ branchMessages: () => messages, hasResultTask: () => hasResultTask });

void describe('optional tool groups', () => {
  void it('parses the activation mode strictly; eager is the default', () => {
    assert.equal(parseToolActivationMode(undefined), 'eager');
    assert.equal(parseToolActivationMode(''), 'eager');
    assert.equal(parseToolActivationMode('lazy'), 'lazy');
    assert.throws(() => parseToolActivationMode('LAZY'), /PI_BG_TOOL_ACTIVATION/);
  });

  void it('eager mode: loader registered but INACTIVE; every other tool stays active (upstream loadout)', async () => {
    const f = fakePi([...ALWAYS, ...ALL_OPTIONAL]);
    registerToolGroups(f.pi, 'eager', deps());
    await f.emit('session_start');
    assert.equal(f.tools.has(BG_ENABLE_TOOL_NAME), true);
    assert.deepEqual(f.state.active.sort(), [...ALWAYS, ...ALL_OPTIONAL].sort());
    await f.emit('before_agent_start');
    assert.ok(!f.state.active.includes(BG_ENABLE_TOOL_NAME));
  });

  void it('lazy: optional groups start inactive; lifecycle tools and the loader stay active', async () => {
    const f = fakePi([...ALWAYS, ...ALL_OPTIONAL]);
    registerToolGroups(f.pi, 'lazy', deps());
    await f.emit('session_start');
    assert.deepEqual(f.state.active.sort(), [...ALWAYS, BG_ENABLE_TOOL_NAME].sort());
  });

  void it('bg_enable activates exactly one group plus bg_result, idempotently, and it stays on', async () => {
    const f = fakePi([...ALWAYS, ...ALL_OPTIONAL]);
    registerToolGroups(f.pi, 'lazy', deps());
    await f.emit('session_start');
    const enable = f.tools.get(BG_ENABLE_TOOL_NAME)!;
    const r1 = await enable.execute('1', { group: 'fusion' });
    assert.equal(r1.isError, undefined);
    for (const t of [...TOOL_GROUPS.fusion, 'bg_result']) assert.ok(f.state.active.includes(t), t);
    assert.ok(!f.state.active.includes('bg_delegate') && !f.state.active.includes('bg_run_pi_attested'));
    const r2 = await enable.execute('2', { group: 'fusion' });
    assert.match(r2.content[0]!.text, /^Already enabled/);
    await f.emit('before_agent_start');
    assert.ok(f.state.active.includes('fusion_reason'), 'no surprise deactivation on the next prompt');
  });

  void it('attested alone does not expose bg_result; unknown or feature-disabled groups are actionable errors', async () => {
    const f = fakePi([...ALWAYS, ...TOOL_GROUPS.attested]);
    registerToolGroups(f.pi, 'lazy', deps());
    await f.emit('session_start');
    const enable = f.tools.get(BG_ENABLE_TOOL_NAME)!;
    await enable.execute('1', { group: 'attested' });
    assert.ok(f.state.active.includes('bg_run_pi_attested') && !f.state.active.includes('bg_result'));
    const bad = await enable.execute('2', { group: 'fusion' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]!.text, /Available: attested/);
  });

  void it('no optional feature registered → the loader is never offered', async () => {
    const f = fakePi([...ALWAYS]);
    registerToolGroups(f.pi, 'lazy', deps());
    await f.emit('session_start');
    assert.deepEqual(f.state.active.sort(), [...ALWAYS].sort());
  });

  void it('resume: groups used on the branch are restored, and bg_result stays reachable for owed results', async () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: 'bg_delegate', arguments: {} }] },
      { role: 'toolResult', toolName: 'bg_delegate', content: [] },
    ];
    const f = fakePi([...ALWAYS, ...ALL_OPTIONAL]);
    registerToolGroups(f.pi, 'lazy', deps(messages));
    await f.emit('session_start');
    assert.ok(f.state.active.includes('bg_delegate') && f.state.active.includes('bg_result'));
    assert.ok(!f.state.active.includes('fusion_reason'), 'unused groups stay lazy after resume');
    assert.deepEqual([...usedGroupsFromMessages(messages).groups], ['delegate']);
  });

  void it('bg_result stays active whenever the registry holds a delegate/Fusion task, even with groups off', async () => {
    const f = fakePi([...ALWAYS, ...ALL_OPTIONAL]);
    registerToolGroups(f.pi, 'lazy', deps([], true));
    await f.emit('session_start');
    assert.ok(f.state.active.includes('bg_result'));
  });

  void it('never activates a tool the host did not register', async () => {
    const f = fakePi([...ALWAYS, 'fusion_reason']);
    registerToolGroups(f.pi, 'lazy', deps());
    await f.emit('session_start');
    await f.tools.get(BG_ENABLE_TOOL_NAME)!.execute('1', { group: 'fusion' });
    assert.ok(f.state.active.includes('fusion_reason'));
    assert.ok(!f.state.active.includes('fusion_validate'));
    const r = await f.tools.get(BG_ENABLE_TOOL_NAME)!.execute('2', { group: 'delegate' });
    assert.equal(r.isError, true, 'feature on but tool absent is an error, not silent success');
  });
});
