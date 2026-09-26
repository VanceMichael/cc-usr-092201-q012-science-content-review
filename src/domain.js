// 读取并检查项目共享的领域资料。
const REQUIRED_COLLECTIONS = [
  'topics',
  'reviewers',
  'evidences',
  'claims',
  'derivatives',
  'reviews',
  'review_resolutions',
  'change_events',
  'venues',
  'publications',
  'qr_codes',
  'notices',
  'feedback'
];

export function parseDomain(raw) {
  const value = parseJson(raw);
  validateDomain(value);
  return withIndexes(value);
}

export function validateDomain(value) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!isObject(value)) fail('领域资料必须是对象');
  if (!value || value.domain !== 'science-content-review') fail('domain 必须为 science-content-review');
  if (!value || !Number.isInteger(value.version) || value.version < 2) fail('version 必须是不小于 2 的整数');
  if (!value || !nonEmpty(value.sample_id)) fail('sample_id 不能为空');
  for (const field of ['record_types', 'workflow_states', 'facts']) {
    if (!value || !Array.isArray(value[field]) || value[field].length < (field === 'facts' ? 2 : 3)) {
      fail(`${field} 必须是包含足够项的数组`);
    }
  }
  if (!value || !isObject(value.sample) || Object.keys(value.sample).length < 3) fail('sample 必须至少包含三个字段');
  if (errors.length) throw new Error(`领域资料缺少必要内容：${errors.join('；')}`);

  for (const name of REQUIRED_COLLECTIONS) {
    if (!Array.isArray(value[name])) fail(`${name} 必须是数组`);
  }
  if (errors.length) throw new Error(`领域资料缺少必要内容：${errors.join('；')}`);

  const ids = new Map();
  const addId = (kind, item) => {
    if (!isObject(item) || !nonEmpty(item.id)) return fail(`${kind} 缺少 id`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.id)) return fail(`${kind} id 格式不合法：${item.id}`);
    if (ids.has(item.id)) return fail(`id 重复：${item.id}`);
    ids.set(item.id, kind);
  };

  for (const item of value.topics) addId('topic', item);
  for (const item of value.reviewers) addId('reviewer', item);
  for (const item of value.evidences) addId('evidence', item);
  for (const item of value.claims) addId('claim', item);
  for (const item of value.derivatives) addId('derivative', item);
  for (const item of value.reviews) addId('review', item);
  for (const item of value.review_resolutions) addId('review_resolution', item);
  for (const item of value.change_events) addId('change_event', item);
  for (const item of value.venues) addId('venue', item);
  for (const item of value.publications) addId('publication', item);
  for (const item of value.qr_codes) addId('qr_code', item);
  for (const item of value.notices) addId('notice', item);
  for (const item of value.feedback) addId('feedback', item);
  if (errors.length) throw new Error(`领域资料标识无效：${errors.join('；')}`);

  const requireRef = (id, expectedKind, label) => {
    if (!ids.has(id)) fail(`${label} 引用不存在：${id}`);
    else if (ids.get(id) !== expectedKind) fail(`${label} 引用类型错误：${id} 应为 ${expectedKind}`);
  };
  const topicIds = new Set(value.topics.map((item) => item.id));
  const reviewerById = new Map(value.reviewers.map((item) => [item.id, item]));
  const evidenceById = new Map(value.evidences.map((item) => [item.id, item]));
  const claimVersionIds = new Set();
  const derivativesById = new Map(value.derivatives.map((item) => [item.id, item]));
  const reviewById = new Map(value.reviews.map((item) => [item.id, item]));
  const eventById = new Map(value.change_events.map((item) => [item.id, item]));
  const publicationById = new Map(value.publications.map((item) => [item.id, item]));
  const venueById = new Map(value.venues.map((item) => [item.id, item]));
  const feedbackById = new Map(value.feedback.map((item) => [item.id, item]));

  for (const reviewer of value.reviewers) {
    if (!nonEmpty(reviewer.name) || !nonEmpty(reviewer.organization)) fail(`审校人 ${reviewer.id} 缺少名称或机构`);
    for (const topicId of reviewer.expertise_topic_ids ?? []) {
      if (!topicIds.has(topicId)) fail(`审校人 ${reviewer.id} 的专长主题不存在：${topicId}`);
    }
  }

  for (const evidence of value.evidences) {
    if (!topicIds.has(evidence.scope?.topic_id)) fail(`证据 ${evidence.id} 的主题不存在`);
    if (evidence.scope?.public_use_allowed !== true) fail(`证据 ${evidence.id} 未获准公众使用`);
    if (!Array.isArray(evidence.scope?.conditions) || evidence.scope.conditions.length === 0) fail(`证据 ${evidence.id} 缺少适用条件`);
    if (!Array.isArray(evidence.scope?.boundaries) || evidence.scope.boundaries.length === 0) fail(`证据 ${evidence.id} 缺少适用边界`);
    if (evidence.redaction && (!Array.isArray(evidence.redaction.removed_fields) || evidence.redaction.removed_fields.length === 0)) {
      fail(`证据 ${evidence.id} 的删减记录缺少 removed_fields`);
    }
  }

  for (const claim of value.claims) {
    if (!topicIds.has(claim.topic_id)) fail(`主张 ${claim.id} 的主题不存在`);
    const versionIds = new Set();
    for (const version of claim.versions ?? []) {
      addId('claim_version', version);
      if (versionIds.has(version.id)) fail(`主张 ${claim.id} 的版本 id 重复：${version.id}`);
      versionIds.add(version.id);
      claimVersionIds.add(version.id);
      if (!Array.isArray(version.evidence_links) || version.evidence_links.length === 0) {
        fail(`主张版本 ${version.id} 至少需要一条证据`);
        continue;
      }
      for (const link of version.evidence_links) {
        if (!evidenceById.has(link.evidence_id)) fail(`主张版本 ${version.id} 的证据不存在：${link.evidence_id}`);
        else if (evidenceById.get(link.evidence_id).scope.topic_id !== claim.topic_id) {
          fail(`主张版本 ${version.id} 引用了其他主题的证据：${link.evidence_id}`);
        }
        if (!nonEmpty(link.scope_note) || !nonEmpty(link.supports)) fail(`主张版本 ${version.id} 的证据链接缺少支持内容或范围说明`);
      }
    }
    if (!versionIds.has(claim.current_version_id)) fail(`主张 ${claim.id} 的当前版本不存在：${claim.current_version_id}`);
    const current = claim.versions.find((version) => version.id === claim.current_version_id);
    if (current && current.status === '已被替代') fail(`主张 ${claim.id} 不能把已被替代版本设为当前版本`);
  }

  for (const derivative of value.derivatives) {
    if (!topicIds.has(derivative.topic_id)) fail(`衍生内容 ${derivative.id} 的主题不存在`);
    if (!claimVersionIds.has(derivative.claim_version_id)) fail(`衍生内容 ${derivative.id} 的主张版本不存在：${derivative.claim_version_id}`);
    if (derivative.source_derivative_id && !derivativesById.has(derivative.source_derivative_id)) {
      fail(`衍生内容 ${derivative.id} 的来源版本不存在：${derivative.source_derivative_id}`);
    }
    if (derivative.parent_derivative_id && !derivativesById.has(derivative.parent_derivative_id)) {
      fail(`衍生内容 ${derivative.id} 的母版不存在：${derivative.parent_derivative_id}`);
    }
    if (!nonEmpty(derivative.title) || !nonEmpty(derivative.text)) fail(`衍生内容 ${derivative.id} 缺少标题或正文`);
  }

  const approvedReviewsByTarget = new Map();
  for (const review of value.reviews) {
    if (!reviewerById.has(review.reviewer_id)) fail(`审校意见 ${review.id} 的审校人不存在`);
    const targetExists = review.target_type === 'claim_version'
      ? claimVersionIds.has(review.target_id)
      : derivativesById.has(review.target_id);
    if (!targetExists) fail(`审校意见 ${review.id} 的目标不存在：${review.target_id}`);
    if (!nonEmpty(review.comment)) fail(`审校意见 ${review.id} 缺少意见内容`);
    const key = `${review.target_type}:${review.target_id}`;
    if (!approvedReviewsByTarget.has(key)) approvedReviewsByTarget.set(key, []);
    approvedReviewsByTarget.get(key).push(review);
  }

  const approvedOrPublished = new Set(['已批准', '已发布']);
  for (const derivative of value.derivatives) {
    if (!approvedOrPublished.has(derivative.status)) continue;
    const claim = value.claims.find((item) => item.versions.some((version) => version.id === derivative.claim_version_id));
    const expertReviews = approvedReviewsByTarget.get(`derivative:${derivative.id}`) ?? [];
    const hasScienceApproval = expertReviews.some((review) => {
      if (review.decision !== '同意') return false;
      const reviewer = reviewerById.get(review.reviewer_id);
      return reviewer.kind === '科学专家' && reviewer.expertise_topic_ids.includes(derivative.topic_id);
    });
    if (!hasScienceApproval) fail(`衍生内容 ${derivative.id} 已批准但缺少对应科学专家确认`);
    if (claim && claim.current_version_id !== derivative.claim_version_id && derivative.status === '已发布') {
      fail(`已发布内容 ${derivative.id} 不应绑定非当前主张版本；历史版本应通过不可变 publication 保留`);
    }
  }

  const resolutionIds = new Set();
  for (const resolution of value.review_resolutions) {
    resolutionIds.add(resolution.id);
    if (!reviewById.has(resolution.review_id)) fail(`意见处理 ${resolution.id} 的审校意见不存在`);
    if (resolution.change_event_id && !eventById.has(resolution.change_event_id)) fail(`意见处理 ${resolution.id} 的变更事件不存在`);
    for (const derivativeId of resolution.resulting_derivative_ids ?? []) {
      if (!derivativesById.has(derivativeId)) fail(`意见处理 ${resolution.id} 的衍生内容不存在：${derivativeId}`);
    }
    for (const reviewId of resolution.related_review_ids ?? []) {
      if (!reviewById.has(reviewId)) fail(`意见处理 ${resolution.id} 的关联审校意见不存在：${reviewId}`);
    }
  }

  for (const event of value.change_events) {
    if (!topicIds.has(event.topic_id)) fail(`变更事件 ${event.id} 的主题不存在`);
    for (const field of ['from_claim_version_id', 'to_claim_version_id']) {
      if (event[field] && !claimVersionIds.has(event[field])) fail(`变更事件 ${event.id} 的主张版本不存在：${event[field]}`);
    }
    for (const field of ['from_derivative_id', 'to_derivative_id']) {
      if (event[field] && !derivativesById.has(event[field])) fail(`变更事件 ${event.id} 的衍生内容不存在：${event[field]}`);
    }
    if (event.evidence_id && !evidenceById.has(event.evidence_id)) fail(`变更事件 ${event.id} 的证据不存在`);
    if (event.feedback_id && !feedbackById.has(event.feedback_id)) fail(`变更事件 ${event.id} 的反馈不存在`);
    if (event.review_id && !reviewById.has(event.review_id)) fail(`变更事件 ${event.id} 的审校意见不存在`);
    for (const reviewId of event.related_review_ids ?? []) {
      if (!reviewById.has(reviewId)) fail(`变更事件 ${event.id} 的关联审校意见不存在：${reviewId}`);
    }
  }

  for (const publication of value.publications) {
    if (!venueById.has(publication.venue_id)) fail(`发布记录 ${publication.id} 的场地不存在`);
    if (!derivativesById.has(publication.derivative_id)) fail(`发布记录 ${publication.id} 的内容不存在`);
    if (publication.immutable !== (publication.status === '已印刷不可变')) fail(`发布记录 ${publication.id} 的不可变状态不一致`);
    if (!/^sha256:[a-f0-9]{64}$/.test(publication.content_hash)) fail(`发布记录 ${publication.id} 的 content_hash 不合法`);
  }

  for (const code of value.qr_codes) {
    if (!venueById.has(code.venue_id)) fail(`二维码 ${code.id} 的场地不存在`);
    if (!publicationById.has(code.linked_publication_id)) fail(`二维码 ${code.id} 的发布记录不存在`);
    if (publicationById.get(code.linked_publication_id).venue_id !== code.venue_id) fail(`二维码 ${code.id} 跨场地绑定发布记录`);
  }

  for (const notice of value.notices) {
    if (!publicationById.has(notice.publication_id)) fail(`提示 ${notice.id} 的发布记录不存在`);
    if (!eventById.has(notice.change_event_id)) fail(`提示 ${notice.id} 的变更事件不存在`);
    if (!derivativesById.has(notice.current_derivative_id)) fail(`提示 ${notice.id} 的当前内容不存在`);
  }

  for (const item of value.feedback) {
    if (!venueById.has(item.venue_id)) fail(`反馈 ${item.id} 的场地不存在`);
    if (!derivativesById.has(item.target_derivative_id)) fail(`反馈 ${item.id} 的目标内容不存在`);
    if (item.change_event_id && !eventById.has(item.change_event_id)) fail(`反馈 ${item.id} 的变更事件不存在`);
    if (item.revised_derivative_id && !derivativesById.has(item.revised_derivative_id)) fail(`反馈 ${item.id} 的修订内容不存在`);
  }

  if (errors.length) throw new Error(`领域资料引用或业务规则无效：${errors.join('；')}`);
  return value;
}

export function getClaim(value, claimId) {
  const domain = parseDomain(value);
  return domain.claims.find((claim) => claim.id === claimId);
}

export function evidenceTrail(value, claimVersionId) {
  const domain = parseDomain(value);
  const version = findClaimVersion(domain, claimVersionId);
  return version.evidence_links.map((link) => {
    const evidence = domain.evidences.find((item) => item.id === link.evidence_id);
    return {
      claim_version_id: claimVersionId,
      evidence,
      supports: link.supports,
      scope_note: link.scope_note
    };
  });
}

export function derivativesForClaimVersion(value, claimVersionId) {
  const domain = parseDomain(value);
  if (!findClaimVersion(domain, claimVersionId, false)) throw new Error(`主张版本不存在：${claimVersionId}`);
  return domain.derivatives.filter((item) => item.claim_version_id === claimVersionId);
}

export function affectedDerivatives(value, evidenceId) {
  const domain = parseDomain(value);
  if (!domain.evidences.some((item) => item.id === evidenceId)) throw new Error(`证据不存在：${evidenceId}`);
  const claimVersionIds = new Set(domain.claims
    .flatMap((claim) => claim.versions)
    .filter((version) => version.evidence_links.some((link) => link.evidence_id === evidenceId))
    .map((version) => version.id));
  return domain.derivatives.filter((item) => claimVersionIds.has(item.claim_version_id));
}

export function expertApprovals(value, derivativeId) {
  const domain = parseDomain(value);
  if (!domain.derivatives.some((item) => item.id === derivativeId)) throw new Error(`衍生内容不存在：${derivativeId}`);
  return domain.reviews.filter((review) => review.target_type === 'derivative'
    && review.target_id === derivativeId
    && review.decision === '同意'
    && domain.reviewers.some((reviewer) => reviewer.id === review.reviewer_id && reviewer.kind === '科学专家'))
    .map((review) => ({
      ...review,
      reviewer: domain.reviewers.find((reviewer) => reviewer.id === review.reviewer_id)
    }));
}

export function openDisagreements(value, topicId) {
  const domain = parseDomain(value);
  if (topicId && !domain.topics.some((topic) => topic.id === topicId)) throw new Error(`主题不存在：${topicId}`);
  return domain.change_events.filter((event) => event.change_kind === '专家分歧'
    && event.status === '开放'
    && (!topicId || event.topic_id === topicId))
    .map((event) => ({
      event,
      reviews: (event.related_review_ids ?? []).map((reviewId) => domain.reviews.find((review) => review.id === reviewId)),
      resolutions: domain.review_resolutions.filter((resolution) => resolution.disposition === '分歧保留'
        && (event.related_review_ids ?? []).includes(resolution.review_id))
    }));
}

export function resolveQr(value, qrId) {
  const domain = parseDomain(value);
  const code = domain.qr_codes.find((item) => item.id === qrId);
  if (!code) throw new Error(`二维码不存在：${qrId}`);
  const linkedPublication = domain.publications.find((item) => item.id === code.linked_publication_id);
  const notices = domain.notices.filter((notice) => notice.publication_id === linkedPublication.id && notice.show_on_scan);
  const currentNotice = notices.find((notice) => notice.current_derivative_id) ?? notices[0];
  const currentDerivative = currentNotice
    ? domain.derivatives.find((item) => item.id === currentNotice.current_derivative_id)
    : domain.derivatives.find((item) => item.id === linkedPublication.derivative_id);

  return {
    qr_code: code,
    printed_publication: linkedPublication,
    printed_derivative: domain.derivatives.find((item) => item.id === linkedPublication.derivative_id),
    current_derivative: currentDerivative,
    notices
  };
}

export function feedbackLoop(value, feedbackId) {
  const domain = parseDomain(value);
  const feedback = domain.feedback.find((item) => item.id === feedbackId);
  if (!feedback) throw new Error(`观众反馈不存在：${feedbackId}`);
  return {
    feedback,
    change_event: feedback.change_event_id ? domain.change_events.find((item) => item.id === feedback.change_event_id) : null,
    target_derivative: domain.derivatives.find((item) => item.id === feedback.target_derivative_id),
    revised_derivative: feedback.revised_derivative_id
      ? domain.derivatives.find((item) => item.id === feedback.revised_derivative_id)
      : null
  };
}

export function organizationReviewReport(value, topicId) {
  const domain = parseDomain(value);
  return domain.reviews
    .filter((review) => {
      if (topicId) {
        const derivative = domain.derivatives.find((item) => item.id === review.target_id);
        const version = review.target_type === 'claim_version' ? findClaimVersion(domain, review.target_id, false) : null;
        const claim = version && domain.claims.find((item) => item.versions.some((entry) => entry.id === version.id));
        return derivative?.topic_id === topicId || claim?.topic_id === topicId;
      }
      return true;
    })
    .map((review) => {
      const resolutions = domain.review_resolutions.filter((item) => item.review_id === review.id && item.visible_to_research_organization);
      return {
        review,
        reviewer: domain.reviewers.find((reviewer) => reviewer.id === review.reviewer_id),
        resolutions
      };
    });
}

function parseJson(raw) {
  if (typeof raw === 'string') return JSON.parse(raw);
  if (isObject(raw)) return raw;
  throw new Error('领域资料必须是 JSON 字符串或对象');
}

function withIndexes(value) {
  if (value.__indexed) return value;
  Object.defineProperty(value, '__indexed', { value: true, enumerable: false });
  return value;
}

function findClaimVersion(value, claimVersionId, required = true) {
  for (const claim of value.claims) {
    const version = claim.versions.find((item) => item.id === claimVersionId);
    if (version) return version;
  }
  if (required) throw new Error(`主张版本不存在：${claimVersionId}`);
  return null;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
