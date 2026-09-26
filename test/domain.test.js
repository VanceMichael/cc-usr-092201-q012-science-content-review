import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  parseDomain,
  validateDomain,
  affectedExpressions,
  resolveQr,
  institutionReport,
  traceFeedback,
} from '../src/domain.js';

async function load() {
  const raw = await readFile(new URL('../fixtures/domain.json', import.meta.url), 'utf8');
  return parseDomain(raw);
}

test('领域样例字段完整', async () => {
  const value = await load();
  assert.equal(value.domain, 'science-content-review');
  assert.ok(value.workflow_states.length >= 3);
});

test('基线样例通过全部领域规则', async () => {
  const d = await load();
  const {errors, warnings} = validateDomain(d);
  assert.deepEqual(errors, []);
  // 仅允许存在“草稿引用受限证据”和“反馈待闭环”两类提醒。
  assert.ok(warnings.every((w) => ['W_DRAFT_RESTRICTED_REF', 'W_FEEDBACK_OPEN'].includes(w.code)));
});

test('两个课题均覆盖主张-证据-表达-确认链', async () => {
  const d = await load();
  for (const topicId of ['T-HIAF', 'T-MG']) {
    const claims = d.claims.filter((c) => c.topic_id === topicId);
    assert.ok(claims.length >= 1);
    for (const claim of claims) {
      assert.ok(d.evidence.some((s) => s.claim_id === claim.id));
      assert.ok(d.expressions.some((e) => e.claim_id === claim.id));
    }
  }
});

test('通俗改写须获得对应课题科研专家按版本确认；缺确认即报错', async () => {
  const d = await load();
  const label = d.expressions.find((e) => e.id === 'EX-MG-01-LABEL-1114');
  const v2 = label.versions.find((v) => v.version === 2);
  assert.equal(v2.state, '已发布');
  assert.ok(v2.confirmed_by.some(
    (c) => c.expert_id === 'E-02' && c.claim_version === 2 && c.expression_version === 2,
  ));

  // 破坏确认后必须被规则检出。
  v2.confirmed_by = [];
  const {errors} = validateDomain(d);
  assert.ok(errors.some((e) => e.code === 'E_PUBLISHED_UNCONFIRMED'));
});

test('非对应课题专家的确认无效', async () => {
  const d = await load();
  const label = d.expressions.find((e) => e.id === 'EX-MG-01-LABEL-1114');
  label.versions.find((v) => v.version === 2).confirmed_by = [
    {expert_id: 'E-01', claim_version: 2, expression_version: 2, at: '2026-04-09', note: '加速器专家越权确认'},
  ];
  const {errors} = validateDomain(d);
  assert.ok(errors.some((e) => e.code === 'E_PUBLISHED_UNCONFIRMED'));
});

test('受限证据：在展表达引用即阻断，未发布草稿仅提醒', async () => {
  const d = await load();
  // 基线：受限证据只出现在已撤回版本和未提交草稿中。
  const {errors: baseErrors} = validateDomain(d);
  assert.equal(baseErrors.some((e) => e.code === 'E_RESTRICTED_EVIDENCE_PUBLIC'), false);
  const {warnings} = validateDomain(d);
  assert.ok(warnings.some((w) => w.code === 'W_DRAFT_RESTRICTED_REF'));

  // 让在展安全提示引用受限证据，必须被阻断。
  const safety = d.expressions.find((e) => e.id === 'EX-HIAF-02-SAFETY');
  safety.versions.find((v) => v.version === 2).evidence_refs.push('SRC-HIAF-02-RES');
  const {errors} = validateDomain(d);
  assert.ok(errors.some((e) => e.code === 'E_RESTRICTED_EVIDENCE_PUBLIC'));
});

test('证据只能支持其声明覆盖的主张版本', async () => {
  const d = await load();
  const script = d.expressions.find((e) => e.id === 'EX-MG-01-SCRIPT');
  // 旧脚本若改挂主张v2却仍只引用只支持v1的旧数据，应报错。
  const v1 = script.versions.find((v) => v.version === 1);
  v1.based_on_claim_version = 2;
  const {errors} = validateDomain(d);
  assert.ok(errors.some((e) => e.code === 'E_EVIDENCE_SCOPE'));
});

test('分歧保留双方原话且裁定产出可追溯的新版本', async () => {
  const d = await load();
  const dispute = d.disputes.find((x) => x.id === 'D-01');
  assert.equal(dispute.positions.length, 2);
  assert.equal(dispute.retain_in_record, true);
  assert.ok(dispute.positions.some((p) => p.stance === '反对原比喻'));
  assert.ok(dispute.positions.some((p) => p.stance === '主张保留具象比喻'));
  assert.deepEqual(dispute.resolution.produced_expression_version,
    {expression_id: 'EX-MG-01-LABEL-710', version: 2});

  // 删除一方意见必须报错。
  dispute.positions.length = 1;
  assert.ok(validateDomain(d).errors.some((e) => e.code === 'E_DISPUTE_ONE_SIDED'));
});

test('印刷载体固定版本：旧批次不被新版悄悄替换，只能增发新批次', async () => {
  const d = await load();
  const oldBatch = d.carriers.find((c) => c.id === 'CP-001');
  assert.equal(oldBatch.immutable_after_print, true);
  assert.deepEqual(oldBatch.pins.map((p) => [p.expression_id, p.version]),
    [['EX-HIAF-01-LABEL', 1], ['EX-MG-01-LABEL-1114', 1]]);
  const newBatch = d.carriers.find((c) => c.id === 'CP-002');
  assert.deepEqual(newBatch.pins.map((p) => [p.expression_id, p.version]),
    [['EX-HIAF-01-LABEL', 2], ['EX-HIAF-02-SAFETY', 2], ['EX-MG-01-LABEL-1114', 2]]);

  // 印刷载体若改为实时绑定，应被禁止。
  oldBatch.live_bindings = ['EX-HIAF-01-LABEL'];
  assert.ok(validateDomain(d).errors.some((e) => e.code === 'E_PRINT_NOT_FIXED'));
});

test('印刷 pin 必须是经科研专家确认的版本', async () => {
  const d = await load();
  const carrier = d.carriers.find((c) => c.id === 'CP-001');
  // 指向未经确认的 7-10 岁 v1。
  carrier.pins.push({expression_id: 'EX-MG-01-LABEL-710', version: 1, content_hash: null});
  const {errors} = validateDomain(d);
  assert.ok(errors.some((e) => e.code === 'E_PIN_UNCONFIRMED'));
});

test('研究更新事件：只标出受影响表达，并区分已重写与仍待修订', async () => {
  const d = await load();
  const result = affectedExpressions(d, 'EV-01');
  const remediatedIds = result.remediated.map((x) => x.expression_id).sort();
  const staleIds = result.stale.map((x) => x.expression_id).sort();
  assert.deepEqual(remediatedIds, ['EX-MG-01-A11Y', 'EX-MG-01-LABEL-1114', 'EX-MG-01-LABEL-710']);
  assert.deepEqual(staleIds, ['EX-MG-01-SCRIPT']);
  // 加速器相关表达不受微重力事件影响。
  assert.ok(! [...remediatedIds, ...staleIds].some((id) => id.includes('HIAF')));
});

test('数字修正事件：翻译版本被标为需修订且只修受影响从句', async () => {
  const d = await load();
  const result = affectedExpressions(d, 'EV-02');
  const stale = result.stale.find((x) => x.expression_id === 'EX-HIAF-01-EN');
  assert.ok(stale, '英文翻译应在待修订列表中');
  assert.match(stale.revision_note, /83%/);
});

test('扫码：印刷批次返回固定原文与当前版本对照，屏幕返回实时当前版', async () => {
  const d = await load();
  const print = resolveQr(d, 'QR-PRINT-001');
  assert.equal(print.binding, '固定版本');
  const hiaf = print.items.find((i) => i.expression_id === 'EX-HIAF-01-LABEL');
  assert.equal(hiaf.pinned_version, 1);
  assert.match(hiaf.pinned_body, /80%/);
  assert.equal(hiaf.current_version, 2);
  assert.match(hiaf.current_body, /83%/);
  assert.equal(hiaf.outdated, true);

  const screen = resolveQr(d, 'QR-SCREEN-101');
  assert.equal(screen.binding, '随批准更新');
  const mg = screen.items.find((i) => i.expression_id === 'EX-MG-01-LABEL-710');
  assert.equal(mg.current_version, 2);
  assert.equal(mg.pending_revision, false);
});

test('讲解平板扫码能看到脚本仍待修订及修订提示', async () => {
  const d = await load();
  const tablet = resolveQr(d, 'QR-TABLET-102');
  const script = tablet.items.find((i) => i.expression_id === 'EX-MG-01-SCRIPT');
  assert.equal(script.pending_revision, true);
  assert.match(script.guide_note, /2.7秒/);
});

test('机构报告：看得到每条专家意见的处理结果与反馈闭环', async () => {
  const d = await load();
  const report = institutionReport(d);
  const lin = report.by_expert.find((x) => x.expert.id === 'E-02');
  assert.ok(lin.disputes.some((x) => x.dispute_id === 'D-01' && x.retained && x.status === '已裁定'));
  assert.ok(lin.events.some((x) => x.event_id === 'EV-01'));
  assert.ok(lin.confirmations.some((c) => c.expression_id === 'EX-MG-01-LABEL-710' && c.state === '已发布'));

  const fb1 = report.feedback.find((f) => f.feedback_id === 'FB-01');
  assert.ok(fb1.handled_via.some((h) => h.kind === '分歧' && h.id === 'D-01'));
  assert.ok(fb1.handled_via.some((h) => h.kind === '新表达版本' && h.version === 2));
});

test('观众误解回流到具体表达版本，并可追溯主张、适用范围、证据与确认', async () => {
  const d = await load();
  const trace = traceFeedback(d, 'FB-01');
  assert.equal(trace.expression.id, 'EX-MG-01-LABEL-710');
  assert.equal(trace.expression.version, 1);
  assert.equal(trace.claim.id, 'C-MG-01');
  assert.equal(trace.claim.version, 1);
  assert.match(trace.claim.applicability.not_claimed.join(''), /在轨/);
  assert.equal(trace.evidence[0].access, '公开');
  assert.equal(trace.dispute.id, 'D-01');
});

test('安全相关反馈可由已发布安全提示直接回复', async () => {
  const d = await load();
  const trace = traceFeedback(d, 'FB-03');
  assert.equal(trace.expression.version, 2);
  assert.equal(trace.expression.state, '已发布');
  assert.deepEqual(trace.evidence.map((s) => s.access), ['公开']);
});

test('敏感删减事件撤回了误引受限报告的旧版安全提示', async () => {
  const d = await load();
  const ev = d.change_events.find((e) => e.id === 'EV-03');
  const target = ev.withdrawn_expressions[0];
  const expression = d.expressions.find((e) => e.id === target.expression_id);
  const row = expression.versions.find((v) => v.version === target.version);
  assert.equal(row.withdrawn, true);
  assert.match(row.withdraw_reason, /敏感|受限/);
});
