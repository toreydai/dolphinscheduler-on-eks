#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# DolphinScheduler on AWS — one-shot installer
# Prerequisites: npm, aws-cdk, helm, kubectl, aws CLI, jq
# Usage: ./install.sh <s3-bucket-name> [aws-region]
# ─────────────────────────────────────────────────────────────────────────────

S3_BUCKET="${1:?Usage: $0 <s3-bucket-name> [aws-region]}"
AWS_REGION="${2:-us-east-1}"
PROJECT_NAME="ds-aws"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

check_prerequisites() {
  for cmd in npm cdk helm kubectl aws jq; do
    command -v "$cmd" &>/dev/null || die "$cmd is not installed"
  done
  log "All prerequisites satisfied"
}

# ── Phase 1: CDK deploy ──────────────────────────────────────────────────────

deploy_cdk() {
  log "Installing CDK dependencies..."
  cd "${SCRIPT_DIR}"
  npm install

  log "Bootstrapping CDK environment (idempotent)..."
  cdk bootstrap "aws://${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}/${AWS_REGION}"

  log "Deploying all CDK stacks (20–30 min)..."
  cdk deploy --all --require-approval never \
    -c s3BucketName="${S3_BUCKET}"

  # Read outputs
  CLUSTER_NAME=$(aws cloudformation describe-stacks \
    --stack-name DsEksStack --region "${AWS_REGION}" \
    --query "Stacks[0].Outputs[?ExportName=='${PROJECT_NAME}-cluster-name'].OutputValue" \
    --output text)

  AURORA_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name DsDataStack --region "${AWS_REGION}" \
    --query "Stacks[0].Outputs[?ExportName=='${PROJECT_NAME}-aurora-endpoint'].OutputValue" \
    --output text)

  ESO_ROLE_ARN=$(aws cloudformation describe-stacks \
    --stack-name DsAppStack --region "${AWS_REGION}" \
    --query "Stacks[0].Outputs[?ExportName=='${PROJECT_NAME}-eso-role-arn'].OutputValue" \
    --output text)

  KARPENTER_ROLE_ARN=$(aws cloudformation describe-stacks \
    --stack-name DsEksStack --region "${AWS_REGION}" \
    --query "Stacks[0].Outputs[?ExportName=='${PROJECT_NAME}-karpenter-role-arn'].OutputValue" \
    --output text)

  NODE_ROLE_NAME=$(aws cloudformation describe-stacks \
    --stack-name DsEksStack --region "${AWS_REGION}" \
    --query "Stacks[0].Outputs[?ExportName=='${PROJECT_NAME}-node-role-name'].OutputValue" \
    --output text)

  LAMBDA_FUNCTION=$(aws cloudformation describe-stacks \
    --stack-name DsAppStack --region "${AWS_REGION}" \
    --query "Stacks[0].Outputs[?ExportName=='${PROJECT_NAME}-trigger-lambda'].OutputValue" \
    --output text)

  log "CDK deploy complete. Cluster: ${CLUSTER_NAME}"
}

# ── Phase 2: kubeconfig ──────────────────────────────────────────────────────

configure_kubectl() {
  log "Configuring kubectl..."
  aws eks update-kubeconfig \
    --region "${AWS_REGION}" \
    --name "${CLUSTER_NAME}"

  kubectl create namespace dolphinscheduler --dry-run=client -o yaml | kubectl apply -f -
  kubectl create namespace external-secrets --dry-run=client -o yaml | kubectl apply -f -
  kubectl create namespace karpenter        --dry-run=client -o yaml | kubectl apply -f -
}

# ── Phase 3: External Secrets Operator ──────────────────────────────────────

install_eso() {
  log "Installing External Secrets Operator..."
  helm repo add external-secrets https://charts.external-secrets.io --force-update

  sed "s|eks.amazonaws.com/role-arn: \"\"|eks.amazonaws.com/role-arn: \"${ESO_ROLE_ARN}\"|" \
    "${SCRIPT_DIR}/helm/external-secrets/values.yaml" > /tmp/eso-values.yaml

  helm upgrade --install external-secrets external-secrets/external-secrets \
    --namespace external-secrets \
    --values /tmp/eso-values.yaml \
    --wait --timeout 5m

  # ClusterSecretStore
  sed "s|region: us-east-1|region: ${AWS_REGION}|" \
    "${SCRIPT_DIR}/k8s/external-secrets/cluster-secret-store.yaml" \
    | kubectl apply -f -

  # ExternalSecrets with real secret paths (CDK names the secret /<projectName>/aurora/password)
  AURORA_SECRET_PATH="/${PROJECT_NAME}/aurora/password"
  DS_TOKEN_SECRET_PATH="/${PROJECT_NAME}/ds-api-token"

  sed "s|key: \"\"|key: \"${AURORA_SECRET_PATH}\"|g" \
    "${SCRIPT_DIR}/k8s/external-secrets/aurora-secret.yaml" \
    | kubectl apply -f -

  sed "s|key: \"\"|key: \"${DS_TOKEN_SECRET_PATH}\"|g" \
    "${SCRIPT_DIR}/k8s/external-secrets/api-token-secret.yaml" \
    | kubectl apply -f -

  log "Waiting for secrets to sync..."
  kubectl wait externalsecret ds-aurora-secret \
    -n dolphinscheduler --for=condition=Ready --timeout=120s

  log "ESO ready"
}

# ── Phase 4: Karpenter ──────────────────────────────────────────────────────

install_karpenter() {
  log "Installing Karpenter..."
  KARPENTER_VERSION="1.0.0"

  # System NodeGroup carries CriticalAddonsOnly:NoSchedule and is the cluster's
  # only capacity until Karpenter itself is up — it needs a matching toleration
  # or its own pod stays Pending and `helm --wait` hangs to timeout.
  helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
    --version "${KARPENTER_VERSION}" \
    --namespace karpenter \
    --set "settings.clusterName=${CLUSTER_NAME}" \
    --set "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn=${KARPENTER_ROLE_ARN}" \
    --set controller.resources.requests.cpu=250m \
    --set controller.resources.requests.memory=256Mi \
    --set "tolerations[0].key=CriticalAddonsOnly" \
    --set "tolerations[0].operator=Exists" \
    --set "tolerations[0].effect=NoSchedule" \
    --wait --timeout 5m

  sed \
    -e "s|role: \"\"|role: \"${NODE_ROLE_NAME}\"|" \
    -e "s|karpenter.sh/discovery: \"\"|karpenter.sh/discovery: \"${CLUSTER_NAME}\"|" \
    -e "s|aws:eks:cluster-name: \"\"|aws:eks:cluster-name: \"${CLUSTER_NAME}\"|" \
    "${SCRIPT_DIR}/k8s/karpenter-nodepool.yaml" \
    | kubectl apply -f -

  log "Karpenter ready"
}

# ── Phase 5: DolphinScheduler ────────────────────────────────────────────────

install_dolphinscheduler() {
  log "Installing DolphinScheduler..."
  # apache.github.io/dolphinscheduler-helm-chart (classic Helm repo) 404s as of
  # 2026 — the chart moved to Docker Hub OCI distribution.

  # externalDatabase has no existingSecret support in this chart (verified
  # against 3.4.2's real schema — plain username/password fields only), so
  # pull the ESO-synced Aurora username out of the K8s Secret ourselves.
  # The password does NOT go through --set (see below) — only the username,
  # which isn't sensitive, is passed this way.
  DS_DB_USER=$(kubectl get secret ds-aurora-secret -n dolphinscheduler -o jsonpath='{.data.username}' | base64 -d)

  # `helm --set`/`-f` values — including externalDatabase.password — get
  # snapshotted into the Helm release Secret forever, in plaintext, for
  # anyone who can read it (`kubectl get secret sh.helm.release.v1.dolphinscheduler.*
  # -o jsonpath='{.data.release}' | base64 -d | base64 -d | gunzip` — verified
  # live). This chart has no existingSecret hook to avoid that, so instead:
  # install with a harmless placeholder, patch the chart's own
  # `{fullname}-externaldb` Secret with the real password via ESO afterward
  # (k8s/external-secrets/externaldb-secret-patch.yaml, creationPolicy: Merge
  # — requires the target Secret to already exist, hence the ordering here),
  # then restart the pods that read it as an env var at container start (not
  # hot-reloaded on Secret change).
  helm upgrade --install dolphinscheduler oci://registry-1.docker.io/apache/dolphinscheduler-helm \
    --namespace dolphinscheduler \
    --values "${SCRIPT_DIR}/helm/dolphinscheduler/values.yaml" \
    --set externalDatabase.host="${AURORA_ENDPOINT}" \
    --set externalDatabase.username="${DS_DB_USER}" \
    --set-string externalDatabase.password="REPLACE_BY_ESO" \
    --set conf.common."aws\.s3\.bucket\.name"="${S3_BUCKET}" \
    --set conf.common."aws\.s3\.region"="${AWS_REGION}" \
    --set conf.common."aws\.s3\.endpoint"="https://s3.${AWS_REGION}.amazonaws.com"
    # No --wait here: pods can't pass their DB-connectivity readiness probe
    # against the placeholder password yet — the explicit rollout wait below,
    # gated on the real password landing first, replaces it.

  log "Patching real DB password into dolphinscheduler-externaldb via ESO (never touches Helm)..."
  sed "s|key: \"\"|key: \"${AURORA_SECRET_PATH}\"|g" \
    "${SCRIPT_DIR}/k8s/external-secrets/externaldb-secret-patch.yaml" \
    | kubectl apply -f -
  kubectl wait externalsecret ds-externaldb-password-patch \
    -n dolphinscheduler --for=condition=Ready --timeout=120s

  log "Restarting DS pods to pick up the real DB password..."
  kubectl rollout restart statefulset/dolphinscheduler-master statefulset/dolphinscheduler-worker \
    deployment/dolphinscheduler-api deployment/dolphinscheduler-alert -n dolphinscheduler
  kubectl rollout status statefulset/dolphinscheduler-master -n dolphinscheduler --timeout=5m
  kubectl rollout status statefulset/dolphinscheduler-worker -n dolphinscheduler --timeout=5m
  kubectl rollout status deployment/dolphinscheduler-api -n dolphinscheduler --timeout=5m
  kubectl rollout status deployment/dolphinscheduler-alert -n dolphinscheduler --timeout=5m

  log "Waiting for DS Load Balancer hostname..."
  DS_LB_HOST=""
  for i in $(seq 1 30); do
    DS_LB_HOST=$(kubectl get ingress -n dolphinscheduler \
      -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
    [ -n "$DS_LB_HOST" ] && break
    sleep 10
  done
  [ -z "$DS_LB_HOST" ] && die "DS load balancer hostname not available"

  DS_API_URL="http://${DS_LB_HOST}"

  # Patch Lambda env var with live DS URL. DS_PROJECT_CODE is a placeholder
  # here — import_dags() resolves the real project code (DS project codes are
  # generated longs, never small sequential integers) and re-patches it below.
  aws lambda update-function-configuration \
    --function-name "${LAMBDA_FUNCTION}" \
    --environment "Variables={DS_API_URL=${DS_API_URL},SECRET_NAME=/${PROJECT_NAME}/ds-api-token,DS_PROJECT_CODE=1}" \
    --region "${AWS_REGION}"

  echo ""
  echo "════════════════════════════════════════════════════"
  log "DolphinScheduler is live: ${DS_API_URL}"
  log "NEXT: Generate DS API token and store it in Secrets Manager:"
  echo "  1. Open ${DS_API_URL} → login as admin"
  echo "  2. Profile → Token Management → Create token"
  echo "  3. aws secretsmanager put-secret-value \\"
  echo "       --secret-id /${PROJECT_NAME}/ds-api-token \\"
  echo "       --secret-string '{\"token\":\"<YOUR_TOKEN>\"}'"
  echo "════════════════════════════════════════════════════"
}

# ── Phase 6: Import initial DAGs ─────────────────────────────────────────────

# DS 3.4.2 dropped the old file-based process-definition/import endpoint
# entirely (verified against the live API and the 3.4.2 controller/frontend
# source — no import/export route exists anywhere in WorkflowDefinitionController
# or the UI's service layer). The replacement is POST .../workflow-definition
# with the same taskDefinitionList/processTaskRelationList content each dag
# json already carries, just sent as individual form fields instead of a
# file, followed by a separate release call to take it ONLINE.
import_dags() {
  sleep 20
  DS_TOKEN=$(aws secretsmanager get-secret-value \
    --secret-id "/${PROJECT_NAME}/ds-api-token" \
    --query 'SecretString' --output text 2>/dev/null \
    | jq -r '.token // empty')

  if [ -z "$DS_TOKEN" ]; then
    log "DS token not set — skipping DAG import. Run manually after setting token."
    return
  fi

  # Resolve or create the project — "projects/list" returns a flat array
  # (not paginated), unlike most other DS list endpoints.
  DS_PROJECT_CODE=$(curl -sf -H "token: ${DS_TOKEN}" \
    "${DS_API_URL}/dolphinscheduler/projects/list" \
    | jq -r '.data[] | select(.name=="default") | .code' | head -1)

  if [ -z "$DS_PROJECT_CODE" ]; then
    DS_PROJECT_CODE=$(curl -sf -H "token: ${DS_TOKEN}" -X POST \
      "${DS_API_URL}/dolphinscheduler/projects" \
      --data-urlencode "projectName=default" \
      --data-urlencode "description=DolphinScheduler on AWS" \
      | jq -r '.data.code')
  fi
  log "DS project code: ${DS_PROJECT_CODE}"

  for DAG in "${SCRIPT_DIR}/dags"/**/*.json; do
    NAME=$(jq -r '.[0].processDefinition.name' "$DAG")
    log "Creating workflow '${NAME}' from ${DAG}..."

    CREATE_RESP=$(curl -sf -H "token: ${DS_TOKEN}" -X POST \
      "${DS_API_URL}/dolphinscheduler/projects/${DS_PROJECT_CODE}/workflow-definition" \
      --data-urlencode "name=${NAME}" \
      --data-urlencode "description=$(jq -r '.[0].processDefinition.description' "$DAG")" \
      --data-urlencode "timeout=$(jq -r '.[0].processDefinition.timeout' "$DAG")" \
      --data-urlencode "executionType=$(jq -r '.[0].processDefinition.executionType' "$DAG")" \
      --data-urlencode "taskDefinitionJson=$(jq -c '.[0].taskDefinitionList' "$DAG")" \
      --data-urlencode "taskRelationJson=$(jq -c '.[0].processTaskRelationList' "$DAG")")

    WF_CODE=$(echo "$CREATE_RESP" | jq -r '.data.code // empty')
    if [ -z "$WF_CODE" ]; then
      log "WARN: failed to create ${DAG}: $(echo "$CREATE_RESP" | jq -r '.msg // .')"
      continue
    fi

    curl -sf -H "token: ${DS_TOKEN}" -X POST \
      "${DS_API_URL}/dolphinscheduler/projects/${DS_PROJECT_CODE}/workflow-definition/${WF_CODE}/release" \
      --data-urlencode "name=${NAME}" \
      --data-urlencode "releaseState=ONLINE" > /dev/null
    log "OK: ${NAME} (code ${WF_CODE})"
  done

  aws lambda update-function-configuration \
    --function-name "${LAMBDA_FUNCTION}" \
    --environment "Variables={DS_API_URL=${DS_API_URL},SECRET_NAME=/${PROJECT_NAME}/ds-api-token,DS_PROJECT_CODE=${DS_PROJECT_CODE}}" \
    --region "${AWS_REGION}" > /dev/null
  log "Lambda DS_PROJECT_CODE patched to ${DS_PROJECT_CODE}"
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  log "DolphinScheduler on AWS installer"
  log "Bucket : ${S3_BUCKET} | Region: ${AWS_REGION}"

  check_prerequisites
  deploy_cdk
  configure_kubectl
  install_eso
  install_karpenter
  install_dolphinscheduler
  import_dags

  log "Installation complete"
}

main "$@"
