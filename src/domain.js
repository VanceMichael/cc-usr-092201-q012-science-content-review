// 科研成果科普审校：领域资料解析、规则校验与查询。
// 规则要点：
// - 每条受众表达版本绑定一个科学主张版本，并只引用支持该主张版本的来源证据；
// - 受限证据不得进入任何在版/在展的公众表达；
// - 已发布表达必须有对应课题科研专家针对“主张版本×表达版本”的确认；
// - 印刷载体一旦印刷即固定内容版本，只能增发新批次，不覆盖旧批次；
// - 研究更新等事件标出受影响表达，已重写与仍待修订分开列出；
// - 分歧双方原话保留，扫码取得现场当前版本，观众疑问回流到具体表达版本。

const REQUIRED_TOP_KEYS = [
  'domain', 'version', 'sample_id', 'record_types', 'workflow_states',
  'facts', 'experts', 'topics', 'claims', 'evidence', 'expressions',
  'disputes', 'change_events', 'carriers', 'qr_codes', 'feedback',
];

const LIVE_EXPRESSION_STATES = new Set(['已发布', '审校中']);

// 读取并检查项目共享的领域资料（基础结构完整性）。
export function parseDomain(raw) {
  const value = JSON.parse(raw);
  const complete =
    value.domain === 'science-content-review' &&
    value.version >= 2 &&
    value.sample_id &&
    Array.isArray(value.record_types) && value.record_types.length >= 3 &&
    Array.isArray(value.workflow_states) && value.workflow_states.length >= 3 &&
    Array.isArray(value.facts) && value.facts.length >= 2 &&
    REQUIRED_TOP_KEYS.every((key) => Boolean(value[key]));
  for (const key of ['experts', 'topics', 'claims', 'evidence', 'expressions', 'disputes', 'change_events', 'carriers', 'qr_codes', 'feedback']) {
    if (!Array.isArray(value[key])) throw new Error(`领域资料缺少必要内容：${key}`);
  }
  return value;
}

export function indexById(items, label) {
  const map = new Map();
  for (const item of items) {
    if (map.has(item.id)) throw new Error(`${label}标识重复：${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

export function claimVersion(d, claimId, version) {
  const claim = d.claims.find((c) => c.id === claimId);
  return claim?.versions.find((v) => v.version === version) ?? null;
}

export function expressionVersion(d, expressionId, version) {
  const expression = d.expressions.find((e) => e.id === expressionId);
  return expression?.versions.find((v) => v.version === version) ?? null;
}

function expertMap(d) {
  return indexById(d.experts, '专家');
}

// 载体固定绑定（印刷 pin）与实时绑定（屏幕/平板）所覆盖的表达版本集合。
function bindingIndex(d) {
  const pinned = new Map(); // expressionId#version -> carrierId[]
  const live = new Map(); // expressionId -> carrierId[]
  for (const carrier of d.carriers) {
    for (const pin of carrier.pins ?? []) {
      const key = `${pin.expression_id}#${pin.version}`;
      pinned.set(key, [...(pinned.get(key) ?? []), carrier.id]);
    }
    for (const expressionId of carrier.live_bindings ?? []) {
      live.set(expressionId, [...(live.get(expressionId) ?? []), carrier.id]);
    }
  }
  return {pinned, live};
}

function isPubliclyInService(d, expression, versionRow, bindings) {
  if (versionRow.withdrawn) return false;
  if (bindings.pinned.has(`${expression.id}#${versionRow.version}`)) return true;
  if (
    bindings.live.has(expression.id) &&
    expression.current_version === versionRow.version &&
    LIVE_EXPRESSION_STATES.has(versionRow.state)
  ) {
    return true;
  }
  return false;
}

// 全量规则校验，返回错误（必须阻断发布）与提醒（不阻断但需处理）。
export function validateDomain(d) {
  const errors = [];
  const warnings = [];
  const push = (bucket, code, message) => bucket.push({code, message});

  const experts = expertMap(d);
  const topicIds = new Set(d.topics.map((t) => t.id));
  const claims = indexById(d.claims, '科学主张');
  const expressions = indexById(d.expressions, '受众版本');
  indexById(d.evidence, '来源证据');
  indexById(d.disputes, '分歧');
  indexById(d.change_events, '变更事件');
  const carriers = indexById(d.carriers, '发布载体');
  const evidenceById = new Map(d.evidence.map((s) => [s.id, s]));
  const bindings = bindingIndex(d);

  const topicScientist = (expertId, topicId) => {
    const expert = experts.get(expertId);
    return Boolean(expert && expert.role === '科研专家' && expert.topic_ids.includes(topicId));
  };

  // 科学主张：版本链连续，current_version 指向最新版本。
  for (const claim of d.claims) {
    if (!topicIds.has(claim.topic_id)) push(errors, 'E_BROKEN_REF', `主张${claim.id}指向未知课题${claim.topic_id}`);
    const versions = claim.versions.map((v) => v.version);
    versions.forEach((version, i) => {
      if (version !== i + 1) push(errors, 'E_CLAIM_VERSION_GAP', `主张${claim.id}版本不连续：${versions.join(',')}`);
    });
    const latest = Math.max(...versions);
    if (claim.current_version !== latest) {
      push(errors, 'E_CLAIM_CURRENT', `主张${claim.id}的current_version应指向最新版本v${latest}`);
    }
    for (const row of claim.versions) {
      if (row.supersedes != null && !claim.versions.some((v) => v.version === row.supersedes)) {
        push(errors, 'E_BROKEN_REF', `主张${claim.id}v${row.version}的supersedes指向不存在版本`);
      }
    }
  }

  // 来源证据：引用的主张与版本必须存在。
  for (const source of d.evidence) {
    if (!claims.has(source.claim_id)) push(errors, 'E_BROKEN_REF', `证据${source.id}指向未知主张${source.claim_id}`);
    for (const version of source.supports_claim_versions) {
      if (!claimVersion(d, source.claim_id, version)) {
        push(errors, 'E_BROKEN_REF', `证据${source.id}声明支持${source.claim_id}v${version}，该版本不存在`);
      }
    }
  }

  // 受众版本：证据引用、受限信息隔离、专家确认。
  for (const expression of d.expressions) {
    const claim = claims.get(expression.claim_id);
    if (!claim) {
      push(errors, 'E_BROKEN_REF', `表达${expression.id}指向未知主张${expression.claim_id}`);
      continue;
    }
    if (!topicIds.has(expression.topic_id) || expression.topic_id !== claim.topic_id) {
      push(errors, 'E_BROKEN_REF', `表达${expression.id}课题与主张不一致`);
    }
    const versions = expression.versions.map((v) => v.version);
    if (expression.current_version !== Math.max(...versions)) {
      push(errors, 'E_EXPRESSION_CURRENT', `表达${expression.id}的current_version未指向最新版本`);
    }
    for (const row of expression.versions) {
      if (!claimVersion(d, expression.claim_id, row.based_on_claim_version)) {
        push(errors, 'E_BROKEN_REF', `表达${expression.id}v${row.version}基于不存在的主张版本`);
      }
      for (const sourceId of row.evidence_refs) {
        const source = evidenceById.get(sourceId);
        if (!source) {
          push(errors, 'E_BROKEN_REF', `表达${expression.id}v${row.version}引用未知证据${sourceId}`);
          continue;
        }
        if (source.claim_id !== expression.claim_id || !source.supports_claim_versions.includes(row.based_on_claim_version)) {
          push(errors, 'E_EVIDENCE_SCOPE', `表达${expression.id}v${row.version}引用的${sourceId}不支持其所依据的主张版本`);
        }
        if (source.access === '受限') {
          if (isPubliclyInService(d, expression, row, bindings)) {
            push(errors, 'E_RESTRICTED_EVIDENCE_PUBLIC', `受限证据${sourceId}进入了在展公众表达${expression.id}v${row.version}`);
          } else if (!row.withdrawn) {
            push(warnings, 'W_DRAFT_RESTRICTED_REF', `${expression.id}v${row.version}引用受限证据${sourceId}，仅限内部草稿，发布前必须移除`);
          }
        }
      }
      // 已发布表达必须有对应课题科研专家按版本确认。
      if (row.state === '已发布') {
        const confirmed = (row.confirmed_by ?? []).some(
          (c) => topicScientist(c.expert_id, expression.topic_id) &&
            c.claim_version === row.based_on_claim_version &&
            c.expression_version === row.version,
        );
        if (!confirmed) {
          push(errors, 'E_PUBLISHED_UNCONFIRMED', `表达${expression.id}v${row.version}已发布但缺少对应科研专家的按版本确认`);
        }
      }
      for (const confirmation of row.confirmed_by ?? []) {
        if (!experts.has(confirmation.expert_id)) {
          push(errors, 'E_BROKEN_REF', `表达${expression.id}v${row.version}的确认人${confirmation.expert_id}不存在`);
        }
      }
    }
  }

  // 分歧：双方原话保留，裁定结果指向真实存在的新表达版本。
  for (const dispute of d.disputes) {
    if (dispute.positions.length < 2) {
      push(errors, 'E_DISPUTE_ONE_SIDED', `分歧${dispute.id}未保留双方意见`);
    }
    if (dispute.status === '已裁定') {
      if (!dispute.retain_in_record) push(errors, 'E_DISPUTE_NOT_RETAINED', `分歧${dispute.id}已裁定但未要求留档`);
      const produced = dispute.resolution?.produced_expression_version;
      if (produced && !expressionVersion(d, produced.expression_id, produced.version)) {
        push(errors, 'E_BROKEN_REF', `分歧${dispute.id}裁定指向不存在的表达版本`);
      }
    }
  }

  // 变更事件：主张版本与撤回目标必须存在。
  for (const event of d.change_events) {
    if (!claimVersion(d, event.claim_id, event.from_version) || !claimVersion(d, event.claim_id, event.to_version)) {
      push(errors, 'E_BROKEN_REF', `事件${event.id}的主张版本区间不存在`);
    }
    for (const target of event.withdrawn_expressions ?? []) {
      if (!expressionVersion(d, target.expression_id, target.version)) {
        push(errors, 'E_BROKEN_REF', `事件${event.id}撤回了不存在的表达${target.expression_id}v${target.version}`);
      }
    }
  }

  // 载体：印刷载体固定 pin 且必须曾由科研专家确认；实时绑定指向存在的表达。
  for (const carrier of d.carriers) {
    if (carrier.immutable_after_print) {
      if ((carrier.live_bindings ?? []).length > 0) {
        push(errors, 'E_PRINT_NOT_FIXED', `印刷载体${carrier.id}不得携带实时绑定`);
      }
      for (const pin of carrier.pins ?? []) {
        const expression = expressions.get(pin.expression_id);
        const row = expression?.versions.find((v) => v.version === pin.version);
        if (!expression || !row) {
          push(errors, 'E_BROKEN_REF', `载体${carrier.id}固定了不存在的表达${pin.expression_id}v${pin.version}`);
          continue;
        }
        const confirmed = (row.confirmed_by ?? []).some(
          (c) => topicScientist(c.expert_id, expression.topic_id) &&
            c.claim_version === row.based_on_claim_version &&
            c.expression_version === row.version,
        );
        if (!confirmed) push(errors, 'E_PIN_UNCONFIRMED', `载体${carrier.id}印刷的${expression.id}v${pin.version}缺少科研专家确认`);
      }
    } else {
      for (const expressionId of carrier.live_bindings ?? []) {
        if (!expressions.has(expressionId)) push(errors, 'E_BROKEN_REF', `载体${carrier.id}实时绑定了未知表达${expressionId}`);
      }
    }
  }

  // 二维码与载体一一对应。
  for (const qr of d.qr_codes) {
    if (!carriers.has(qr.carrier_id)) push(errors, 'E_BROKEN_REF', `二维码${qr.code}指向未知载体${qr.carrier_id}`);
  }

  // 反馈必须落在具体表达版本上。
  for (const item of d.feedback) {
    if (!expressionVersion(d, item.about.expression_id, item.about.version)) {
      push(errors, 'E_BROKEN_REF', `反馈${item.id}未定位到具体表达版本`);
    }
    if (item.routed_to_dispute && !d.disputes.some((x) => x.id === item.routed_to_dispute)) {
      push(errors, 'E_BROKEN_REF', `反馈${item.id}指向不存在的分歧${item.routed_to_dispute}`);
    }
    if (item.linked_event && !d.change_events.some((x) => x.id === item.linked_event)) {
      push(errors, 'E_BROKEN_REF', `反馈${item.id}指向不存在的事件${item.linked_event}`);
    }
    if (item.status === '待修订' || item.status === '待处理') push(warnings, 'W_FEEDBACK_OPEN', `反馈${item.id}尚未闭环`);
  }

  return {errors, warnings};
}

// 受某变更事件影响的表达：区分已按新版本重写与仍待修订。
export function affectedExpressions(d, eventId) {
  const event = d.change_events.find((e) => e.id === eventId);
  if (!event) throw new Error(`未知变更事件：${eventId}`);
  const remediated = [];
  const stale = [];
  for (const expression of d.expressions) {
    if (expression.claim_id !== event.claim_id) continue;
    const touched = expression.versions.some((v) => v.based_on_claim_version === event.from_version);
    if (!touched) continue;
    const current = expression.versions.find((v) => v.version === expression.current_version);
    if (current.based_on_claim_version >= event.to_version && current.state !== '已撤回') {
      remediated.push({expression_id: expression.id, current_version: current.version, state: current.state});
    } else {
      stale.push({
        expression_id: expression.id,
        current_version: current.version,
        state: current.state,
        revision_note: current.revision_note ?? null,
      });
    }
  }
  return {event, remediated, stale};
}

// 讲解员扫码：取得该现场载体的固定内容与“当前版本”对照。
export function resolveQr(d, code) {
  const qr = d.qr_codes.find((x) => x.code === code);
  if (!qr) throw new Error(`未知二维码：${code}`);
  const carrier = d.carriers.find((c) => c.id === qr.carrier_id);

  if (carrier.immutable_after_print) {
    const items = (carrier.pins ?? []).map((pin) => {
      const expression = d.expressions.find((e) => e.id === pin.expression_id);
      const pinned = expression.versions.find((v) => v.version === pin.version);
      const current = expression.versions.find((v) => v.version === expression.current_version);
      return {
        expression_id: expression.id,
        format: expression.format,
        title: expression.title,
        pinned_version: pin.version,
        pinned_body: pinned.body,
        current_version: expression.current_version,
        current_state: current.state,
        current_body: current.body,
        outdated: pin.version < expression.current_version,
        guide_note: current.revision_note ?? null,
      };
    });
    return {
      code,
      purpose: qr.purpose,
      carrier: {id: carrier.id, kind: carrier.kind, location: carrier.location, printed_batch: carrier.printed_batch},
      binding: '固定版本',
      notice: '该批次为已印刷固定内容，不做替换；口播请以current_body为准，新内容见增发批次。',
      items,
    };
  }

  const items = (carrier.live_bindings ?? []).map((expressionId) => {
    const expression = d.expressions.find((e) => e.id === expressionId);
    const current = expression.versions.find((v) => v.version === expression.current_version);
    return {
      expression_id: expression.id,
      format: expression.format,
      title: expression.title,
      current_version: expression.current_version,
      current_state: current.state,
      current_body: current.body,
      pending_revision: current.state === '需修订',
      guide_note: current.revision_note ?? null,
    };
  });
  return {
    code,
    purpose: qr.purpose,
    carrier: {id: carrier.id, kind: carrier.kind, location: carrier.location},
    binding: '随批准更新',
    items,
  };
}

// 研究机构视角：意见（确认/分歧/事件）如何被处理，反馈是否闭环。
export function institutionReport(d) {
  const experts = expertMap(d);
  const report = [];
  for (const expert of d.experts) {
    const confirmations = [];
    for (const expression of d.expressions) {
      for (const row of expression.versions) {
        for (const confirmation of row.confirmed_by ?? []) {
          if (confirmation.expert_id === expert.id) {
            confirmations.push({
              expression_id: expression.id,
              expression_version: row.version,
              claim_version: confirmation.claim_version,
              at: confirmation.at,
              note: confirmation.note,
              state: row.state,
            });
          }
        }
      }
    }
    const disputes = d.disputes
      .filter((x) => x.positions.some((p) => p.expert_id === expert.id))
      .map((x) => ({
        dispute_id: x.id,
        status: x.status,
        my_stance: x.positions.find((p) => p.expert_id === expert.id)?.stance,
        retained: x.retain_in_record === true,
        resolution: x.resolution?.decision ?? null,
      }));
    const events = d.change_events
      .filter((e) => e.by === expert.id)
      .map((e) => ({event_id: e.id, type: e.type, summary: e.summary, at: e.at}));
    report.push({expert: {id: expert.id, name: expert.name, org: expert.org}, confirmations, disputes, events});
  }

  const feedback = d.feedback.map((item) => {
    const linked = [];
    if (item.routed_to_dispute) linked.push({kind: '分歧', id: item.routed_to_dispute});
    if (item.linked_event) linked.push({kind: '变更事件', id: item.linked_event});
    if (item.resolution_ref) linked.push({kind: '新表达版本', ...item.resolution_ref});
    return {
      feedback_id: item.id,
      about: item.about,
      type: item.type,
      status: item.status,
      handled_via: linked,
    };
  });

  return {generated_at: d.generated_at, by_expert: report, feedback};
}

// 观众疑问/误解回流：从反馈一路追到主张版本、适用范围、证据与确认记录。
export function traceFeedback(d, feedbackId) {
  const item = d.feedback.find((f) => f.id === feedbackId);
  if (!item) throw new Error(`未知反馈：${feedbackId}`);
  const expression = d.expressions.find((e) => e.id === item.about.expression_id);
  const versionRow = expression.versions.find((v) => v.version === item.about.version);
  const claim = d.claims.find((c) => c.id === expression.claim_id);
  const claimRow = claim.versions.find((v) => v.version === versionRow.based_on_claim_version);
  return {
    feedback: item,
    expression: {
      id: expression.id,
      format: expression.format,
      age_band: expression.age_band,
      version: versionRow.version,
      body: versionRow.body,
      state: versionRow.state,
    },
    claim: {
      id: claim.id,
      version: claimRow.version,
      statement: claimRow.statement,
      applicability: claimRow.applicability,
      numeric_findings: claimRow.numeric_findings,
    },
    evidence: versionRow.evidence_refs.map((id) => {
      const source = d.evidence.find((s) => s.id === id);
      return {id, kind: source.kind, citation: source.citation, access: source.access, date: source.date};
    }),
    confirmations: versionRow.confirmed_by ?? [],
    dispute: d.disputes.find((x) => x.id === item.routed_to_dispute) ?? null,
  };
}
