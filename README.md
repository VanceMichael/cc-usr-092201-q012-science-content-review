# 科研成果科普审校

维护科研成果科普改写、专家审校和多载体发布资料，解决“哪句话仍有证据、适合哪个年龄、现场是否当前版本、意见如何被处理”的追踪问题。

## 资料范围

- 领域样例：`fixtures/domain.json`
- 结构契约：`contracts/domain.schema.json`
- 业务校验与查询：`src/domain.js`
- 规则测试：`test/domain.test.js`

当前样例覆盖两个虚构主题：

1. 强流重离子加速器
2. 微重力液体运输

样例中的人员、机构、论文、数据集和哈希均为虚构，不含真实个人资料、账号或连接凭据。

## 贯穿写作、审校和发布的对象模型

资料从证据开始，而不是从成稿开始：

- `evidences`：来源证据，记录来源类型、定位符、摘录、关键数字、适用条件、适用边界和公众使用许可。
- `claims` / `claim.versions`：科学主张及其版本。每个主张版本必须至少链接一条证据，并说明该证据“支持什么”和“适用范围”。
- `derivatives`：面向不同受众和载体的衍生内容，包括展签、交互脚本、翻译、无障碍文本和安全提示；使用年龄段、语言和类型区分。
- `reviews`：专家、安全、教育或翻译人员对具体主张版本/衍生内容的意见。
- `review_resolutions`：每条意见的采纳、未采纳、延后或分歧保留处理，以及面向研究机构可见的理由。
- `change_events`：研究更新、数字修正、敏感细节删减、专家分歧和观众误解，保留新旧版本之间的链接。
- `publications`：实际发布记录。纸质展签等已印刷载体使用内容哈希固定为不可变记录。
- `qr_codes` / `notices`：讲解员扫码后同时取得已印刷内容、场地当前版本和更正提示。
- `feedback`：观众疑问或误解，精确定位到某条表达，并链接后续变更与修订内容。

流程状态仍包括：待改写 → 审校中 → 有分歧 → 已批准 → 已发布 → 需修订。

## 关键业务规则

`parseDomain` 不只检查字段是否存在，还会校验：

1. 每条科学主张都能追溯到同主题证据、证据支持点和适用范围。
2. 证据必须包含公众使用许可、适用条件和不能外推的边界。
3. 已批准或已发布的通俗改写必须获得对应主题科学专家的“同意”。
4. 研究更新、数字修正和敏感删减必须保留旧主张/旧内容，不能只留下最新文案。
5. 专家意见冲突可保持开放，并以“分歧保留”记录各方理由。
6. 已印刷发布物是不可变记录；新版只能通过新批次、数字渠道或扫码更正提示呈现。
7. 二维码必须绑定同一场地的发布记录，扫码结果区分“印刷物原文”和“现场当前版本”。
8. 观众反馈必须落到具体衍生内容和具体表达，后续只能修订受影响的内容。
9. 衍生内容不能跨主题借用证据。

## 查询接口示例

```js
import { readFile } from 'node:fs/promises';
import {
  parseDomain,
  evidenceTrail,
  affectedDerivatives,
  openDisagreements,
  resolveQr,
  feedbackLoop,
  organizationReviewReport
} from './src/domain.js';

const raw = await readFile('./fixtures/domain.json', 'utf8');
const domain = parseDomain(raw);

// 查看某条主张版本背后的证据、支持点和适用边界。
evidenceTrail(domain, 'claim-hiaf-intensity-v2');

// 一条证据更新后，找出所有受影响的展签、脚本、翻译和无障碍文本。
affectedDerivatives(domain, 'ev-fluid-2026-update');

// 查看仍未解决的专家分歧及双方意见。
openDisagreements(domain, 'hiaf');

// 讲解员扫描旧纸质展签二维码：取得旧印刷物、当前版本和更正提示。
resolveQr(domain, 'qr-hiaf-old-label');

// 追踪观众误解对应哪句话、引发了什么变更、修订了哪部分内容。
feedbackLoop(domain, 'feedback-fluid-001');

// 向研究机构展示意见处理状态、处理理由和责任人。
organizationReviewReport(domain, 'hiaf');
```

## 本地校验

```bash
npm test
```

测试会读取样例并验证：

- 证据链与适用范围
- 分龄和多载体衍生内容
- 对应专家确认
- 数字修正、研究更新和敏感删减
- 未解决冲突的保留
- 印刷物不可静默替换
- 扫码取得现场当前版本
- 研究机构可见的意见处理结果
- 观众反馈回流和局部修订
