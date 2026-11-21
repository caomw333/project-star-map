export function phaseIndex(map) {
  return new Map(map.phases.map((phase) => [phase.id, phase]));
}

export function validateStepEndpoint(phases, phaseId, stepId) {
  const phase = phases.get(phaseId);
  const valid = phase && (phase.subflow
    ? phase.steps?.some((step) => step.id === stepId && typeof stepId === 'string')
    : stepId === undefined);
  if (!valid) throw new Error(`Invalid subflow endpoint: ${phaseId}/${stepId}`);
}

export function proposalGraph(map, phaseIds, stepRefs, changes) {
  const phases = phaseIndex(map);
  if (phaseIds.some((id) => !phases.has(id))) throw new Error('提案包含未知的流程阶段。');
  const focused = new Map();
  for (const { phaseId, stepId } of stepRefs) {
    if (typeof stepId !== 'string' || !stepId) throw new Error('子步骤关注需要 phaseId 和 stepId。');
    validateStepEndpoint(phases, phaseId, stepId);
    focused.set(JSON.stringify([phaseId, stepId]), { phaseId, stepId });
  }
  const edges = changes.map(({ from, label, to, fromStep, toStep }) => {
    const values = [from, label, to];
    if (values.some((value) => typeof value !== 'string' || !value.trim() || value.length > 120)) {
      throw new Error('每条拟议连线必须包含起点、传递内容和终点。');
    }
    const edge = { from: from.trim(), label: label.trim(), to: to.trim() };
    if (fromStep !== undefined || toStep !== undefined) {
      validateStepEndpoint(phases, edge.from, fromStep);
      validateStepEndpoint(phases, edge.to, toStep);
      if (fromStep !== undefined) edge.fromStep = fromStep;
      if (toStep !== undefined) edge.toStep = toStep;
    }
    return edge;
  });
  return { phaseIds: [...new Set(phaseIds)], stepRefs: [...focused.values()], changes: edges };
}

// Trace proposals reference a published field and existing subflow steps.
export function validateTraceRef(phases, ref) {
  if (!ref || typeof ref.phase !== 'string' || typeof ref.step !== 'string') throw new Error('Invalid trace endpoint');
  validateStepEndpoint(phases, ref.phase, ref.step);
  if (!phases.get(ref.phase)?.subflow) throw new Error('Invalid trace endpoint');
}

export function proposalTrace(map, traceId, changes) {
  if (traceId === undefined && changes.length === 0) return { traceId: undefined, traceChanges: [] };
  if (typeof traceId !== 'string' || !(map.traces ?? []).some((trace) => trace.id === traceId)) throw new Error('未知的已发布字段。');
  const phases = phaseIndex(map);
  const published = map.traces.find((trace) => trace.id === traceId);
  const seen = new Set();
  const traceChanges = changes.map((edge) => {
    validateTraceRef(phases, edge?.from);
    validateTraceRef(phases, edge?.to);
    if (typeof edge.label !== 'string' || !edge.label.trim() || edge.label.length > 120) throw new Error('拟议字段路径需要说明。');
    const key = JSON.stringify([edge.from.phase, edge.from.step, edge.to.phase, edge.to.step]);
    if (seen.has(key)) throw new Error('拟议字段路径端点重复。');
    seen.add(key);
    const operation = edge.operation ?? 'set';
    if (!['set', 'remove'].includes(operation)) throw new Error('未知的字段路径操作。');
    if (operation === 'remove' && !published.edges.some((item) =>
      JSON.stringify([item.from.phase, item.from.step, item.to.phase, item.to.step]) === key)) throw new Error('只能拟议移除已发布的字段路径。');
    return { from: { phase: edge.from.phase, step: edge.from.step }, to: { phase: edge.to.phase, step: edge.to.step }, label: edge.label.trim(), ...(edge.operation ? { operation } : {}) };
  });
  return { traceId, traceChanges };
}
