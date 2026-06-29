# 测试手册 — Apache DolphinScheduler on AWS

> 版本：1.0 | 日期：2026-06-29

---

## 测试环境假设

- 部署已按 `docs/deployment.md` 完成
- `kubectl` 已配置指向目标集群
- `AWS_REGION` 和 `S3_BUCKET` 已设置
- DS Web UI 可访问，DS API Token 已写入 Secrets Manager

```bash
export AWS_REGION=us-east-1
export S3_BUCKET=your-ds-bucket
export DS_HOST=http://<ALB-hostname>   # HTTP only — no ACM cert on the ingress
export DS_TOKEN=<your-ds-api-token>
export PROJECT_CODE=<your-ds-project-code>   # a generated long, e.g. from
  # `curl -s -H "token: $DS_TOKEN" "$DS_HOST/dolphinscheduler/projects/list" | jq -r '.data[].code'`
```

> API paths below have no `/v1` prefix (DS 3.4.2 has no versioned API — `/v1/*`
> silently falls through to the SPA's index.html, HTTP 200, rather than 404ing)
> and use `workflow-definition`/`workflow-instances`, not the older
> `process-definition`/`process-instances` naming. Verified against a live
> 3.4.2 instance and its controller/frontend source.

---

## T1：基础设施验收

### T1.1 VPC Endpoints 连通性

```bash
# 在 EKS Worker 节点上测试（临时 debug pod）
kubectl run nettest --image=amazonlinux:2 --restart=Never \
  --command -- sleep 3600
kubectl exec -it nettest -- bash

# 测试 S3 Gateway Endpoint（应走私有路径，无 NAT）
curl -s https://s3.amazonaws.com/ | head -1

# 测试 Secrets Manager Interface Endpoint
curl -s https://secretsmanager.us-east-1.amazonaws.com/ | head -1

# 确认未走 NAT：查看 VPC Flow Logs，源 IP 应为私有 IP，目标 IP 为 Endpoint IP
kubectl delete pod nettest
```

期望结果：HTTP 2xx / 400，连接成功。

### T1.2 Aurora 连通性

```bash
AURORA_EP=$(aws cloudformation describe-stacks \
  --stack-name DsDataStack --region ${AWS_REGION} \
  --query "Stacks[0].Outputs[?ExportName=='ds-aws-aurora-endpoint'].OutputValue" \
  --output text)

# 通过 DS Pod 验证
kubectl exec -n dolphinscheduler \
  $(kubectl get pod -n dolphinscheduler -l app.kubernetes.io/component=master -o name | head -1) \
  -- pg_isready -h ${AURORA_EP} -p 5432

# 期望：accepting connections
```

### T1.3 ESO Secret 同步

```bash
kubectl get externalsecret -n dolphinscheduler
# 期望：READY=True，SYNCED

kubectl get secret ds-aurora-secret -n dolphinscheduler -o jsonpath='{.data.password}' | base64 -d
# 期望：返回非空密码字符串
```

### T1.4 Karpenter 节点自动扩容

```bash
# 创建高资源需求 Pod，触发节点扩容
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: karpenter-test
spec:
  containers:
  - name: stress
    image: amazonlinux:2
    resources:
      requests:
        cpu: "3"
        memory: "6Gi"
    command: ["sleep", "120"]
EOF

# 观察新节点被 Karpenter 调度
kubectl get nodes -w &
kubectl get pod karpenter-test -w

# 清理
kubectl delete pod karpenter-test
```

期望：约 60–90 秒内新节点 Ready，Pod Running。

---

## T2：凭证管理验证

### T2.1 IRSA 权限验证（租户隔离）

```bash
# 验证 tenant-a worker 可以访问 tenant-a S3 前缀
kubectl run irsa-test --image=amazon/aws-cli:latest \
  --restart=Never \
  --serviceaccount=tenant-a-worker \
  --namespace=dolphinscheduler \
  --command -- aws s3 ls s3://${S3_BUCKET}/raw/tenant-a/

# 验证 tenant-a worker 无法访问 tenant-b S3 前缀（应报 AccessDenied）
kubectl run irsa-test2 --image=amazon/aws-cli:latest \
  --restart=Never \
  --serviceaccount=tenant-a-worker \
  --namespace=dolphinscheduler \
  --command -- aws s3 ls s3://${S3_BUCKET}/raw/tenant-b/

kubectl logs irsa-test2 | grep -i "access denied"
# 期望：Access Denied

kubectl delete pod irsa-test irsa-test2 -n dolphinscheduler
```

### T2.2 Secrets Manager 无明文凭证

```bash
# 验证 Helm release 里 externalDatabase.password 是占位符，不是真实密码
helm get values dolphinscheduler -n dolphinscheduler | grep -A1 externalDatabase
# 期望：password: REPLACE_BY_ESO

# 验证 Chart 生成的 Secret 已被 ESO patch 成真实密码（应与占位符不同）
kubectl get secret dolphinscheduler-externaldb -n dolphinscheduler \
  -o jsonpath='{.data.database-password}' | base64 -d

# 验证 ConfigMap 不含 AK/SK
kubectl get configmap -n dolphinscheduler -o yaml | grep -i "accessKey\|secretKey"
# 期望：无输出
```

**实测发现**：chart 3.4.2 的 `externalDatabase` 没有 `existingSecret` 钩子，`helm --set` 传的任何值都会被 Helm 自己存进 release history 明文留存。修复方案（占位符安装 + `k8s/external-secrets/externaldb-secret-patch.yaml` 用 ESO 的 `creationPolicy: Merge` 事后 patch 真密码 + 重启 pod）已经写好，但**没有应用到当前正跑的环境**，避免打断已跑通的 T4/T5 状态。迁移步骤见 [runbook.md §1.6](runbook.md)，还需要专门跑一次全流程验证（占位符安装 → ESO patch → 重启 → DS 恢复连接）。

---

## T3：事件驱动触发测试

### T3.1 S3 上传触发 DAG

```bash
# 上传测试文件
aws s3 cp /dev/urandom s3://${S3_BUCKET}/raw/tenant-a/test-$(date +%s).csv \
  --expected-size 1000

# 等待约 30 秒后检查 Lambda 调用
aws logs tail /aws/lambda/ds-aws-trigger-dag --follow --since 1m

# 期望日志：
# Triggering DAG 'tenant-a-etl-pipeline' with params {...}
# DS API response: {...}

# 在 DS Web UI 验证 DAG Run 已创建
curl -s -H "token: ${DS_TOKEN}" \
  "${DS_HOST}/dolphinscheduler/projects/${PROJECT_CODE}/workflow-instances?pageNo=1&pageSize=5" \
  | jq '.data.totalList[0] | {name: .processDefinitionName, state: .state}'
```

期望：返回 `"state": "RUNNING"` 或 `"SUCCESS"`

### T3.2 DMS 事件触发测试

```bash
# 注意：aws events put-events 不能用来模拟 aws.dms 这类保留前缀的 Source ——
# AWS 会拒绝外部调用方伪造 "aws.*" source（NotAuthorizedForSourceException），
# 这是 AWS 平台本身的限制，不是本项目的问题。用直接 invoke Lambda 代替。
aws lambda invoke --function-name ds-aws-trigger-dag \
  --cli-binary-format raw-in-base64-out \
  --payload '{"source":"aws.dms","detail":{"replicationTaskStatus":"stopped","replicationTaskIdentifier":"tenant-a-migration-task"}}' \
  /tmp/lambda-dms.json
cat /tmp/lambda-dms.json

# 检查 Lambda 日志
aws logs tail /aws/lambda/ds-aws-trigger-dag --since 30s

# 期望：Triggering DAG 'tenant-a-post-dms-pipeline'
# （租户从 replicationTaskIdentifier 中按 TENANTS 环境变量列表做前缀匹配解析,
#   不是简单按第一个 "-" 切分——"tenant-a-migration-task".split("-")[0] 会
#   错误地切成 "tenant" 而不是 "tenant-a"，此 bug 已在 handler.py 修复）
```

### T3.3 DataSync 事件触发测试

```bash
# 模拟真实事件形状：detail 只有 State，ARN 在顶层 resources 数组里
# （不要在 Detail 里塞 TaskArn/TaskExecutionArn——真实事件没有这两个字段，
# 这样塞只会让测试在有 bug 的代码上也"看起来"通过，见下方实测发现）
TASK_ARN=$(aws datasync list-tasks \
  --query 'Tasks[0].TaskArn' --output text 2>/dev/null || echo "arn:aws:datasync:us-east-1:123456789012:task/task-test")

aws events put-events --entries "[
  {
    \"Source\": \"aws.datasync\",
    \"DetailType\": \"DataSync Task Execution State Change\",
    \"Detail\": \"{\\\"State\\\":\\\"SUCCESS\\\"}\",
    \"Resources\": [\"${TASK_ARN}/execution/exec-test\"],
    \"EventBusName\": \"default\"
  }
]"

# 期望：Lambda 从 resources[0] 取 execution ARN，切出 task ARN，
# list_tags_for_resource 解析 Tenant tag，触发对应 DAG
aws logs tail /aws/lambda/ds-aws-trigger-dag --since 30s
```

**实测发现**：真实建了一个 S3→S3 DataSync task（打 `Tenant=tenant-a` 标签）跑通真实 task execution，挖出两个 bug：① Lambda 执行角色缺 `datasync:ListTagsForResource` 权限；② 更严重的是，`DataSync Task Execution State Change` 事件的 `detail` 字段里只有一个 `State`，压根没有 `TaskArn`/`TaskExecutionArn`——这两个 ARN 在事件顶层的 `resources` 数组里（`resources[0]` 是 execution ARN，去掉 `/execution/exec-...` 后缀是 task ARN）。老代码读 `event["detail"].get("TaskArn", "")` 永远是空字符串，这条触发路径从上线起就没真正解析出过租户，一直悄悄兜底成 `"default"`。两个问题都已修复并用真实 task execution 重新验证过。之前这里的合成事件把 `TaskArn` 塞进 `Detail` 里，形状本身就是错的，测出来的是假阳性——已经改成上面这个和真实事件一致的形状。

### T3.4 Lambda 直接调用测试

```bash
# 完整 S3 事件载荷测试
aws lambda invoke \
  --function-name ds-aws-trigger-dag \
  --payload '{
    "source": "aws.s3",
    "detail": {
      "bucket": {"name": "'${S3_BUCKET}'"},
      "object": {"key": "raw/tenant-a/sample.csv"}
    }
  }' \
  /tmp/lambda-out.json

cat /tmp/lambda-out.json
# 期望：{"statusCode": 200, "body": "..."}

# 无效 key 格式测试
aws lambda invoke \
  --function-name ds-aws-trigger-dag \
  --payload '{
    "source": "aws.s3",
    "detail": {
      "bucket": {"name": "'${S3_BUCKET}'"},
      "object": {"key": "raw/"}
    }
  }' \
  /tmp/lambda-out2.json

cat /tmp/lambda-out2.json
# 期望：{"statusCode": 200, "body": "skipped"}
```

---

## T4：端到端 ETL Pipeline 测试

### T4.1 准备测试数据

```bash
# 生成 CSV 测试数据（100 行）
python3 -c "
import csv, random, datetime, io

rows = []
for i in range(100):
    rows.append({
        'event_id': f'evt-{i:05d}',
        'tenant': 'tenant-a',
        'amount': round(random.uniform(10, 1000), 2),
        'created_at': datetime.datetime.now().isoformat(),
        'status': random.choice(['A', 'B', 'C'])
    })

buf = io.StringIO()
w = csv.DictWriter(buf, fieldnames=rows[0].keys())
w.writeheader()
w.writerows(rows)
print(buf.getvalue())
" > /tmp/test-data.csv

aws s3 cp /tmp/test-data.csv s3://${S3_BUCKET}/raw/tenant-a/test-$(date +%s).csv
```

### T4.2 监控 Pipeline 执行

DS Web UI → Project: 1 → Process Instance → 观察各节点状态

```bash
# 轮询直到 Pipeline 完成（最长 30 分钟）
while true; do
  STATE=$(curl -s -H "token: ${DS_TOKEN}" \
    "${DS_HOST}/dolphinscheduler/projects/${PROJECT_CODE}/workflow-instances?pageNo=1&pageSize=1" \
    | jq -r '.data.totalList[0].state')
  echo "[$(date +%H:%M:%S)] Pipeline state: ${STATE}"
  [[ "${STATE}" == "SUCCESS" || "${STATE}" == "FAILURE" ]] && break
  sleep 30
done
```

### T4.3 验收检查

```bash
# 检查 T1: ETL 输出文件存在
aws s3 ls s3://${S3_BUCKET}/processed/tenant-a/ --recursive | head -5
# 期望：Parquet 文件存在

# 检查 T2: 数据质量报告存在
aws s3 ls s3://${S3_BUCKET}/dq-reports/tenant-a/ --recursive | head -5
# 期望：DQ 报告 JSON 存在

# 检查 T3: Redshift 数据已入库（使用 Redshift Data API）
CLUSTER_ID=$(aws redshift describe-clusters \
  --query 'Clusters[0].ClusterIdentifier' --output text)

STMT_ID=$(aws redshift-data execute-statement \
  --cluster-identifier ${CLUSTER_ID} \
  --database analytics \
  --db-user dsadmin \
  --sql "SELECT COUNT(*) FROM tenant_a_events WHERE DATE(created_at) = CURRENT_DATE" \
  --query 'Id' --output text)

sleep 5
aws redshift-data get-statement-result --id ${STMT_ID} \
  --query 'Records[0][0].longValue'
# 期望：>= 100（测试数据行数）

# 检查 T4: Glue Catalog 已更新
aws glue get-tables --database-name tenant_a_db \
  --query 'TableList[*].Name'
# 期望：包含 tenant_a_events 或对应表名
```

### T4.4 实测发现与修复

全链路跑通耗时约 8 分钟。实测过程中发现并修复了 5 个真实 bug（都是从真实报错日志定位的，不是代码审查发现的）：

1. `hasNoDuplicateValues()` 在这版 pydeequ（配 deequ 2.0.7）里不存在，`AttributeError` 直接崩溃 → 改用 `isUnique()`
2. `isContainedIn()` 的 hint 参数按位置传，被 pydeequ 当成断言函数调用，`TypeError` → 改成关键字参数
3. pydeequ 的 py4j 回调线程导致 `sys.exit()` 退不出进程，EMR Serverless job 卡在 RUNNING 不报错也不超时 → 改用 `os._exit()`
4. `redshift-copy`/`validate-row-count` 的 SQL 任务 `type` 字段传反，而且 DS 没装 Redshift JDBC 驱动 → 改成 PYTHON+boto3 调 Redshift Data API（IAM 认证不存密码），细节见 [architecture.md §9](architecture.md)
5. **最难定位的一个**：Redshift 安全组没有任何出站规则，集群又开了 Enhanced VPC Routing，导致 COPY 经 VPC 访问 S3/STS 无路可走，无限期卡在 `STARTED`，不报错不超时——排查了锁等待、IAM 权限、py4j 线程等好几种假设才定位到，细节见 [architecture.md §5](architecture.md)

另外 Redshift 集群本身是 paused 状态，也需要先 resume。

---

## T5：数据质量门禁测试

### T5.1 注入脏数据，验证 Pipeline 被阻断

```bash
# 生成含脏数据的 CSV（amount < 0, status 不合规）
python3 -c "
import csv, io
rows = [
  {'event_id': 'bad-001', 'tenant': 'tenant-a', 'amount': -100, 'created_at': '2026-06-29T00:00:00', 'status': 'Z'},
  {'event_id': '', 'tenant': 'tenant-a', 'amount': 0, 'created_at': '', 'status': 'A'},
]
buf = io.StringIO()
w = csv.DictWriter(buf, fieldnames=rows[0].keys())
w.writeheader()
w.writerows(rows)
print(buf.getvalue())
" > /tmp/bad-data.csv

# 上传脏数据，触发 Pipeline
aws s3 cp /tmp/bad-data.csv s3://${S3_BUCKET}/raw/tenant-a/bad-$(date +%s).csv

# 等待约 10 分钟
sleep 600

# 验证 Pipeline 在 task-300 (deequ-quality-check) 失败
curl -s -H "token: ${DS_TOKEN}" \
  "${DS_HOST}/dolphinscheduler/projects/${PROJECT_CODE}/workflow-instances?pageNo=1&pageSize=1" \
  | jq '.data.totalList[0] | {state: .state}'
# 期望：{"state": "FAILURE"}

# 验证 Redshift 未入库（行数与之前相同）
STMT_ID=$(aws redshift-data execute-statement \
  --cluster-identifier ${CLUSTER_ID} \
  --database analytics \
  --db-user dsadmin \
  --sql "SELECT COUNT(*) FROM tenant_a_events" \
  --query 'Id' --output text)
sleep 5
aws redshift-data get-statement-result --id ${STMT_ID} \
  --query 'Records[0][0].longValue'
# 期望：行数与 T4 相同，脏数据未入库
```

**实测发现**：注入的两条脏数据（负数金额、空字段）在 `etl.py` 自身的清洗逻辑（`amount > 0` 过滤）里就被全部滤除，输出数据集为空，Deequ 读空 parquet 时 `AnalysisException: UNABLE_TO_INFER_SCHEMA` 崩溃退出——不是原设计预期的"检查项优雅失败"，但效果一致：pipeline 在 `deequ-quality-check` 被拦停，`redshift-copy` 未执行，Redshift 行数全程未受污染。测试时记得先清空 `raw/` 目录里的历史好数据，否则会被稀释测不出效果。

---

## T6：DAG GitOps 测试

### T6.1 修改 DAG 并通过 PR 同步

```bash
# 添加一个 echo 任务到 etl-pipeline.json（模拟变更）
cp dags/tenant-a/etl-pipeline.json dags/tenant-a/etl-pipeline.json.bak

# 修改 processDefinition.version 从 2 → 3（触发更新）
jq '.[] |= .processDefinition.version = 3' dags/tenant-a/etl-pipeline.json \
  > /tmp/etl-v3.json && mv /tmp/etl-v3.json dags/tenant-a/etl-pipeline.json

git add dags/tenant-a/etl-pipeline.json
git commit -m "test: bump DAG version to 3"
git push origin main

# 等待 GitHub Actions 完成
# 在 DS Web UI 验证版本已更新
curl -s -H "token: ${DS_TOKEN}" \
  "${DS_HOST}/dolphinscheduler/projects/${PROJECT_CODE}/workflow-definition?pageNo=1&pageSize=10" \
  | jq '.data.totalList[] | select(.name=="tenant-a-etl-pipeline") | .version'
# 期望：3

# 恢复
cp dags/tenant-a/etl-pipeline.json.bak dags/tenant-a/etl-pipeline.json
```

### T6.2 验证注入防护

```bash
# GitHub Actions 中 CHANGED_FILES 来自 git diff，文件名由仓库控制
# 验证 env: CHANGED_FILES 不会被 shell 注入
# 检查 workflow 配置是否正确
grep -A5 "CHANGED_FILES" .github/workflows/sync-dags.yml
# 期望：
#   env:
#     CHANGED_FILES: ${{ steps.changed.outputs.files }}
#   run: |
#     for FILE in $CHANGED_FILES; do
```

---

## T7：告警通知测试

### T7.1 触发 CloudWatch Alarm（模拟）

```bash
# 手动设置 Lambda 错误 Alarm 为 ALARM 状态（测试 SNS 通知）
aws cloudwatch set-alarm-state \
  --alarm-name ds-aws-trigger-lambda-errors \
  --state-value ALARM \
  --state-reason "手动测试告警通知"

# 等待约 60 秒
# 验证告警 Lambda 被触发
aws logs tail /aws/lambda/ds-aws-notify --since 2m | head -20

# 验证钉钉/WeCom 收到消息（查看对应群组）

# 恢复 Alarm 状态
aws cloudwatch set-alarm-state \
  --alarm-name ds-aws-trigger-lambda-errors \
  --state-value OK \
  --state-reason "测试完成，手动恢复"
```

### T7.2 EMR Job 失败告警

```bash
# 注意：aws events put-events 无法伪造 "aws.*" 保留前缀的 Source（会被
# NotAuthorizedForSourceException 拒绝，AWS 平台限制，T3.2 也遇到过），
# 这条规则没法用合成事件直接触发验证，只能：
#  1. 静态核实规则配置
aws events describe-rule --name ds-aws-emr-job-failure
aws events list-targets-by-rule --rule ds-aws-emr-job-failure
# 期望：State=ENABLED，Target 指向 ds-aws-alerts SNS topic

#  2. 用 T7.1 已验证过的 alarm→SNS→notify Lambda 链路作为下游佐证
#     （EventBridge Rule→SNS 是 CDK targets.SnsTopic 自动授权的标准路径，
#     不像 CloudWatch Alarm→SNS 那样需要手动 grantPublish 才能用）
#  3. 真要触发，只能让 T4 端到端 pipeline 里的 EMR Serverless 任务真的失败一次

# 后来真做了第 3 种：故意提交一个指向不存在脚本的 EMR Serverless job
aws emr-serverless start-job-run \
  --application-id ${EMR_APP_ID} \
  --execution-role-arn ${EMR_JOB_ROLE_ARN} \
  --job-driver '{"sparkSubmit":{"entryPoint":"s3://'${S3_BUCKET}'/scripts/nonexistent.py","entryPointArguments":[],"sparkSubmitParameters":"--conf spark.executor.cores=4 --conf spark.executor.memory=8g"}}'
# 等它 FAILED 后查 notify Lambda 日志
aws logs tail /aws/lambda/ds-aws-notify --since 3m
```

**实测发现**：EMR job 真实失败后，EventBridge → SNS → notify Lambda 全链路确实被触发了，但 Lambda 的 `_parse_alarm()` 原来只认 CloudWatch Alarm 消息格式（`AlarmName`/`NewStateValue`），收到 EventBridge 直发的 EMR 事件（`detail-type`/`source`/`detail` 结构）时所有字段落空，退化成一条没有任何有效信息的 "Unknown Alarm (UNKNOWN)"。修复后能正确显示 `EMR Serverless Job Run State Change (FAILED)`。最后一跳 webhook 投递因为 `/ds-aws/notify-webhook` 还是部署时占位符 `REPLACE_WITH_WEBHOOK_URL` 而失败——这是环境没配真实钉钉/企微地址，不是代码问题。

---

## T8：高可用与故障恢复测试

### T8.1 Worker Pod 重启恢复

```bash
# 在 DAG 运行期间（T4 执行时），强制删除一个 Worker Pod
kubectl delete pod \
  $(kubectl get pod -n dolphinscheduler -l app.kubernetes.io/component=worker -o name | head -1 | cut -d/ -f2) \
  -n dolphinscheduler

# 观察 EKS 自动重启
kubectl get pod -n dolphinscheduler -l app.kubernetes.io/component=worker -w

# 期望：新 Pod Running（实测约 90s——DS worker 是 JVM 进程，冷启动本身要
#   15-20s，加上镜像/调度/readiness probe 间隔，60s 偏乐观），
#   进行中的任务通过 DS 重试机制续跑
```

### T8.2 DS Master 高可用

```bash
# 删除一个 Master Pod
kubectl delete pod \
  $(kubectl get pod -n dolphinscheduler -l app.kubernetes.io/component=master -o name | head -1 | cut -d/ -f2) \
  -n dolphinscheduler

# 验证调度未中断（第二个 Master 接管）
kubectl get pod -n dolphinscheduler -l app.kubernetes.io/component=master -w
# 期望：新 Master Pod 约 30s 后 Running
```

> 实测：这不是无缝故障转移。DS API 的 start-workflow-instance 会把请求路由到
> 一个具体的 master（`Host(ip=dolphinscheduler-master-X.dolphinscheduler-
> master-headless, ...)`），如果那个 master 恰好在重启，请求直接报错
> `Call method to Host(...) failed`，不会自动改路由到另一个存活的 master。
> 等被删的 master 重新 Ready 后，调度才恢复正常——被中断的是"新提交的调度
> 请求"，不是"整个 DS 系统"（zookeeper/DB 一直可用，另一个 master 也一直
> 在跑）。这是 DS 本身的行为，不是本项目引入的 bug。

---

## T9：性能基准测试

### T9.1 Lambda 触发延迟

```bash
# 测量 S3 上传到 Lambda 触发的延迟
START=$(date +%s%3N)
aws s3 cp /tmp/test-data.csv s3://${S3_BUCKET}/raw/tenant-a/perf-$(date +%s).csv

# 监控 Lambda 调用时间戳
aws logs tail /aws/lambda/ds-aws-trigger-dag --since 10s | grep "START\|Triggering"

# 手动记录时间差
# 期望：S3 上传到 Lambda 触发 < 30 秒（EventBridge 延迟 < 5s + Lambda 冷启动 < 10s）
```

### T9.2 并发 DAG 触发

```bash
# 同时上传 5 个文件，测试并发触发
for i in {1..5}; do
  aws s3 cp /tmp/test-data.csv s3://${S3_BUCKET}/raw/tenant-a/concurrent-${i}-$(date +%s).csv &
done
wait

# 检查 Lambda 并发调用次数
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name ConcurrentExecutions \
  --dimensions Name=FunctionName,Value=ds-aws-trigger-dag \
  --start-time $(date -u -d '5 minutes ago' '+%Y-%m-%dT%H:%M:%SZ') \
  --end-time $(date -u '+%Y-%m-%dT%H:%M:%SZ') \
  --period 60 \
  --statistics Maximum
```

---

## 测试检查清单

| 测试项 | 结果 | 备注 |
|--------|------|------|
| T1.1 VPC Endpoint 连通 | ✅ | S3/SecretsManager/ECR 均连通，DNS 解析到私有 IP |
| T1.2 Aurora 连通 | ✅ (间接) | master/worker 连接正常，health endpoint db:UP |
| T1.3 ESO 同步成功 | ✅ | ds-aurora-secret 同步正常 |
| T1.4 Karpenter 扩容 | ✅ | 新节点 39s 内 Ready（文档预期 60-90s） |
| T2.1 IRSA 租户隔离 | ✅（修复后） | 详见 T2.1 小节 |
| T2.2 无明文凭证 | 🟡 方案已写，未在当前环境实测 | 详见 T2.2 小节 |
| T3.1 S3 触发 DAG | ✅ | 完整真实链路验证（上传→EventBridge→Lambda→DS API） |
| T3.2 DMS 触发 DAG | ✅（修复后） | 详见 T3.2 小节 |
| T3.3 DataSync 触发 DAG | ✅（修复后） | 详见 T3.3 小节 |
| T3.4 Lambda 边界测试 | ✅ | 正常事件 + 无效 key 格式均符合预期 |
| T4 端到端 ETL 成功 | ✅（修复后） | 全链路跑通，~8 分钟，详见 T4.4 小节 |
| T5 脏数据被阻断 | ✅ | 详见 T5.1 小节 |
| T6.1 DAG GitOps 同步 | ⏭️ 跳过 | 需要真实 push GitHub，用户选择跳过 |
| T6.2 注入防护验证 | ✅ | CHANGED_FILES 走 env: 隔离，无注入风险 |
| T7.1 CloudWatch 告警通知 | ✅（修复后） | 详见 T7.1 小节 |
| T7.2 EMR 失败告警 | ✅（真实触发，修复后） | 详见 T7.2 小节 |
| T8.1 Worker Pod 故障恢复 | ✅ | 91s 恢复（文档预期 60s 偏乐观，已更新） |
| T8.2 Master 高可用 | ⚠️ 有条件 | 非无缝切换：故障 master 重启期间，路由到它的新请求会直接报错，而非自动转移到另一 master |
| T9.1 Lambda 触发延迟 | ✅ | 实测约 2.4s（文档预期 <30s） |
| T9.2 并发 DAG 触发 | ✅ | 5 个并发上传全部正确触发独立 workflow instance |
