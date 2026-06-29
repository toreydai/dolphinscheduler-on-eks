"""
Alert notification Lambda.
Receives SNS messages from CloudWatch Alarms / EventBridge and forwards
them to DingTalk or WeCom webhook.

Secret format (/${projectName}/notify-webhook):
  { "type": "dingtalk" | "wecom", "url": "https://..." }
"""
import json
import os
import urllib.request
import boto3

REGION      = os.environ.get("AWS_REGION", "us-east-1")
SECRET_NAME = os.environ["SECRET_NAME"]

_sm = boto3.client("secretsmanager", region_name=REGION)
_webhook_cache: dict = {}


def _get_webhook() -> dict:
    if _webhook_cache:
        return _webhook_cache
    secret = _sm.get_secret_value(SecretId=SECRET_NAME)
    data = json.loads(secret["SecretString"])
    _webhook_cache.update(data)
    return _webhook_cache


def _parse_alarm(record: dict) -> dict:
    """Extract alarm fields from a CloudWatch Alarm or EventBridge SNS message.

    Two shapes land on this topic: CloudWatch Alarms (AlarmName/NewStateValue/...)
    and EventBridge rules targeting the topic directly (EmrFailureRule) — those
    carry the raw event (detail-type/source/detail), not an alarm — so parsing
    unconditionally as an alarm silently produced "Unknown Alarm (UNKNOWN)" for
    every EMR failure. Verified live: a real EMR Serverless job failure reached
    this Lambda but the alert text was generic and never named the job.
    """
    try:
        msg = json.loads(record.get("Message", "{}"))
    except (json.JSONDecodeError, TypeError):
        msg = {}

    if "detail-type" in msg:
        detail = msg.get("detail", {})
        return {
            "name":        msg.get("detail-type", "Unknown Event"),
            "description": f"source={msg.get('source', '')}",
            "state":       detail.get("state", "UNKNOWN"),
            "reason":      (f"applicationId={detail.get('applicationId', '')} "
                             f"jobRunId={detail.get('jobRunId', '')}"),
            "time":        msg.get("time", ""),
            "region":      msg.get("region", REGION),
        }

    return {
        "name":        msg.get("AlarmName", "Unknown Alarm"),
        "description": msg.get("AlarmDescription", ""),
        "state":       msg.get("NewStateValue", "UNKNOWN"),
        "reason":      msg.get("NewStateReason", ""),
        "time":        msg.get("StateChangeTime", ""),
        "region":      msg.get("Region", REGION),
    }


_BAD_STATES = {"ALARM", "FAILED", "CANCELLED"}


def _format_dingtalk(alarm: dict) -> dict:
    state_icon = "🔴" if alarm["state"] in _BAD_STATES else "🟢"
    text = (
        f"## {state_icon} CloudWatch Alarm\n\n"
        f"**名称**: {alarm['name']}\n\n"
        f"**状态**: {alarm['state']}\n\n"
        f"**原因**: {alarm['reason']}\n\n"
        f"**描述**: {alarm['description']}\n\n"
        f"**时间**: {alarm['time']}\n\n"
        f"**Region**: {alarm['region']}"
    )
    return {
        "msgtype":  "markdown",
        "markdown": {"title": f"[{alarm['state']}] {alarm['name']}", "text": text},
    }


def _format_wecom(alarm: dict) -> dict:
    state_icon = "🔴" if alarm["state"] in _BAD_STATES else "🟢"
    content = (
        f"## {state_icon} CloudWatch Alarm\n"
        f"> **名称**: {alarm['name']}\n"
        f"> **状态**: <font color=\"{'warning' if alarm['state'] in _BAD_STATES else 'info'}\">"
        f"{alarm['state']}</font>\n"
        f"> **原因**: {alarm['reason']}\n"
        f"> **时间**: {alarm['time']}"
    )
    return {"msgtype": "markdown", "markdown": {"content": content}}


def _post_webhook(url: str, payload: dict) -> None:
    data = json.dumps(payload).encode()
    req  = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read().decode()
        print(f"Webhook response ({resp.status}): {body}")


def handler(event: dict, context) -> dict:
    webhook = _get_webhook()
    url     = webhook["url"]
    wtype   = webhook.get("type", "dingtalk")

    # SNS wraps CloudWatch Alarm messages in Records
    records = event.get("Records", [event])

    for record in records:
        alarm   = _parse_alarm(record.get("Sns", record))
        payload = _format_dingtalk(alarm) if wtype == "dingtalk" else _format_wecom(alarm)
        print(f"Sending alert: {alarm['name']} ({alarm['state']})")
        _post_webhook(url, payload)

    return {"statusCode": 200}
