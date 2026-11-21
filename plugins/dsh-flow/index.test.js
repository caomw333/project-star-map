import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply } from './index.js';

test('the current flow map gates replies and edits in the configured DSH session', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-flow-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'flow'));
  writeFileSync(join(root, 'flow', 'map.json'), JSON.stringify({
    phases: [{ id: 'reply' }, { id: 'validate', subflow: {}, steps: [{ id: 'auth' }, { id: 'dedupe' }] }],
  }));
  const listeners = {};
  let guard;
  let publish;
  let section;
  const session = { id: 'pilot' };
  const agent = { session };
  let directory = root;
  apply({
    on(name, callback) { listeners[name] = callback; },
    workingDirectory: { get() { return directory; } },
    systemPrompt: {
      getSectionOrder() { return 60; },
      section(rule) { section = rule; },
    },
    tools: {
      guard(callback) { guard = callback; },
      register(tool) { publish = tool; },
    },
  }, { projectRoot: root, sessionId: session.id });

  const event = (type, turn) => listeners['session/event'](session, { type, data: { turn } });
  const edit = (file_path) => guard({ agent, name: 'edit', arguments: { file_path } });
  const view = () => JSON.parse(readFileSync(join(root, '.cache', 'flow', 'current.json'), 'utf8'));
  const proposal = { phaseIds: ['reply'], summary: '明确显示超时', files: ['example.txt'] };
  event('turn/start', 1);
  const signal = new AbortController().signal;
  listeners['agent/pre-step']({ agent, signal }, () => ({}));
  const request = { sessionId: session.id, signal };
  const answer = { type: 'text-delta', index: 0, text: 'early answer' };
  const finish = { type: 'finish', reason: { kind: 'stop' } };
  async function* stream(...chunks) { yield* chunks; }
  const filter = async (scope, ...chunks) => {
    const result = [];
    for await (const chunk of listeners['llm/stream'](scope, () => stream(...chunks))) result.push(chunk);
    return result;
  };
  const premature = await filter(request, answer, finish);
  assert.equal(premature.length, 1);
  const failure = premature[0].reason.failure;
  assert.equal(failure.code, 'FLOW_MAP_REQUIRED');
  assert.deepEqual(listeners['agent/request-error']({ agent, failure }), { kind: 'retry' });
  assert.equal(listeners['agent/request-error']({ agent, failure }), undefined);
  assert.deepEqual(await filter({ ...request, sessionId: 'other' }, answer, finish), [answer, finish]);
  assert.deepEqual(await filter({ sessionId: session.id }, answer, finish), [answer, finish]);
  const call = { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call', name: 'flow_publish', arguments: '{}' } };
  const callFinish = { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { blocks: [{ type: 'text' }, { type: 'tool-call' }] } };
  assert.deepEqual(await filter(request, answer, call, callFinish), [
    call, { ...callFinish, replayState: { blocks: [{ type: 'tool-call' }] } },
  ]);
  assert.match(section.text({ agent }), /flow_publish/);
  assert.equal(view().state, 'awaiting');
  assert.match(edit('example.txt'), /先调用 flow_publish/);
  assert.equal(guard({ agent, name: 'read', arguments: {} }), undefined);
  assert.match(guard({ agent, name: 'pwsh', arguments: {} }), /禁用 pwsh/);
  assert.match(guard({ agent, name: 'subagent', arguments: {} }), /禁用 subagent/);
  assert.equal(guard({ agent: { session: { id: 'other' } }, name: 'edit', arguments: {} }), undefined);
  assert.throws(() => publish.execute({ ...proposal, files: ['../outside.txt'] }, { agent }), /项目内/);
  assert.throws(() => publish.execute({ ...proposal, phaseIds: ['unknown'] }, { agent }), /未知/);
  assert.throws(() => publish.execute({ ...proposal, phaseIds: [], files: [] }, { agent }), /至少选择一个/);
  assert.throws(() => publish.execute({ ...proposal, files: ['.cache/flow/current.json'] }, { agent }), /flow_publish/);
  assert.match(publish.execute(proposal, { agent }), /已发布/);
  assert.deepEqual(await filter(request, answer, finish), [answer, finish]);
  assert.equal(view().state, 'proposed');
  assert.deepEqual(view().files, ['example.txt']);
  assert.equal(edit(join(root, 'example.txt')), undefined);
  assert.match(edit('unlisted.txt'), /不在本轮提案/);

  listeners['agent/inbox/claimed']({ agent, message: { source: { kind: 'user' } }, turn: 1 });
  assert.match(edit('example.txt'), /先调用 flow_publish/);
  event('turn/start', 2);
  assert.equal(view().turn, 2);
  const changes = [{ from: '输入', label: '请求 ID', to: '验证' }];
  publish.execute({ ...proposal, files: [], changes }, { agent });
  assert.equal(view().state, 'draft');
  assert.deepEqual(view().changes, changes);
  assert.match(edit('example.txt'), /先调用 flow_publish/);
  event('turn/end', 2);
  assert.throws(() => publish.execute(proposal, { agent }), /轮次可用/);

  event('turn/start', 3);
  listeners['agent/pre-step']({ agent, signal }, () => ({}));
  const focus = { phaseIds: [], stepRefs: [{ phaseId: 'validate', stepId: 'dedupe' }], summary: '请求 ID 去重', files: [] };
  directory = tmpdir();
  assert.throws(() => publish.execute(focus, { agent }), /项目根目录/);
  assert.equal(view().state, 'awaiting');
  directory = root;
  const childChanges = [{ from: 'validate', fromStep: 'auth', to: 'validate', toStep: 'dedupe', label: '请求 ID' },
    { from: 'validate', fromStep: 'dedupe', to: 'reply', label: '拟议回执' }];
  for (const invalid of [
    { ...focus, stepRefs: [{ phaseId: 'validate', stepId: 'missing' }] },
    { ...focus, stepRefs: [{ phaseId: 'external-project', stepId: 'dedupe' }] },
    { ...focus, changes: [{ ...childChanges[0], toStep: 'missing' }] },
    { ...focus, changes: [{ ...childChanges[1], to: 'external-project' }] },
    { ...focus, changes: [{ ...childChanges[1], to: 'validate' }] },
    { ...focus, changes: [{ ...childChanges[1], toStep: 'auth' }] },
  ]) {
    assert.throws(() => publish.execute(invalid, { agent }), /Invalid subflow endpoint/);
    assert.equal(view().state, 'awaiting');
    assert.match(edit('example.txt'), /先调用 flow_publish/);
  }
  assert.equal((await filter(request, answer, finish))[0].reason.failure.code, 'FLOW_MAP_REQUIRED');
  assert.match(publish.execute(focus, { agent }), /关注范围已发布/);
  assert.deepEqual(view().stepRefs, focus.stepRefs);
  assert.deepEqual(await filter(request, answer, finish), [answer, finish]);
  assert.match(edit('example.txt'), /先调用 flow_publish/);
  assert.match(publish.execute({ ...focus, files: ['example.txt'], changes: childChanges }, { agent }), /提案已发布/);
  assert.deepEqual(view().changes, childChanges);
  assert.equal(edit('example.txt'), undefined);
  assert.match(edit('unlisted.txt'), /不在本轮提案/);
  assert.throws(() => publish.execute({ ...focus, changes: [{ ...childChanges[0], toStep: 'missing' }] }, { agent }),
    /Invalid subflow endpoint/);
  assert.deepEqual(view().changes, childChanges);
});
