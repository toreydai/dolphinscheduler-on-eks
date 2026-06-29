# 部署手册 — Apache DolphinScheduler on AWS

> 版本：1.0 | 日期：2026-06-29

---

## 1. 环境准备

### 1.1 本地依赖

```bash
# 检查版本
node --version        # >= 18.x
npm --version         # >= 9.x
cdk --version         # >= 2.140.0
helm version          # >= 3.12
kubectl version       # >= 1.28
aws --version         # >= 2.15
jq --version          # 任意

# 安装 CDK（如未安装）
npm install -g aws-cdk
```

### 1.2 AWS 权限

执行部署的 IAM 用户/角色需要以下权限（最小集）：

```
AdministratorAccess  （推荐，CDK Bootstrap 及 EKS 创建需要较高权限）
```

或精确策略：`AmazonEKSFullAccess` + `AmazonEC2FullAccess` + `AmazonS3FullAccess` + `IAMFullAccess` + `CloudFormationFullAccess` + `AmazonRDSFullAccess` + `AmazonRedshiftFullAccess` + `AmazonEMRFullAccess`

### 1.3 S3 Bucket 预创建

```bash
# 部署前手动创建（CDK 引用已有 Bucket，不自动创建）
export AWS_REGION=us-east-1
export S3_BUCKET=your-ds-bucket-$(aws sts get-caller-identity --query Account --output text)

aws s3 mb s3://${S3_BUCKET} --region ${AWS_REGION}

# 启用版本控制（推荐）
aws s3api put-bucket-versioning \
  --bucket ${S3_BUCKET} \
  --versioning-configuration Status=Enabled

# 开启 S3 Event Notifications（EventBridge 模式）
aws s3api put-bucket-notification-configuration \
  --bucket ${S3_BUCKET} \
  --notification-configuration '{"EventBridgeConfiguration": {}}'
```

---

## 2. 一键部署

```bash
git clone <repo-url>
cd dolphinscheduler-on-eks

# 执行一键部署（约 45–60 分钟）
./install.sh ${S3_BUCKET} ${AWS_REGION}
```

### 部署阶段说明

| Phase | 内容 | 耗时 |
|-------|------|------|
| Phase 1 | CDK deploy 4 个 Stack（VPC/EKS/Aurora/Redshift/EMR...） | 25–35 min |
| Phase 2 | aws eks update-kubeconfig，创建 namespace | 1 min |
| Phase 3 | 安装 ESO，配置 ClusterSecretStore，同步 Secrets | 3–5 min |
| Phase 4 | 安装 Karpenter，部署 NodePool | 3–5 min |
| Phase 5 | 安装 DolphinScheduler（占位符密码 → ESO patch 真实密码 → 重启 pod），等待 ALB | 10–15 min |
| Phase 6 | 导入初始 DAG（需先写入 DS Token） | 1 min |

### 手动写入 DS API Token（Phase 5 完成后执行）

```bash
# 1. 打开 DS Web UI（install.sh 输出的 ALB 地址）
#    admin / dolphinscheduler123  (首次登录后立即改密码)

# 2. 右上角 → Security → Token Management → Create Token
#    有效期建议 365 天

# 3. 写入 Secrets Manager
aws secretsmanager put-secret-value \
  --secret-id /ds-aws/ds-api-token \
  --secret-string '{"token":"<YOUR_DS_TOKEN>"}' \
  --region ${AWS_REGION}

# 4. 手动重触发 Phase 6（创建/发布 DAG）
#    DS 3.4.2 已无文件导入端点（无 /v1 前缀，无 process-definition/import），
#    见 install.sh import_dags() 的完整实现——这里只是示意单个文件怎么调:
DS_URL="http://${DS_LB_HOST}"
DS_TOKEN="<YOUR_DS_TOKEN>"
PROJECT_CODE=$(curl -s -H "token: ${DS_TOKEN}" "${DS_URL}/dolphinscheduler/projects/list" \
  | jq -r '.data[] | select(.name=="default") | .code')
DAG="dags/tenant-a/etl-pipeline.json"
NAME=$(jq -r '.[0].processDefinition.name' "$DAG")
WF_CODE=$(curl -s -H "token: ${DS_TOKEN}" -X POST \
  "${DS_URL}/dolphinscheduler/projects/${PROJECT_CODE}/workflow-definition" \
  --data-urlencode "name=${NAME}" \
  --data-urlencode "description=$(jq -r '.[0].processDefinition.description' "$DAG")" \
  --data-urlencode "timeout=$(jq -r '.[0].processDefinition.timeout' "$DAG")" \
  --data-urlencode "executionType=$(jq -r '.[0].processDefinition.executionType' "$DAG")" \
  --data-urlencode "taskDefinitionJson=$(jq -c '.[0].taskDefinitionList' "$DAG")" \
  --data-urlencode "taskRelationJson=$(jq -c '.[0].processTaskRelationList' "$DAG")" \
  | jq -r '.data.code')
curl -s -H "token: ${DS_TOKEN}" -X POST \
  "${DS_URL}/dolphinscheduler/projects/${PROJECT_CODE}/workflow-definition/${WF_CODE}/release" \
  --data-urlencode "name=${NAME}" --data-urlencode "releaseState=ONLINE"
```

---

## 3. 配置说明

### 3.1 CDK Context（cdk.json）

```json
{
  "context": {
    "projectName": "ds-aws",          // 所有资源前缀
    "tenants": ["tenant-a", "tenant-b"], // 新增租户在此添加
    "s3BucketName": "",               // install.sh 通过 -c 参数传入
    "aurora": {
      "minCapacity": 0.5,             // 空闲期最低 ACU
      "maxCapacity": 16               // 峰值上限
    },
    "eks": {
      "version": "1.30",
      "systemNodeType": "m5.large"    // Master 节点类型
    },
    "bastionAdminRoleName": "AdminRole"  // 授予 kubectl/helm cluster-admin 的角色名（同账号内），
                                          // 留空/删掉这一行则不授权任何角色，只有 CDK 内部的
                                          // 集群创建角色能访问 API Server——按你部署账号里实际
                                          // 存在的角色名改，不要假设 "AdminRole" 一定存在
  }
}
```

### 3.2 DolphinScheduler Helm 配置

关键配置文件：`helm/dolphinscheduler/values.yaml`

```yaml
master:
  replicas: 2
  nodeSelector:
    karpenter.sh/capacity-type: on-demand   # Master 固定 On-Demand

worker:
  replicas: 3

externalDatabase:
  password: REPLACE_BY_ESO   # chart 3.4.2 无 existingSecret 支持（对着真实 schema 核实过，
                              # 只有明文 username/password 字段），只能传占位符——真实密码由
                              # k8s/external-secrets/externaldb-secret-patch.yaml 事后
                              # patch 进 Chart 生成的 {fullname}-externaldb Secret，见 runbook.md §1.6

zookeeper:
  enabled: true       # chart 3.4.2 无 zookeeper-free 的注册中心选项，只能用内置或外部 etcd

minio:
  enabled: false       # 必须关掉，否则 chart 会强制把 S3 endpoint 覆盖回内置 minio

conf:
  common:
    resource.storage.type: S3
    aws.s3.credentials.provider.type: InstanceProfileCredentialsProvider  # 注意 key 是 aws.s3.*，不是 aws.*
    aws.s3.access.key.id: ""      # 必须留空，非空会被当作静态 key 用
    aws.s3.access.key.secret: ""
    aws.s3.bucket.name: <s3-bucket>         # install.sh 自动注入
    aws.s3.region: us-east-1
    aws.s3.endpoint: https://s3.us-east-1.amazonaws.com
```

> **S3 凭证不是 IRSA**：DS 3.4.2 的 `InstanceProfileCredentialsProvider` 是 AWS SDK v1 的老类，只走 EC2 元数据服务（IMDS），不认 IRSA 的 web-identity token。实际拿到的是 Pod 所在节点的 IAM Role（`ds-aws-eks-node-role`），S3 权限也是加在这个节点角色上（`lib/stacks/app-stack.ts`），不是某个 Pod 级别的角色。Karpenter 节点的 `EC2NodeClass.metadataOptions.httpPutResponseHopLimit` 必须是 `2`（Karpenter 默认是 1），否则 Pod 连不到节点的 IMDS，会报 401。

### 3.3 告警 Webhook 配置

```bash
# 钉钉
aws secretsmanager put-secret-value \
  --secret-id /ds-aws/notify-webhook \
  --secret-string '{"type":"dingtalk","url":"https://oapi.dingtalk.com/robot/send?access_token=xxx"}'

# 企业微信
aws secretsmanager put-secret-value \
  --secret-id /ds-aws/notify-webhook \
  --secret-string '{"type":"wecom","url":"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"}'
```

---

## 4. 新增租户

### 步骤

**1. 修改 cdk.json**

```json
"tenants": ["tenant-a", "tenant-b", "tenant-c"]
```

**2. 重部署 AppStack**

```bash
cdk deploy DsAppStack -c s3BucketName=${S3_BUCKET}
```

CDK 会自动创建：
- EMR Serverless Application (`ds-aws-tenant-c-spark`)
- Athena WorkGroup (`tenant-c`)
- Glue Crawler (`ds-aws-tenant-c-crawler`)
- IRSA Role (`ds-aws-tenant-c-worker-role`)
- K8s ServiceAccount + ConfigMap

**3. 在 DolphinScheduler 创建 Tenant 和 Project**

```
Security → Tenant Management → Create Tenant (tenantCode=tenant-c)
Project Management → Create Project (tenant-c)
```

**4. 初始化 DAG**

```bash
mkdir -p dags/tenant-c
# 复制并修改 dags/tenant-a/etl-pipeline.json
# 修改 tenantCode, name, 所有 tenant-a 引用替换为 tenant-c
git add dags/tenant-c/
git commit -m "feat: add tenant-c DAGs"
git push origin main   # GitHub Actions 自动同步
```

**5. 写入租户业务凭证（如有）**

```bash
aws secretsmanager create-secret \
  --name /ds-aws/tenant-c/jdbc-url \
  --secret-string '{"url":"jdbc:mysql://..."}'
```
