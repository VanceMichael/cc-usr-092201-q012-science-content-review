import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseDomain,
  evidenceTrail,
  derivativesForClaimVersion,
  affectedDerivatives,
  expertApprovals,
  openDisagreements,
  resolveQr,
  feedbackLoop,
  organizationReviewReport
} from '../src/domain.js';

const fixtureUrl = new URL('../fixtures/domain.json', import.meta.url);
const raw = await readFile(fixtureUrl, 'utf8');
const domain = parseDomain(raw);
const clone = () => JSON.parse(JSON.stringify(domain));

test('领域样例字段完整', () => {
  assert.equal(domain.domain, 'science-content-review');
  assert.ok(domain.version >= 2);
  assert.ok(domain.workflow_states.length >= 3);
  assert.deepEqual(domain.sample.topics, ['强流重离子加速器', '微重力液体运输']);
});

test('每条主张版本都指向证据、支持内容和适用范围', () => {
  for (const claim of domain.claims) {
    for (const version of claim.versions) {
      assert.ok(version.evidence_links.length >= 1, `${version.id} 缺少证据`);
      for (const link of version.evidence_links) {
        const evidence = domain.evidences.find((item) => item.id === link.evidence_id);
        assert.ok(evidence, `${version.id} 引用了不存在的证据`);
        assert.equal(evidence.scope.topic_id, claim.topic_id);
        assert.ok(evidence.scope.conditions.length >= 1);
        assert.ok(evidence.scope.boundaries.length >= 1);
        assert.match(link.scope_note, /\S/);
      }
    }
  }
});

test('可以从科学主张追踪到证据及适用边界', () => {
  const trail = evidenceTrail(domain, 'claim-hiaf-intensity-v2');
  assert.deepEqual(trail.map((item) => item.evidence.id), [
    'ev-hiaf-2026-correction',
    'ev-hiaf-2025-paper'
  ]);
  assert.match(trail[0].scope_note, /2026年8月6日/);
  assert.match(trail[0].evidence.scope.boundaries.join('；'), /不回溯改写历史印刷物正文/);
});

test('证据更新能够圈定受影响的分龄和多载体内容', () => {
  const affected = affectedDerivatives(domain, 'ev-fluid-2026-update').map((item) => item.id);
  assert.deepEqual(affected.sort(), [
    'deriv-fluid-a11y-10-v1',
    'deriv-fluid-interact-6-v1',
    'deriv-fluid-label-10-v2',
    'deriv-fluid-label-en-v1'
  ]);

  const sameClaim = derivativesForClaimVersion(domain, 'claim-fluid-capillary-v2').map((item) => item.id);
  assert.ok(sameClaim.includes('deriv-fluid-label-10-v2'));
  assert.ok(sameClaim.includes('deriv-fluid-interact-6-v1'));
});

test('已批准的通俗改写均有对应主题科学专家确认', () => {
  const approved = domain.derivatives.filter((item) => item.status === '已批准');
  assert.ok(approved.length >= 5);
  for (const derivative of approved) {
    const approvals = expertApprovals(domain, derivative.id);
    assert.ok(approvals.length >= 1, `${derivative.id} 缺少科学专家同意`);
    assert.ok(approvals.every((item) => item.reviewer.expertise_topic_ids.includes(derivative.topic_id)));
  }

  const translation = domain.derivatives.find((item) => item.id === 'deriv-fluid-label-en-v1');
  assert.equal(translation.status, '待确认');
  assert.equal(expertApprovals(domain, translation.id).length, 0);
});

test('缺少专家确认的批准内容不能通过校验', () => {
  const value = clone();
  value.derivatives.find((item) => item.id === 'deriv-fluid-label-en-v1').status = '已批准';
  assert.throws(() => parseDomain(value), /deriv-fluid-label-en-v1 已批准但缺少对应科学专家确认/);
});

test('数字修正和研究更新保留新旧主张、新旧衍生内容及处理理由', () => {
  const numberEvent = domain.change_events.find((item) => item.id === 'event-hiaf-number-correction');
  assert.equal(numberEvent.change_kind, '数字修正');
  assert.equal(numberEvent.from_claim_version_id, 'claim-hiaf-intensity-v1');
  assert.equal(numberEvent.to_claim_version_id, 'claim-hiaf-intensity-v2');

  const resolution = domain.review_resolutions.find((item) => item.id === 'resolution-hiaf-number');
  assert.equal(resolution.disposition, '采纳');
  assert.equal(resolution.status, '已处理');
  assert.equal(resolution.visible_to_research_organization, true);
  assert.deepEqual(resolution.resulting_derivative_ids, ['deriv-hiaf-label-10-v2']);

  const updateEvent = domain.change_events.find((item) => item.id === 'event-fluid-research-update');
  assert.equal(updateEvent.change_kind, '研究更新');
  assert.equal(updateEvent.evidence_id, 'ev-fluid-2026-update');
});

test('敏感细节删减记录被删除字段且不把敏感字段放入公开证据', () => {
  const event = domain.change_events.find((item) => item.id === 'event-hiaf-redaction');
  assert.deepEqual(event.removed_fields, ['联锁触发阈值', '设备间路线', '巡检时间']);
  const evidence = domain.evidences.find((item) => item.id === 'ev-hiaf-safety');
  assert.equal(evidence.redaction.redacted, true);
  assert.match(JSON.stringify(evidence), /公开版只保留多层屏蔽/);
  assert.doesNotMatch(JSON.stringify(evidence), /示例阈值|具体路线|具体巡检时间/);
});

test('多人意见冲突保持开放并完整保留双方意见', () => {
  const disagreements = openDisagreements(domain, 'hiaf');
  assert.equal(disagreements.length, 1);
  assert.equal(disagreements[0].event.status, '开放');
  assert.deepEqual(disagreements[0].reviews.map((item) => item.id), [
    'review-hiaf-safety-detail',
    'review-hiaf-safety-education'
  ]);
  assert.equal(disagreements[0].resolutions[0].disposition, '分歧保留');
  assert.match(disagreements[0].resolutions[0].rationale, /安全专员/);
  assert.match(disagreements[0].resolutions[0].rationale, /教育团队/);
});

test('讲解员扫码取得不可变印刷物、现场当前版本和更正提示', () => {
  const result = resolveQr(domain, 'qr-hiaf-old-label');
  assert.equal(result.printed_publication.immutable, true);
  assert.equal(result.printed_publication.status, '已印刷不可变');
  assert.equal(result.printed_derivative.id, 'deriv-hiaf-label-10-v1');
  assert.equal(result.current_derivative.id, 'deriv-hiaf-label-10-v2');
  assert.notEqual(result.printed_derivative.text, result.current_derivative.text);
  assert.equal(result.notices[0].severity, '数字更正');
  assert.match(result.notices[0].message, /旧展签正文不被静默改写/);
});

test('研究机构可以看到每条意见的处理状态和理由', () => {
  const report = organizationReviewReport(domain, 'hiaf');
  const entry = report.find((item) => item.review.id === 'review-hiaf-v1-number');
  assert.equal(entry.reviewer.kind, '科学专家');
  assert.equal(entry.resolutions[0].status, '已处理');
  assert.match(entry.resolutions[0].rationale, /设计范围/);

  const conflict = report.find((item) => item.review.id === 'review-hiaf-safety-detail');
  assert.equal(conflict.resolutions[0].status, '开放');
  assert.equal(conflict.resolutions[0].disposition, '分歧保留');
});

test('观众疑问或误解回流到具体表达并可只修订受影响内容', () => {
  const loop = feedbackLoop(domain, 'feedback-fluid-001');
  assert.equal(loop.feedback.target_expression, '水会靠着细小通道自己向前走');
  assert.equal(loop.target_derivative.id, 'deriv-fluid-label-10-v1');
  assert.equal(loop.revised_derivative.id, 'deriv-fluid-interact-6-v1');
  assert.equal(loop.change_event.id, 'event-fluid-visitor-misread');
  assert.match(loop.feedback.response_note, /带气泡通道/);
});

test('印刷发布记录必须有内容哈希且不可静默改成新版', () => {
  const value = clone();
  const publication = value.publications.find((item) => item.id === 'pub-hiaf-label-printed-old');
  publication.derivative_id = 'deriv-hiaf-label-10-v2';
  publication.immutable = false;
  assert.throws(() => parseDomain(value), /不可变状态不一致/);
});

test('跨主题借用证据不能通过校验', () => {
  const value = clone();
  const version = value.claims.find((item) => item.id === 'claim-fluid-capillary').versions[0];
  version.evidence_links.push({
    evidence_id: 'ev-hiaf-2025-paper',
    supports: '错误借用加速器证据',
    scope_note: '不应通过'
  });
  assert.throws(() => parseDomain(value), /引用了其他主题的证据/);
});
