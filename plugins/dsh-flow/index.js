import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposalGraph, proposalTrace } from './map-rules.mjs';

export const name = 'dsh-flow';
export const inject = ['llm', 'tools', 'systemPrompt', 'workingDirectory'];

const publishTool = 'flow_publish';
const readTools = new Set(['read', 'glob', 'grep', 'skill', 'ask_user_question', 'exit_plan_mode']);
const fileTools = new Set(['edit', 'write']);
const stateFile = '.cache/flow/current.json';
const missingMapCode = 'FLOW_MAP_REQUIRED';

async function* gateReply(stream) {
  const toolBlocks = new Set();
  let hasToolCall = false;
  for await (const chunk of await stream) {
    if (chunk.type === 'block-start' && chunk.blockType === 'tool-call' ||
      chunk.type === 'block-end' && chunk.block.type === 'tool-call' ||
      chunk.type === 'tool-call-delta') {
      toolBlocks.add(chunk.index);
      if (chunk.type === 'block-end' || chunk.type === 'tool-call-delta' && chunk.name) hasToolCall = true;
      yield chunk;
    } else if (chunk.type === 'usage') {
      yield chunk;
    } else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        yield chunk;
      } else if (hasToolCall && chunk.reason.kind !== 'max-tokens') {
        const replay = chunk.replayState;
        yield replay?.blocks ? {
          ...chunk,
          replayState: { ...replay, blocks: replay.blocks.filter((_block, index) => toolBlocks.has(index)) },
        } : chunk;
      } else {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { code: missingMapCode, message: '本轮没有发布流程图，已拦截回复。' },
          },
        };
      }
    }
  }
}

function physicalPath(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    const parent = dirname(path);
    if (error.code !== 'ENOENT' || parent === path) throw error;
    return join(physicalPath(parent), relative(parent, path));
  }
}

function projectPath(root, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('需要文件路径。');
  const file = physicalPath(resolve(root, value));
  const path = relative(root, file);
  if (!path || isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) {
    throw new Error('文件必须位于当前项目内。');
  }
  return path.split(sep).join('/');
}

function pathKey(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function publishState(root, state) {
  if (pathKey(projectPath(root, stateFile)) !== pathKey(stateFile)) {
    throw new Error('流程图状态路径不能重定向。');
  }
  const target = join(root, stateFile);
  const temp = join(dirname(target), `${randomUUID()}.tmp`);
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(temp, JSON.stringify(state) + '\n', { flag: 'wx' });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function apply(ctx, config = {}) {
  if (typeof config.sessionId !== 'string' || !config.sessionId.trim()) {
    throw new Error('dsh-flow: sessionId is required');
  }
  const root = realpathSync(config.projectRoot ?? fileURLToPath(new URL('../../', import.meta.url)));
  const isTarget = (session) => session?.id === config.sessionId;
  let current;
  let replySignal;
  let replyRetryUsed = false;

  function begin(turn) {
    replyRetryUsed = false;
    current = { version: 1, turn, state: 'awaiting', phaseIds: [], summary: '', files: [] };
    try {
      publishState(root, current);
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-flow] Could not update browser state: ${error.message}`);
    }
  }

  ctx.on('session/event', (session, event) => {
    if (!isTarget(session)) return;
    if (event.type === 'turn/start') begin(event.data.turn);
    if (event.type === 'turn/end') {
      current = undefined;
      replySignal = undefined;
    }
  });
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (isTarget(agent?.session) && message.source?.kind === 'user') begin(turn);
  });
  ctx.on('agent/pre-step', ({ agent, signal }, next) => {
    if (isTarget(agent?.session)) replySignal = signal;
    return next();
  });
  ctx.on('llm/stream', (request, next) => {
    const stream = next();
    if (request.sessionId !== config.sessionId || !replySignal || request.signal !== replySignal ||
      current && current.state !== 'awaiting') return stream;
    return gateReply(stream);
  }, { prepend: true });
  ctx.on('agent/request-error', ({ agent, failure }, next) => {
    if (!isTarget(agent?.session) || failure.code !== missingMapCode) return next();
    if (!current || replyRetryUsed) return undefined;
    replyRetryUsed = true;
    return { kind: 'retry' };
  });

  ctx.systemPrompt.section({
    name: 'flow-map:policy',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
    text({ agent }) {
      if (!isTarget(agent?.session)) return '';
      if (current && current.state !== 'awaiting') {
        return '本轮流程图已发布，可以回复。写文件前核对提案范围，范围变化时先更新提案。';
      }
      return [
        '此会话在本轮发布流程图前会屏蔽正文。先读 flow/map.json，再调用 flow_publish，工具成功后再回答。',
        '用 stepRefs 的 phaseId、stepId 关注已有子步骤。拟议连线用 changes 的 from、label、to，内层端点再填写 fromStep 或 toStep，from/to 使用对应阶段 ID。只讨论时 files 留空。',
        '关注已发布字段用 traceId；拟议字段路径用 traceChanges，端点各用 {phase, step}，与现状图分开保存。',
        '单纯解释现状时选择相关阶段，files 留空。实际改文件前，列出拟改文件和受影响的阶段。',
        ...(replyRetryUsed ? ['刚才的正文没有显示，因为还没发布图。请现在调用 flow_publish，发布成功后再回复。'] : []),
        '先发布提案，再用 edit 或 write。范围有变时先补提案，遵守用户授权和现有审批规则。',
        '本试点使用 read、glob、grep 检查文件，不能通过 PowerShell 或委派任务写入。',
      ].join('\n');
    },
  });

  ctx.tools.register({
    name: publishTool,
    description: '在回复前发布本轮流程图。讨论方案时用 changes 提交虚线数据流。需要改代码时列出文件范围。',
    parameters: {
      type: 'object',
      properties: {
        phaseIds: { type: 'array', items: { type: 'string' } },
        stepRefs: { type: 'array', items: {
          type: 'object',
          properties: { phaseId: { type: 'string' }, stepId: { type: 'string' } },
          required: ['phaseId', 'stepId'],
          additionalProperties: false,
        } },
        traceId: { type: 'string' },
        traceChanges: { type: 'array', items: {
          type: 'object', properties: {
            from: { type: 'object', properties: { phase: { type: 'string' }, step: { type: 'string' } }, required: ['phase', 'step'], additionalProperties: false },
            to: { type: 'object', properties: { phase: { type: 'string' }, step: { type: 'string' } }, required: ['phase', 'step'], additionalProperties: false },
            label: { type: 'string' }, operation: { type: 'string', enum: ['set', 'remove'] },
          }, required: ['from', 'to', 'label'], additionalProperties: false,
        } },
        summary: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        changes: { type: 'array', items: {
          type: 'object',
          properties: { from: { type: 'string' }, label: { type: 'string' }, to: { type: 'string' },
            fromStep: { type: 'string' }, toStep: { type: 'string' } },
          required: ['from', 'label', 'to'],
          additionalProperties: false,
        } },
      },
      required: ['phaseIds', 'summary', 'files'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args, { agent }) {
      if (!isTarget(agent?.session) || !current) throw new Error('流程图工具只在启用的会话轮次可用。');
      if (realpathSync(ctx.workingDirectory.get(agent.session)) !== root) {
        throw new Error('流程图工具需要在配置的项目根目录运行。');
      }
      const { summary, phaseIds, files, stepRefs = [], changes = [], traceId, traceChanges = [] } = args;
      if (typeof summary !== 'string' || !summary.trim() || summary.length > 1000 ||
        !Array.isArray(phaseIds) || !Array.isArray(stepRefs) || !(phaseIds.length || stepRefs.length || traceId) ||
        phaseIds.length > 20 || stepRefs.length > 20 ||
        !Array.isArray(files) || files.length > 40 || !Array.isArray(changes) || changes.length > 12 ||
        !Array.isArray(traceChanges) || traceChanges.length > 12) {
        throw new Error('发布流程图时请至少选择一个相关阶段或子步骤，并填写简短说明。');
      }
      const mapPath = projectPath(root, 'flow/map.json');
      const map = JSON.parse(readFileSync(join(root, mapPath), 'utf8'));
      const graph = { ...proposalGraph(map, phaseIds, stepRefs, changes), ...proposalTrace(map, traceId, traceChanges) };
      const paths = [...new Set(files.map((file) => projectPath(root, file)))];
      if (paths.some((path) => pathKey(path) === pathKey(projectPath(root, stateFile)))) {
        throw new Error('运行时状态由 flow_publish 维护。');
      }
      const next = {
        ...current,
        state: paths.length ? 'proposed' : (graph.changes.length || graph.traceChanges?.length) ? 'draft' : 'focused',
        ...graph,
        summary: summary.trim(),
        files: paths,
      };
      publishState(root, next);
      current = next;
      return paths.length ? '本轮提案已发布。仅所列文件可通过 edit/write 修改。' :
        (graph.changes.length || graph.traceChanges?.length) ? '本轮虚线方案已发布，可以回复。' : '本轮关注范围已发布，可以回复。';
    },
  });

  ctx.tools.guard((exec) => {
    if (!isTarget(exec.agent?.session) || exec.name === publishTool || readTools.has(exec.name)) return;
    if (!fileTools.has(exec.name)) return `流程图试点禁用 ${exec.name}。请使用项目文件工具。`;
    if (current?.state !== 'proposed') return '写入已拦截。请先调用 flow_publish 发布本轮提案。';
    try {
      if (realpathSync(ctx.workingDirectory.get(exec.agent.session)) !== root) {
        return '写入已拦截。工作目录不再是提案对应的项目根目录。';
      }
      const target = pathKey(projectPath(root, exec.arguments.file_path));
      if (!current.files.some((file) => pathKey(file) === target)) {
        return '写入已拦截。该文件不在本轮提案中，请先更新提案。';
      }
    } catch {
      return '写入已拦截。无法确认目标文件位于当前项目内。';
    }
  });
}
