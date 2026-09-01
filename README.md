# 大全助你选金枕榴莲

一个面向手机端的开源 AI 金枕榴莲外观辅助挑选工具。用户拍摄一张合照，系统为清晰可见的榴莲编号并给出候选建议，随后可补拍果柄、果身和果底进行复核。

> 本项目只提供可见外观辅助判断，不能检测甜度、肉量、生包、死包或内部变质，也不能替代开果检验和商家承诺。

## 功能

- 一张照片识别并编号最多 20 颗泰国金枕榴莲
- 只编号清晰可识别目标，不强行猜测遮挡目标
- 合照初筛 + 单颗三角度补拍复核
- 模型和 OpenAI Responses API 兼容地址均由部署者配置
- 每台浏览器设备最多 5 个完整任务，同一任务补拍不重复计次
- 浏览器端重新编码图片并移除 EXIF/GPS
- 支持 Cloudflare Workers，并提供腾讯 CloudBase 适配实现

## 不会使用作者的 Token

本仓库只公开源代码，不公开或共享作者的 API Key、Token、数据库凭证、云账号和线上模型额度。克隆者必须配置自己的模型 API Key 和自己的云环境。`.dev.vars` 已被 Git 忽略，禁止提交真实凭证。

## 本地运行

要求 Node.js 24 或更高版本。

```bash
git clone https://github.com/daquan088/daquan-durian-picker.git
cd daquan-durian-picker
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

在 `.dev.vars` 中填写自己的配置：

```dotenv
OPENAI_API_KEY=your-own-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
MODEL_ID=your-vision-model-id
QUOTA_SALT=generate-a-long-random-value
TASK_TOKEN_SECRET=generate-another-long-random-value
```

## 验证

```bash
npm run typecheck
npm test
npm run build
```

## 部署

### Cloudflare Workers

1. 修改 `wrangler.jsonc` 中的 Worker 名称。
2. 用 `wrangler secret put` 配置 `OPENAI_API_KEY`、`QUOTA_SALT` 和 `TASK_TOKEN_SECRET`。
3. 在服务端环境变量配置 `MODEL_ID`，按需配置 `OPENAI_BASE_URL`。
4. 执行 `npm run deploy`。

额度计数依赖 Durable Object + SQLite，请保留配置中的绑定和迁移。

### 腾讯 CloudBase

1. 创建自己的 CloudBase 环境和 PostgreSQL。
2. 执行 `cloudbase-event/schema.sql`。
3. 复制 `cloudbase-event/cloudbaserc.example.json`，填写自己的环境 ID。
4. 在云函数环境变量配置上述五项变量。
5. 执行 `npm run build:cloudbase`，再部署 `cloudbase-event`。

CloudBase 事件网关下，当前适配器会强压缩图片，并将第二阶段限制为一颗候选。详见 `docs/adr/0002-cloudbase-mobile-demo-deployment.md`。

## 隐私与安全

- 照片会发送给部署者选择的模型服务商，部署者必须明确告知用户。
- 默认不应长期保存照片和分析结果。
- 日志不得记录 Base64 图片、完整 IP、API Key 或任务密钥。
- 安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告。

## 参与贡献

欢迎提交 Issue 和 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。特别欢迎改进拥挤遮挡下的编号、真实开果评测、对象存储直传和微信兼容性。

## 许可证

代码采用 [Apache License 2.0](LICENSE) 开源。图片、品牌、微信二维码以及第三方模型或数据集可能受各自权利约束；二创时请替换为自己的品牌素材并遵守服务商条款。
