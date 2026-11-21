import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { phaseIndex, validateStepEndpoint, validateTraceRef } from '../plugins/dsh-flow/map-rules.mjs';

export async function projectFile(root, file) {
  if (typeof file !== 'string' || !file || isAbsolute(file)) throw new Error(`Expected a relative source path: ${file}`);
  const target = await realpath(resolve(root, file));
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) {
    throw new Error(`Source must be inside the project: ${file}`);
  }
  return target;
}

export async function readProjectMap(source, root, verifyLines = false) {
  const flow = JSON.parse(source);
  const text = (value) => typeof value === 'string' && Boolean(value.trim());
  const position = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
  function validateArrow(edge, from, to) {
    if (!from.has(edge?.from) || !to.has(edge.to) || !text(edge.label)) {
      throw new Error('Every arrow needs two existing nodes and a label');
    }
  }
  if (!text(flow?.project) || !text(flow.title) || !text(flow.summary) ||
      !Array.isArray(flow.phases) || !flow.phases.length || !Array.isArray(flow.edges)) {
    throw new Error('Provide project, title, summary, phases and edges');
  }
  const ids = new Set();
  for (const phase of flow.phases) {
    if (!text(phase?.id) || ids.has(phase.id) || !text(phase.title) || !text(phase.layer) || !position(phase.position)) {
      throw new Error(`Expected a unique node ID, title, layer and [x,y] position: ${phase?.id}`);
    }
    ids.add(phase.id);
    if (phase.steps !== undefined && !Array.isArray(phase.steps)) {
      throw new Error(`Expected an array of steps: ${phase.id}`);
    }
    const stepIds = new Set();
    if (phase.subflow !== undefined) {
      if (!phase.steps?.length || !Array.isArray(phase.subflow?.edges) || !phase.subflow.edges.length) {
        throw new Error(`A subflow needs steps and arrows: ${phase.id}`);
      }
    }
    for (const step of phase.steps ?? []) {
      if (phase.subflow) {
        if (!text(step?.id) || stepIds.has(step.id) || !text(step.title) || !position(step.position)) {
          throw new Error(`Expected a unique step ID, title and relative [x,y] position: ${phase.id}/${step?.id}`);
        }
        stepIds.add(step.id);
      }
      const file = await projectFile(root, step.file);
      if (!Number.isSafeInteger(step.line) || step.line < 1 ||
          (verifyLines && step.line > (await readFile(file, 'utf8')).split(/\r?\n/).length)) {
        throw new Error(`Invalid source line for ${step.file}: ${step.line}`);
      }
    }
    for (const edge of phase.subflow?.edges ?? []) validateArrow(edge, stepIds, stepIds);
  }
  const phases = phaseIndex(flow);
  for (const edge of flow.edges) {
    validateArrow(edge, ids, ids);
    validateStepEndpoint(phases, edge.from, edge.fromStep);
    validateStepEndpoint(phases, edge.to, edge.toStep);
    if (edge.overviewLabel !== undefined && !text(edge.overviewLabel)) throw new Error('Invalid overview label');
    if (edge.return !== undefined) {
      if (!text(edge.return?.label) || edge.from === edge.to ||
          (!phases.get(edge.from).subflow && !phases.get(edge.to).subflow)) {
        throw new Error('A merged return needs a label and a subflow endpoint');
      }
      validateStepEndpoint(phases, edge.to, edge.return.fromStep);
      validateStepEndpoint(phases, edge.from, edge.return.toStep);
    }
  }
  if (flow.traces !== undefined) {
    if (!Array.isArray(flow.traces)) throw new Error('Expected traces array');
    const traceIds = new Set();
    for (const trace of flow.traces) {
      if (!text(trace?.id) || traceIds.has(trace.id) || !text(trace.title) ||
          !Array.isArray(trace.nodes) || !trace.nodes.length || !Array.isArray(trace.edges)) throw new Error('Invalid trace');
      traceIds.add(trace.id);
      const refs = new Set();
      for (const item of trace.nodes) {
        validateTraceRef(phases, item);
        const key = JSON.stringify([item?.phase, item?.step]);
        if (!text(item.detail) || refs.has(key)) throw new Error('Invalid trace node');
        refs.add(key);
      }
      for (const edge of trace.edges) {
        if (!text(edge?.label) || !refs.has(JSON.stringify([edge.from?.phase, edge.from?.step])) ||
            !refs.has(JSON.stringify([edge.to?.phase, edge.to?.step]))) throw new Error('Invalid trace edge');
      }
    }
  }
  return flow;
}

async function publish(rootPath, draft) {
  if (!rootPath || !draft) throw new Error('Usage: node project-map.mjs <project-root> <draft.json>');
  const root = await realpath(rootPath);
  const raw = await readFile(draft, 'utf8');
  await readProjectMap(raw, root, true);
  const folder = join(root, 'flow');
  await mkdir(folder, { recursive: true });
  if (relative(root, await realpath(folder)) !== 'flow') throw new Error('Project flow directory is redirected');
  const target = join(folder, 'map.json');
  const temp = join(dirname(target), `${randomUUID()}.tmp`);
  try {
    await writeFile(temp, raw, { flag: 'wx' });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
  console.log(target);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await publish(process.argv[2], process.argv[3]);
}
