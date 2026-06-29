import json
import os
import time
import boto3
import urllib.request
import urllib.error
import urllib.parse

REGION       = os.environ.get("AWS_REGION", "us-east-1")
DS_API_URL   = os.environ["DS_API_URL"].rstrip("/")
SECRET_NAME  = os.environ["SECRET_NAME"]
PROJECT_CODE = os.environ.get("DS_PROJECT_CODE", "1")
TENANTS      = [t for t in os.environ.get("TENANTS", "").split(",") if t]

_sm       = boto3.client("secretsmanager", region_name=REGION)
_datasync = boto3.client("datasync", region_name=REGION)

_token_cache: dict = {}

TOKEN_TTL = 3600  # seconds — re-fetch before DS token expires


def _get_ds_token() -> str:
    now = time.time()
    if _token_cache.get("token") and _token_cache.get("expires_at", 0) > now:
        return _token_cache["token"]
    secret = _sm.get_secret_value(SecretId=SECRET_NAME)
    data = json.loads(secret["SecretString"])
    _token_cache["token"] = data["token"]
    _token_cache["expires_at"] = now + TOKEN_TTL
    return _token_cache["token"]


def _ds_request(method: str, path: str, form: dict | None = None) -> dict:
    # No /v1 prefix — verified against a live DS 3.4.2 API: /dolphinscheduler/v1/*
    # doesn't exist server-side and falls through to the SPA's catch-all route,
    # returning its index.html (200) instead of a 404, so this was silently wrong.
    token = _get_ds_token()
    url   = f"{DS_API_URL}/dolphinscheduler{path}"
    # DS 3.4.2's controllers bind these as @RequestParam, not @RequestBody — a
    # JSON body (the previous approach) is silently ignored and every param
    # comes through as null/default. form-urlencoded is what Spring actually
    # reads here, verified against a live create+release+trigger round trip.
    data = urllib.parse.urlencode(form).encode() if form else None
    req  = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "token":        token,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _find_workflow_code(dag_name: str) -> int | None:
    """Search all pages until the DAG is found or the list is exhausted."""
    page = 1
    while True:
        result = _ds_request(
            "GET",
            f"/projects/{PROJECT_CODE}/workflow-definition"
            f"?pageNo={page}&pageSize=50&searchVal={dag_name}",
        )
        data  = result.get("data", {})
        items = data.get("totalList", [])
        for item in items:
            if item["name"] == dag_name:
                return item["code"]
        total = data.get("total", 0)
        if page * 50 >= total:
            break
        page += 1
    return None


def _trigger_dag(dag_name: str, tenant: str, params: dict | None = None) -> dict:
    code = _find_workflow_code(dag_name)
    if code is None:
        raise ValueError(f"DAG '{dag_name}' not found in project {PROJECT_CODE}")

    form = {
        "workflowDefinitionCode":  code,
        "scheduleTime":            "",
        "failureStrategy":         "END",
        "warningType":             "NONE",
        "execType":                "START_PROCESS",
        "startNodeList":           "",
        "taskDependType":          "TASK_POST",
        "runMode":                 "RUN_MODE_SERIAL",
        "workflowInstancePriority": "MEDIUM",
        "workerGroup":             "default",
        # DS's own "tenant" (an OS-level user a task's shell/python process
        # runs as) is a start-workflow-instance param, not anything set on
        # the workflow/task definition — omitting it defaults to "default",
        # which is disabled here (WORKER_TENANT_CONFIG_DEFAULT_TENANT_ENABLED
        # =false), so every task instance failed at dispatch with "The
        # tenantCode is default, please enable
        # TenantConfig#isDefaultTenantEnabled" before this was added.
        "tenantCode": tenant,
    }
    if params:
        form["startParams"] = json.dumps(params)

    return _ds_request(
        "POST",
        f"/projects/{PROJECT_CODE}/executors/start-workflow-instance",
        form,
    )


def _tenant_from_prefix(identifier: str) -> str:
    """Match identifier against the known tenant list (longest match wins).

    Tenant names themselves contain hyphens ("tenant-a"), so a naive
    identifier.split("-")[0] on something like "tenant-a-migration-task"
    silently truncates to "tenant" — verified live via a direct Lambda
    invoke, which then 404'd looking for a "tenant-post-dms-pipeline" DAG.
    """
    matches = [t for t in TENANTS if identifier.startswith(t)]
    return max(matches, key=len) if matches else "default"


def _tenant_from_datasync_task(task_arn: str) -> str:
    """Resolve tenant name from the Tenant tag on a DataSync task."""
    try:
        tags = _datasync.list_tags_for_resource(ResourceArn=task_arn).get("Tags", [])
        return next((t["Value"] for t in tags if t["Key"] == "Tenant"), "default")
    except Exception as exc:
        print(f"Could not resolve tenant from DataSync task tags ({task_arn}): {exc}")
        return "default"


def handler(event: dict, context) -> dict:
    source = event.get("source", "")

    if source == "aws.s3":
        bucket = event["detail"]["bucket"]["name"]
        key    = event["detail"]["object"]["key"]
        # Expected key format: raw/<tenant>/<filename>
        parts  = key.split("/")
        if len(parts) < 3 or not parts[1]:
            print(f"Skipping: key '{key}' does not match raw/<tenant>/<filename>")
            return {"statusCode": 200, "body": "skipped"}
        tenant   = parts[1]
        dag_name = f"{tenant}-etl-pipeline"
        params   = {"s3_bucket": bucket, "s3_key": key, "tenant": tenant}

    elif source == "aws.dms":
        task_id  = event["detail"].get("replicationTaskIdentifier", "")
        tenant   = _tenant_from_prefix(task_id) if task_id else "default"
        dag_name = f"{tenant}-post-dms-pipeline"
        params   = {"dms_task_id": task_id}

    elif source == "aws.datasync":
        # "DataSync Task Execution State Change" carries no TaskArn/
        # TaskExecutionArn in detail — detail is just {"State": "..."}. The
        # execution ARN lives in the event's top-level `resources` array
        # instead; the task ARN is its "/execution/exec-..." prefix. Verified
        # live via a captured raw event — the old detail.get("TaskArn", "")
        # always silently returned "", so this path had never actually
        # resolved a tenant before.
        resources     = event.get("resources", [])
        task_exec_arn = resources[0] if resources else ""
        task_arn      = task_exec_arn.split("/execution/")[0] if task_exec_arn else ""
        tenant        = _tenant_from_datasync_task(task_arn)
        dag_name      = f"{tenant}-etl-pipeline"
        params        = {
            "datasync_task_arn":      task_arn,
            "task_execution_arn":     task_exec_arn,
            "tenant":                 tenant,
        }

    else:
        print(f"Unhandled event source: {source}")
        return {"statusCode": 200, "body": "skipped"}

    print(f"Triggering DAG '{dag_name}' with params {params}")
    result = _trigger_dag(dag_name, tenant, params)
    print(f"DS API response: {result}")

    return {"statusCode": 200, "body": json.dumps(result)}
