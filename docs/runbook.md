# 运维手册 — Apache DolphinScheduler on AWS

> 版本：1.0 | 日期：2026-06-29 | 部署步骤见 [deployment.md](deployment.md)

---

## 1. 日常运维

### 1.1 查看集群状态

```bash
# 所有 DS Pod 运行状态
kubectl get pods -n dolphinscheduler

# Worker 节点（Karpenter 管理）
kubectl get nodes -l karpenter.sh/initialized=true

# ExternalSecret 同步状态
kubectl get externalsecret -n dolphinscheduler
kubectl get externalsecret -n external-secrets
```

### 1.2 DS Web UI 访问

```bash
# 获取 ALB 地址
kubectl get ingress -n dolphinscheduler \
  -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}'
```

访问 `https://<ALB-hostname>`，默认账号 `admin` / `dolphinscheduler123`。

### 1.3 查看任务日志

```bash
# Worker Pod 实时日志
kubectl logs -n dolphinscheduler -l component=worker -f

# EMR Serverless 任务日志
aws emr-serverless get-job-run \
  --application-id <APP_ID> \
  --job-run-id <JOB_RUN_ID>

# S3 日志（install.sh 中 EMR 配置 logUri）
aws s3 ls s3://${S3_BUCKET}/logs/emr-serverless/
```

### 1.4 告警处理

| 告警 | 原因 | 处置 |
|------|------|------|
| `aurora-cpu-high` | DS 任务高并发 | 临时调大 MaxACU，检查慢查询 |
| `aurora-acu-high` | 接近 MaxACU 上限 | 调大 `maxCapacity`，`cdk deploy DsDataStack` |
| `trigger-lambda-errors` | DS API URL 或 Token 失效 | 检查 Secret 和 Lambda 环境变量 |
| `worker-queue-deep` | Worker 数量不足 | 手动扩容 `kubectl scale deploy/worker --replicas=5` |
| EMR Job FAILED | Spark 脚本错误或权限问题 | 查看 S3 logs/emr-serverless/ |

### 1.5 DS API Token 轮换

```bash
# 1. DS Web UI 生成新 Token
# 2. 写入 Secrets Manager（Lambda 下次调用时 TTL 过期后自动生效）
aws secretsmanager put-secret-value \
  --secret-id /ds-aws/ds-api-token \
  --secret-string '{"token":"<NEW_TOKEN>"}'

# 3. 强制 Lambda 加载新 Token（删除函数的 /tmp 缓存）
aws lambda update-function-configuration \
  --function-name ds-aws-trigger-dag \
  --environment "Variables={DS_API_URL=${DS_API_URL},SECRET_NAME=/ds-aws/ds-api-token,DS_PROJECT_CODE=1}"
```

### 1.6 补齐 Aurora 密码的 ESO 托管（已部署环境迁移）

2026-07 之前部署的环境，`externalDatabase.password` 是通过 `helm --set-string` 传入真实密码的，会明文留存在 Helm release history 里（`kubectl get secret -n dolphinscheduler -l owner=helm` 能看到）。install.sh 已改为只传占位符 `REPLACE_BY_ESO`，真实密码由 ESO 事后 patch 进 `dolphinscheduler-externaldb` 这个 Secret。**这个改动只对新装环境自动生效**，已有环境要手动迁移一次：

```bash
# 1. 应用 ESO patch（真实密码从 Secrets Manager 流入，不经过 Helm）
sed "s|key: \"\"|key: \"/ds-aws/aurora/password\"|g" \
  k8s/external-secrets/externaldb-secret-patch.yaml | kubectl apply -f -
kubectl wait externalsecret ds-externaldb-password-patch \
  -n dolphinscheduler --for=condition=Ready --timeout=120s

# 2. 重启 pod 让它们读到新密码（密码是启动时注入的环境变量，不会热更新）
kubectl rollout restart statefulset/dolphinscheduler-master statefulset/dolphinscheduler-worker \
  deployment/dolphinscheduler-api deployment/dolphinscheduler-alert -n dolphinscheduler
kubectl rollout status statefulset/dolphinscheduler-master -n dolphinscheduler --timeout=5m
kubectl rollout status statefulset/dolphinscheduler-worker -n dolphinscheduler --timeout=5m

# 3. 下一次跑 helm upgrade（用改造后的 install.sh 或手动 --set-string password="REPLACE_BY_ESO"）
#    之后，新的 release revision 里就不会再有真实密码了。但历史 revision 的 release
#    secret 依然留着旧的明文——如果要彻底清干净，需要单独清理：
kubectl get secret -n dolphinscheduler -l owner=helm,name=dolphinscheduler
# 确认只保留必要的最近版本后，删除更早的 revision secret（谨慎操作，删除后无法用
# `helm rollback` 回退到被删的版本）
```

### 1.7 EKS 版本升级

```bash
# 1. 修改 cdk.json eks.version
# 2. 升级控制面
cdk deploy DsEksStack -c s3BucketName=${S3_BUCKET}

# 3. 滚动升级节点（Karpenter 自动处理）
kubectl get nodeclaims  # 观察节点替换进度
```

---

## 2. 扩缩容

### 2.1 手动扩容 Worker

```bash
kubectl scale statefulset dolphinscheduler-worker \
  -n dolphinscheduler --replicas=5
```

### 2.2 调整 Karpenter NodePool 上限

```bash
# 编辑 k8s/karpenter-nodepool.yaml
# 修改 limits.cpu / limits.memory
kubectl apply -f k8s/karpenter-nodepool.yaml
```

### 2.3 Aurora 容量调整

```json
// cdk.json
"aurora": {
  "minCapacity": 1,
  "maxCapacity": 32
}
```

```bash
cdk deploy DsDataStack -c s3BucketName=${S3_BUCKET}
```

---

## 3. 备份与恢复

### 3.1 Aurora 自动备份

Aurora 默认开启自动备份，保留 7 天（CDK 配置 `backup.retention: 7 days`）。

```bash
# 查看备份快照
aws rds describe-db-cluster-snapshots \
  --db-cluster-identifier ds-aws-aurora \
  --query 'DBClusterSnapshots[*].[DBClusterSnapshotIdentifier,SnapshotCreateTime]'

# 恢复到指定时间点
aws rds restore-db-cluster-to-point-in-time \
  --source-db-cluster-identifier ds-aws-aurora \
  --db-cluster-identifier ds-aws-aurora-restored \
  --restore-to-time "2026-06-29T12:00:00Z"
```

### 3.2 DAG 版本回滚

```bash
# 回滚到上一个版本
git revert HEAD
git push origin main
# GitHub Actions 自动重新导入
```

### 3.3 Secrets 备份

```bash
# 导出所有 Secret 路径（不含值，仅结构）
aws secretsmanager list-secrets \
  --filter Key=name,Values=/ds-aws/ \
  --query 'SecretList[*].Name'
```

---

## 4. 卸载

```bash
# 1. 删除 Helm 应用
helm uninstall dolphinscheduler -n dolphinscheduler
helm uninstall external-secrets -n external-secrets
helm uninstall karpenter -n karpenter

# 2. 删除 CDK Stack（注意：Aurora 设置了 RETAIN，不会自动删除）
cdk destroy --all

# 3. 手动删除 Aurora 集群（谨慎操作）
aws rds delete-db-cluster \
  --db-cluster-identifier ds-aws-aurora \
  --skip-final-snapshot   # 生产环境请去掉此参数，先创建快照

# 4. 删除 S3 Bucket
aws s3 rm s3://${S3_BUCKET} --recursive
aws s3 rb s3://${S3_BUCKET}
```

---

## 5. 故障排查速查

```bash
# DS Master/Worker 重启（StatefulSet，不是 Deployment）
kubectl rollout restart statefulset/dolphinscheduler-master -n dolphinscheduler
kubectl rollout restart statefulset/dolphinscheduler-worker -n dolphinscheduler

# ESO 强制同步 Secret
kubectl annotate externalsecret ds-aurora-secret \
  -n dolphinscheduler \
  force-sync=$(date +%s) --overwrite

# Karpenter 节点驱逐
kubectl taint node <node-name> key=value:NoSchedule
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data

# Lambda 触发器测试
aws lambda invoke \
  --function-name ds-aws-trigger-dag \
  --payload '{"source":"aws.s3","detail":{"bucket":{"name":"your-bucket"},"object":{"key":"raw/tenant-a/test.csv"}}}' \
  /tmp/lambda-response.json && cat /tmp/lambda-response.json

# 查看 EventBridge 规则
aws events list-rules --name-prefix ds-aws
aws events list-targets-by-rule --rule ds-aws-s3-raw-upload
```
