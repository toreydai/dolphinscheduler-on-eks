# Apache DolphinScheduler on AWS

企业级数据任务调度平台，将 Apache DolphinScheduler 部署在 Amazon EKS 上，
深度集成 EMR Serverless、Redshift、DMS、DataSync、Athena 等 AWS 数据服务，
通过 EventBridge 实现事件驱动触发，并以 CDK (TypeScript) 管理全部基础设施。

---

## 架构概览

```
S3 PutObject / DMS Complete / DataSync Success
    │
    ▼ EventBridge → Lambda → DS REST API
    │
Amazon EKS (DolphinScheduler Master × 2 + Worker × 3 + Karpenter)
    │ 无 AK/SK，走节点 IAM Role（IRSA per-Tenant 隔离的已知落差见架构文档 §10）
    ├── EMR Serverless   → Spark ETL + PyDeequ 质量检测
    ├── Amazon Redshift  → 数仓写入（IAM auth）
    ├── Amazon Athena    → 即席查询（WorkGroup 隔离）
    ├── Amazon DMS       → 异构数据库迁移
    └── Amazon DataSync  → 文件传输
    │
Aurora Serverless v2 (元数据) + EFS (插件) + Secrets Manager (凭证)
```

相比[原版博客](https://aws.amazon.com/cn/blogs/china/data-task-scheduling-using-apache-dolphinscheduler-on-aws/)的核心改进见 [架构文档 §2](docs/architecture.md)，摘要：事件驱动触发、EMR Serverless（~47% 降本）、DAG GitOps、PyDeequ 质量门禁、资源级多租户隔离（S3/Athena/Redshift/Glue，IAM API 权限层面仍是节点共享，见架构文档 §10）、CDK TypeScript IaC。

---

## 快速开始

### 前提条件

```bash
node --version    # >= 18.x
cdk --version     # >= 2.140.0
helm version      # >= 3.12
kubectl version   # >= 1.28
aws --version     # >= 2.15
```

### 1. 创建 S3 Bucket 并开启 EventBridge 通知

```bash
export S3_BUCKET=your-ds-bucket-$(aws sts get-caller-identity --query Account --output text)
export AWS_REGION=us-east-1

aws s3 mb s3://${S3_BUCKET} --region ${AWS_REGION}
aws s3api put-bucket-notification-configuration \
  --bucket ${S3_BUCKET} \
  --notification-configuration '{"EventBridgeConfiguration": {}}'
```

### 2. 一键部署（约 45–60 分钟）

```bash
git clone <repo-url>
cd dolphinscheduler-on-eks
./install.sh ${S3_BUCKET} ${AWS_REGION}
```

### 3. 写入 DS API Token（部署完成后）

```bash
# 在 DS Web UI 生成 Token（右上角 → Security → Token Management）
aws secretsmanager put-secret-value \
  --secret-id /ds-aws/ds-api-token \
  --secret-string '{"token":"<YOUR_TOKEN>"}'
```

### 4. 配置告警 Webhook

```bash
aws secretsmanager put-secret-value \
  --secret-id /ds-aws/notify-webhook \
  --secret-string '{"type":"dingtalk","url":"<WEBHOOK_URL>"}'
```

### 5. 上传测试数据，验证端到端 Pipeline

```bash
# 上传 CSV → 自动触发 DAG → EMR ETL → 质检 → Redshift 入库
aws s3 cp /path/to/data.csv s3://${S3_BUCKET}/raw/tenant-a/

# 在 DS Web UI 观察 DAG Run（Process Instances）
```

---

## 文档

| 文档 | 说明 |
|------|------|
| [架构文档](docs/architecture.md) | 整体架构、CDK Stack 结构、网络、凭证、多租户设计 |
| [部署手册](docs/deployment.md) | 环境准备、一键部署、配置说明、新增租户 |
| [运维手册](docs/runbook.md) | 日常运维、扩缩容、备份恢复、卸载、故障排查 |
| [测试手册](docs/testing.md) | 基础设施验收、事件触发、端到端 ETL、质量门禁、高可用 |

---

## 新增租户

1. 在 `cdk.json` 的 `tenants` 数组添加新租户名
2. `cdk deploy DsAppStack -c s3BucketName=${S3_BUCKET}`（自动创建 EMR App / Athena WG / IRSA Role / ConfigMap）
3. 在 DS Web UI 创建对应 Tenant 和 Project
4. 在 `dags/<new-tenant>/` 添加 DAG JSON，Push 后 GitHub Actions 自动同步

详见 [deployment.md §4](docs/deployment.md)。

---

## CDK Stack 部署命令

```bash
# 部署全部 Stack
cdk deploy --all -c s3BucketName=${S3_BUCKET}

# 单独部署某个 Stack
cdk deploy DsNetworkingStack -c s3BucketName=${S3_BUCKET}
cdk deploy DsDataStack       -c s3BucketName=${S3_BUCKET}
cdk deploy DsEksStack        -c s3BucketName=${S3_BUCKET}
cdk deploy DsAppStack        -c s3BucketName=${S3_BUCKET}

# 查看变更计划
cdk diff --all -c s3BucketName=${S3_BUCKET}
```

---

## 注意事项

- Aurora 数据库设置了 `removalPolicy: RETAIN`，`cdk destroy` **不会**删除数据库，需手动清理
- DS API Token 建议定期轮换（建议 90 天），轮换后 Lambda Token 缓存 1 小时内自动失效
- Redshift `dc2.large` 为单节点，生产环境建议升级为 `ra3.xlplus` 多节点
- 默认仅部署 1 个 NAT Gateway（降低成本），生产双 AZ 高可用可改为 2 个

---

## License

MIT - see the [LICENSE](LICENSE) file for details.

## 免责声明

- 本项目仅供学习与技术参考，不构成生产部署方案。
- 运行过程中会创建 AWS 资源并产生费用，请在实验结束后及时清理（Aurora 设置了 `RETAIN`，`cdk destroy` 不会自动删除，需手动清理，见上文「注意事项」）。
- 作者不对因使用本项目产生的任何费用或损失承担责任。
- 本项目与 Amazon Web Services 及 Apache DolphinScheduler 项目无官方关联，相关服务的可用性与定价以官方文档为准。
