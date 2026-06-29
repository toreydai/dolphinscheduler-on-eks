import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as emrserverless from 'aws-cdk-lib/aws-emrserverless';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { DsConfig } from '../config';

export interface AppStackProps extends cdk.StackProps, DsConfig {
  cluster:            eks.Cluster;
  nodeRole:           iam.Role;
  auroraCluster:      rds.DatabaseCluster;
  redshiftSg:         ec2.SecurityGroup;
  oidcProviderArn:    string;
  // Pre-stripped (no "https://") in EksStack, where the token originates —
  // .replace() on a cross-stack token here would be a silent no-op. See
  // EksStack.oidcIssuerHost.
  oidcIssuerHost:     string;
  redshiftEndpoint:   string;
  redshiftPort:       number;
  redshiftCopyRoleArn: string;
}

export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const {
      projectName, tenants, s3BucketName,
      cluster, nodeRole, auroraCluster, redshiftSg,
      oidcProviderArn, oidcIssuerHost: oidcHost,
      redshiftEndpoint, redshiftPort, redshiftCopyRoleArn,
    } = props;

    const bucket   = s3.Bucket.fromBucketName(this, 'DsBucket', s3BucketName);

    // Managed node groups (EksStack.addNodegroupCapacity) attach the EKS-auto-
    // managed cluster security group to node ENIs, not the custom `eksSg` that
    // DsNetworkingStack's auroraSg ingress rule references — verified against
    // the real node's ENI, which carries `eks-cluster-sg-<name>-*`, not eksSg.
    // A plain CfnSecurityGroupIngress here (rather than
    // auroraCluster.connections.allowFrom, which would physically attach the
    // rule to auroraSg's construct in DsNetworkingStack) keeps the resource in
    // DsAppStack, the one stack already downstream of both DsNetworkingStack
    // (owns auroraSg) and DsEksStack (owns the cluster's auto-managed SG) —
    // attaching it to auroraSg's own stack instead would make NetworkingStack
    // depend on EksStack, which depends on NetworkingStack for the VPC: a cycle.
    new ec2.CfnSecurityGroupIngress(this, 'EksNodesToAurora', {
      groupId:              auroraCluster.connections.securityGroups[0].securityGroupId,
      sourceSecurityGroupId: cluster.clusterSecurityGroupId,
      ipProtocol: 'tcp',
      fromPort:   5432,
      toPort:     5432,
      description: 'EKS nodes to Aurora',
    });

    // Same bug, same fix, for Redshift: redshiftSg's only ingress rule (in
    // DsNetworkingStack) references the custom eksSg, not the EKS-managed
    // cluster SG nodes actually carry — verified live, direct TCP connect to
    // Redshift:5439 from a pod timed out before this rule was added.
    new ec2.CfnSecurityGroupIngress(this, 'EksNodesToRedshift', {
      groupId:              redshiftSg.securityGroupId,
      sourceSecurityGroupId: cluster.clusterSecurityGroupId,
      ipProtocol: 'tcp',
      fromPort:   5439,
      toPort:     5439,
      description: 'EKS nodes to Redshift',
    });

    // ── Upload Spark scripts to S3 ─────────────────────────────────────────

    new s3deploy.BucketDeployment(this, 'Scripts', {
      sources:             [s3deploy.Source.asset(path.join(__dirname, '../../scripts'))],
      destinationBucket:   bucket,
      destinationKeyPrefix:'scripts/',
    });

    // ── SNS Alert Topic ────────────────────────────────────────────────────

    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName:   `${projectName}-alerts`,
      displayName: 'DolphinScheduler on AWS — Alerts',
    });

    // EventBridge rule targets (targets.SnsTopic, used below for
    // emrFailureRule) auto-grant events.amazonaws.com publish via CDK's
    // IGrantable wiring, but cloudwatch.Alarm.addAlarmAction(SnsAction(...))
    // does not do the equivalent for cloudwatch.amazonaws.com — verified
    // live: every alarm here fired (OK→ALARM state changes were real, caught
    // by CloudWatch), but every SNS publish attempt failed silently ("Failed
    // to execute action") because the topic's resource policy never granted
    // the CloudWatch service principal permission.
    alertTopic.grantPublish(new iam.ServicePrincipal('cloudwatch.amazonaws.com'));

    // ── Notification Lambda (SNS → DingTalk / WeCom) ──────────────────────

    const webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      secretName:  `/${projectName}/notify-webhook`,
      description: 'DingTalk or WeCom webhook config for alert forwarding',
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ type: 'dingtalk', url: 'REPLACE_WITH_WEBHOOK_URL' })
      ),
    });

    const notifyRole = new iam.Role(this, 'NotifyRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    webhookSecret.grantRead(notifyRole);

    const notifyFn = new lambda.Function(this, 'NotifyFn', {
      functionName: `${projectName}-notify`,
      code:         lambda.Code.fromAsset(path.join(__dirname, '../../lambda/notify')),
      handler:      'handler.handler',
      runtime:      lambda.Runtime.PYTHON_3_12,
      role:         notifyRole,
      timeout:      cdk.Duration.seconds(15),
      environment: {
        SECRET_NAME: webhookSecret.secretName,
      },
    });

    new logs.LogGroup(this, 'NotifyLogs', {
      logGroupName:  `/aws/lambda/${notifyFn.functionName}`,
      retention:     logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    alertTopic.addSubscription(new sns_subs.LambdaSubscription(notifyFn));

    // ── DS Resource Center S3 access ───────────────────────────────────────

    // Not IRSA: DS 3.4.2's S3StorageOperator only supports
    // AWSStaticCredentialsProvider or com.amazonaws.auth.
    // InstanceProfileCredentialsProvider (verified against source) — the
    // latter is the AWS SDK v1 class that exclusively calls the EC2 Instance
    // Metadata Service, with no IRSA/web-identity support at all. So whatever
    // credentials master/worker/api/alert get resolve through the pod's
    // underlying EC2 node, i.e. this node role — not a pod-scoped role.
    nodeRole.addToPolicy(new iam.PolicyStatement({
      sid:       'DsResourceCenterS3',
      actions:   ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      resources: [bucket.bucketArn, `${bucket.bucketArn}/dolphinscheduler/*`],
    }));

    // ── EMR Serverless Job Role ────────────────────────────────────────────

    const emrJobRole = new iam.Role(this, 'EmrJobRole', {
      roleName:   `${projectName}-emr-serverless-job-role`,
      assumedBy:  new iam.ServicePrincipal('emr-serverless.amazonaws.com'),
    });
    emrJobRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
    }));
    emrJobRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartitions', 'glue:CreateTable', 'glue:UpdateTable'],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/*_db`,
        `arn:aws:glue:${this.region}:${this.account}:table/*_db/*`,
      ],
    }));
    emrJobRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/emr-serverless/*`],
    }));

    // ── ESO Role ───────────────────────────────────────────────────────────

    // oidcHost resolves from a deploy-time token, so the condition keys must go
    // through CfnJson rather than a plain template-literal object key.
    const esoOidcCondition = new cdk.CfnJson(this, 'EsoOidcCondition', {
      value: {
        [`${oidcHost}:sub`]: 'system:serviceaccount:external-secrets:external-secrets',
        [`${oidcHost}:aud`]: 'sts.amazonaws.com',
      },
    });

    const esoRole = new iam.Role(this, 'EsoRole', {
      roleName:  `${projectName}-eso-role`,
      assumedBy: new iam.WebIdentityPrincipal(oidcProviderArn, {
        StringEquals: esoOidcCondition,
      }),
    });
    esoRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${projectName}/*`],
    }));

    // ── Glue Role (shared — Crawlers run as this role) ─────────────────────

    const glueRole = new iam.Role(this, 'GlueRole', {
      roleName:  `${projectName}-glue-role`,
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });
    bucket.grantRead(glueRole, 'processed/*');

    // ── DolphinScheduler Namespace ──────────────────────────────────────────
    // install.sh's `kubectl create namespace dolphinscheduler` (Phase 2) runs
    // after `cdk deploy --all` (Phase 1), but the per-tenant ServiceAccount/
    // ConfigMap manifests below land in that namespace — creating it here
    // keeps CDK deploys self-contained instead of depending on script order.
    const dsNamespace = new eks.KubernetesManifest(this, 'DolphinSchedulerNamespace', {
      cluster,
      manifest: [{
        apiVersion: 'v1',
        kind:       'Namespace',
        metadata:   { name: 'dolphinscheduler' },
      }],
    });

    // ── Per-Tenant Resources ───────────────────────────────────────────────

    for (const tenant of tenants) {

      // EMR Serverless Spark Application
      const emrApp = new emrserverless.CfnApplication(this, `EmrApp-${tenant}`, {
        name:         `${projectName}-${tenant}-spark`,
        releaseLabel: 'emr-7.1.0',
        type:         'SPARK',
        autoStartConfiguration: { enabled: true },
        autoStopConfiguration:  { enabled: true, idleTimeoutMinutes: 15 },
        maximumCapacity:        { cpu: '40 vCPU', memory: '80 GB' },
        tags: [{ key: 'Tenant', value: tenant }, { key: 'Project', value: projectName }],
      });

      // Athena WorkGroup — limits output path and scan size per tenant  (§8.2)
      new athena.CfnWorkGroup(this, `AthenaWg-${tenant}`, {
        name:  tenant,
        state: 'ENABLED',
        workGroupConfiguration: {
          resultConfiguration: {
            outputLocation: `s3://${s3BucketName}/athena-results/${tenant}/`,
          },
          bytesScannedCutoffPerQuery:  10 * 1024 * 1024 * 1024,  // 10 GB
          enforceWorkGroupConfiguration: true,
          publishCloudWatchMetricsEnabled: true,
        },
        tags: [{ key: 'Tenant', value: tenant }],
      });

      // Glue Crawler — updates Data Catalog after each ETL run  (§7.3)
      const crawlerName = `${projectName}-${tenant}-crawler`;
      new glue.CfnCrawler(this, `GlueCrawler-${tenant}`, {
        name:         crawlerName,
        role:         glueRole.roleArn,
        databaseName: `${tenant.replace(/-/g, '_')}_db`,
        targets: {
          s3Targets: [{ path: `s3://${s3BucketName}/processed/${tenant}/` }],
        },
        schemaChangePolicy: {
          updateBehavior: 'UPDATE_IN_DATABASE',
          deleteBehavior: 'LOG',
        },
        tags: { Tenant: tenant },
      });

      // Per-tenant IRSA role
      const tenantOidcCondition = new cdk.CfnJson(this, `TenantOidcCondition-${tenant}`, {
        value: {
          [`${oidcHost}:sub`]: `system:serviceaccount:dolphinscheduler:${tenant}-worker`,
          [`${oidcHost}:aud`]: 'sts.amazonaws.com',
        },
      });

      const tenantRole = new iam.Role(this, `TenantRole-${tenant}`, {
        roleName:  `${projectName}-${tenant}-worker-role`,
        assumedBy: new iam.WebIdentityPrincipal(oidcProviderArn, {
          StringEquals: tenantOidcCondition,
        }),
      });

      tenantRole.addToPolicy(new iam.PolicyStatement({
        sid:       'EmrServerless',
        actions:   ['emr-serverless:StartJobRun', 'emr-serverless:GetJobRun', 'emr-serverless:ListJobRuns', 'emr-serverless:CancelJobRun'],
        resources: [`arn:aws:emr-serverless:${this.region}:${this.account}:/applications/${emrApp.attrApplicationId}`, `arn:aws:emr-serverless:${this.region}:${this.account}:/applications/${emrApp.attrApplicationId}/jobruns/*`],
      }));

      tenantRole.addToPolicy(new iam.PolicyStatement({
        sid:       'PassEmrJobRole',
        actions:   ['iam:PassRole'],
        resources: [emrJobRole.roleArn],
      }));

      // tenantRole (IRSA, "system:serviceaccount:dolphinscheduler:{tenant}-worker")
      // is never actually assumed by anything: DS's SHELL/PYTHON task types run
      // inline in the shared worker pod under the "dolphinscheduler" SA, not a
      // per-tenant SA/pod — verified live, boto3's start_job_run in this exact
      // task got AccessDeniedException as ds-aws-eks-node-role (resolved via
      // IMDS, the same node-role path S3 resource-center access uses), never
      // as tenant-a-worker-role. Mirroring the EMR + Glue crawler grants onto
      // nodeRole is what actually unblocks task execution; true per-tenant
      // credential isolation would need the K8S task type (per-task pod with
      // its own SA) instead of SHELL/PYTHON, which is a bigger redesign than
      // fixing this demo pipeline calls for.
      // A plain nodeRole.addToPolicy() here would physically attach the
      // statement to nodeRole's DefaultPolicy, a construct owned by
      // DsEksStack — and these statements reference emrApp/emrJobRole, AppStack
      // tokens, which would make EksStack depend on AppStack while AppStack
      // already depends on EksStack (for nodeRole itself): a cycle. A
      // standalone iam.Policy lives in AppStack and merely references
      // nodeRole, so the dependency only runs the one way that already exists.
      new iam.Policy(this, `NodeRoleEmrServerless-${tenant}`, {
        roles: [nodeRole],
        statements: [
          new iam.PolicyStatement({
            sid:       `EmrServerless${tenant.replace(/-/g, '')}`,
            actions:   ['emr-serverless:StartJobRun', 'emr-serverless:GetJobRun', 'emr-serverless:ListJobRuns', 'emr-serverless:CancelJobRun'],
            resources: [`arn:aws:emr-serverless:${this.region}:${this.account}:/applications/${emrApp.attrApplicationId}`, `arn:aws:emr-serverless:${this.region}:${this.account}:/applications/${emrApp.attrApplicationId}/jobruns/*`],
          }),
          new iam.PolicyStatement({
            sid:       `PassEmrJobRole${tenant.replace(/-/g, '')}`,
            actions:   ['iam:PassRole'],
            resources: [emrJobRole.roleArn],
          }),
        ],
      });

      tenantRole.addToPolicy(new iam.PolicyStatement({
        sid:       'S3Tenant',
        actions:   ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [
          // Raw ingest lands at raw/<tenant>/*, not <tenant>/* — matches the
          // S3RawUploadRule EventBridge pattern, the Lambda's key-parsing
          // (raw/<tenant>/<filename>), and every dag json's S3 paths. The
          // bare `${tenant}/*` form here previously matched none of them:
          // verified live, tenant-a-worker got AccessDenied writing its own
          // raw/tenant-a/ prefix.
          `${bucket.bucketArn}/raw/${tenant}/*`,
          `${bucket.bucketArn}/scripts/*`,
          `${bucket.bucketArn}/logs/*`,
          `${bucket.bucketArn}/processed/${tenant}/*`,
          `${bucket.bucketArn}/dq-reports/${tenant}/*`,
          `${bucket.bucketArn}/athena-results/${tenant}/*`,
        ],
      }));

      // s3:ListBucket is a bucket-level action — granting it on bucket.bucketArn
      // (as the object-level ARNs above are, harmlessly, also valid resources
      // for) authorizes listing the ENTIRE bucket regardless of those object
      // prefixes, which only constrain Get/Put/Delete. Verified live: without
      // this s3:prefix condition, tenant-a-worker could list-objects-v2 across
      // tenant-b's prefix (empty result, but the request itself succeeded
      // rather than AccessDenied) — a cross-tenant filename enumeration leak.
      tenantRole.addToPolicy(new iam.PolicyStatement({
        sid:       'S3TenantList',
        actions:   ['s3:ListBucket'],
        resources: [bucket.bucketArn],
        conditions: {
          StringLike: {
            's3:prefix': [
              `raw/${tenant}/*`,
              'scripts/*',
              'logs/*',
              `processed/${tenant}/*`,
              `dq-reports/${tenant}/*`,
              `athena-results/${tenant}/*`,
            ],
          },
        },
      }));

      tenantRole.addToPolicy(new iam.PolicyStatement({
        sid:       'AthenaWorkgroup',
        actions:   ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults', 'athena:StopQueryExecution'],
        resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/${tenant}`],
      }));

      const tenantDb = `${tenant.replace(/-/g, '_')}_db`;
      tenantRole.addToPolicy(new iam.PolicyStatement({
        sid:       'GlueCatalog',
        actions:   ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartitions', 'glue:CreateTable', 'glue:UpdateTable'],
        resources: [
          `arn:aws:glue:${this.region}:${this.account}:catalog`,
          `arn:aws:glue:${this.region}:${this.account}:database/${tenantDb}`,
          `arn:aws:glue:${this.region}:${this.account}:table/${tenantDb}/*`,
        ],
      }));

      // Glue Crawler trigger permission  (§7.3)
      tenantRole.addToPolicy(new iam.PolicyStatement({
        sid:       'GlueCrawler',
        actions:   ['glue:StartCrawler', 'glue:GetCrawler', 'glue:GetCrawlerMetrics'],
        resources: [`arn:aws:glue:${this.region}:${this.account}:crawler/${crawlerName}`],
      }));

      // Same "tenantRole is never actually assumed" story as the EMR grants
      // above — glue-crawler-update-catalog also runs as nodeRole in practice.
      // Standalone iam.Policy for the same cross-stack-cycle reason as the
      // EMR grants: crawlerName is an AppStack-local value.
      new iam.Policy(this, `NodeRoleGlueCrawler-${tenant}`, {
        roles: [nodeRole],
        statements: [
          new iam.PolicyStatement({
            sid:       `GlueCrawler${tenant.replace(/-/g, '')}`,
            actions:   ['glue:StartCrawler', 'glue:GetCrawler', 'glue:GetCrawlerMetrics'],
            resources: [`arn:aws:glue:${this.region}:${this.account}:crawler/${crawlerName}`],
          }),
        ],
      });

      // Redshift IAM auth (GetClusterCredentials — no plaintext password)  (§7.5)
      tenantRole.addToPolicy(new iam.PolicyStatement({
        sid:     'Redshift',
        actions: ['redshift:GetClusterCredentials', 'redshift:CreateClusterUser', 'redshift:JoinGroup'],
        resources: [
          `arn:aws:redshift:${this.region}:${this.account}:dbuser:${projectName}-redshift/ds_${tenant.replace(/-/g, '_')}`,
          `arn:aws:redshift:${this.region}:${this.account}:dbname:${projectName}-redshift/${tenant.replace(/-/g, '_')}`,
        ],
      }));

      // redshift-copy/validate-row-count run as PYTHON tasks calling the
      // Redshift Data API (boto3 redshift-data client, IAM-authenticated via
      // --db-user, no stored password) instead of DS's built-in SQL task type
      // — DS 3.4.2 has no Redshift JDBC driver bundled in worker-server/libs
      // (ClassNotFoundException: com.amazon.redshift.jdbc42.Driver, verified
      // live) and the chart exposes no hook to add one to the main container's
      // classpath. Same "tenantRole never actually assumed" story as EMR/Glue
      // above, so this grant — plus redshift-data:* — has to live on nodeRole
      // too, not just tenantRole.
      new iam.Policy(this, `NodeRoleRedshift-${tenant}`, {
        roles: [nodeRole],
        statements: [
          new iam.PolicyStatement({
            sid:     `RedshiftAuth${tenant.replace(/-/g, '')}`,
            actions: ['redshift:GetClusterCredentials', 'redshift:CreateClusterUser', 'redshift:JoinGroup'],
            resources: [
              `arn:aws:redshift:${this.region}:${this.account}:dbuser:${projectName}-redshift/ds_${tenant.replace(/-/g, '_')}`,
              `arn:aws:redshift:${this.region}:${this.account}:dbname:${projectName}-redshift/${tenant.replace(/-/g, '_')}`,
              `arn:aws:redshift:${this.region}:${this.account}:dbuser:${projectName}-redshift/dsadmin`,
              `arn:aws:redshift:${this.region}:${this.account}:dbname:${projectName}-redshift/analytics`,
            ],
          }),
          new iam.PolicyStatement({
            sid:       `RedshiftData${tenant.replace(/-/g, '')}`,
            actions:   ['redshift-data:ExecuteStatement', 'redshift-data:BatchExecuteStatement'],
            resources: [`arn:aws:redshift:${this.region}:${this.account}:cluster:${projectName}-redshift`],
          }),
          new iam.PolicyStatement({
            // DescribeStatement/GetStatementResult/CancelStatement address
            // individual query executions by statement ID, not cluster ARN —
            // AWS has no resource-level ARN for these, only "*".
            sid:       `RedshiftDataResult${tenant.replace(/-/g, '')}`,
            actions:   ['redshift-data:DescribeStatement', 'redshift-data:GetStatementResult', 'redshift-data:CancelStatement'],
            resources: ['*'],
          }),
        ],
      });

      // DMS — trigger and monitor replication tasks  (§7.6)
      tenantRole.addToPolicy(new iam.PolicyStatement({
        sid:     'DMS',
        actions: ['dms:StartReplicationTask', 'dms:StopReplicationTask', 'dms:DescribeReplicationTasks'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:ResourceTag/Tenant': tenant } },
      }));

      // DataSync — trigger file transfer tasks  (§7.7)
      tenantRole.addToPolicy(new iam.PolicyStatement({
        sid:     'DataSync',
        actions: ['datasync:StartTaskExecution', 'datasync:DescribeTaskExecution', 'datasync:ListTaskExecutions'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:ResourceTag/Tenant': tenant } },
      }));

      tenantRole.addToPolicy(new iam.PolicyStatement({
        sid:       'Secrets',
        actions:   ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${projectName}/${tenant}/*`],
      }));

      // K8s ServiceAccount + ConfigMap (includes Redshift + Glue Crawler info)
      // Scoped to `this` (AppStack), not `cluster` (EksStack): the manifests below
      // reference AppStack-local resources (tenantRole, emrApp, ...). Using
      // cluster.addServiceAccount/addManifest would scope the custom resource under
      // EksStack, creating an EksStack -> AppStack dependency that cycles back against
      // the existing AppStack -> EksStack dependency (cluster/oidc props).
      const tenantSa = new eks.KubernetesManifest(this, `${tenant}-sa`, {
        cluster,
        manifest: [{
          apiVersion: 'v1',
          kind:       'ServiceAccount',
          metadata: {
            name:        `${tenant}-worker`,
            namespace:   'dolphinscheduler',
            annotations: { 'eks.amazonaws.com/role-arn': tenantRole.roleArn },
          },
        }],
      });
      tenantSa.node.addDependency(dsNamespace);

      const tenantConfig = new eks.KubernetesManifest(this, `${tenant}-config`, {
        cluster,
        manifest: [{
          apiVersion: 'v1',
          kind:       'ConfigMap',
          metadata:   { name: `${tenant}-config`, namespace: 'dolphinscheduler' },
          data: {
            TENANT:                 tenant,
            S3_BUCKET:              s3BucketName,
            EMR_APP_ID:             emrApp.attrApplicationId,
            EMR_JOB_ROLE_ARN:       emrJobRole.roleArn,
            REDSHIFT_HOST:          redshiftEndpoint,
            REDSHIFT_PORT:          String(redshiftPort),
            REDSHIFT_COPY_ROLE_ARN: redshiftCopyRoleArn,
            GLUE_CRAWLER_NAME:      crawlerName,
          },
        }],
      });
      tenantConfig.node.addDependency(dsNamespace);

      new cdk.CfnOutput(this, `TenantRoleArn-${tenant}`, {
        value:      tenantRole.roleArn,
        exportName: `${projectName}-${tenant}-role-arn`,
      });
    }

    // ── Lambda: EventBridge → DolphinScheduler REST API ───────────────────

    const dsApiTokenSecret = new secretsmanager.Secret(this, 'DsApiTokenSecret', {
      secretName:  `/${projectName}/ds-api-token`,
      description: 'DolphinScheduler API token for Lambda trigger',
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ token: 'REPLACE_WITH_DS_TOKEN' })
      ),
    });

    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      roleName:  `${projectName}-lambda-trigger-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    dsApiTokenSecret.grantRead(lambdaRole);

    // _tenant_from_datasync_task() reads the task's Tenant tag to resolve
    // which DAG to trigger — lambdaRole had no datasync permissions at all,
    // so this call always threw AccessDeniedException and silently fell back
    // to tenant="default" (caught by the handler's own try/except), which
    // then 404'd looking for a nonexistent "default-etl-pipeline" DAG.
    // Verified live: a real DataSync task execution reached this Lambda but
    // never resolved the real tenant — only the exception-fallback path had
    // ever been exercised before, never the real tag-resolution path.
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:       'DataSyncTags',
      actions:   ['datasync:ListTagsForResource'],
      resources: ['*'],
    }));

    const triggerFn = new lambda.Function(this, 'TriggerDag', {
      functionName: `${projectName}-trigger-dag`,
      code:         lambda.Code.fromAsset(path.join(__dirname, '../../lambda/trigger_dag')),
      handler:      'handler.handler',
      runtime:      lambda.Runtime.PYTHON_3_12,
      role:         lambdaRole,
      timeout:      cdk.Duration.seconds(30),
      environment: {
        DS_API_URL:      '',
        SECRET_NAME:     dsApiTokenSecret.secretName,
        DS_PROJECT_CODE: '1',
        // Tenant names themselves contain hyphens ("tenant-a"), so recovering
        // the tenant from a hyphenated identifier (a DMS task id, an S3 key
        // segment) needs the real tenant list to match against — splitting
        // on the first "-" silently truncates "tenant-a-migration-task" to
        // "tenant". Verified live via a direct Lambda invoke.
        TENANTS: tenants.join(','),
      },
    });

    new logs.LogGroup(this, 'TriggerDagLogs', {
      logGroupName:  `/aws/lambda/${triggerFn.functionName}`,
      retention:     logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── EventBridge Rules ──────────────────────────────────────────────────

    // S3 raw upload → ETL DAG
    const s3UploadRule = new events.Rule(this, 'S3RawUploadRule', {
      ruleName:    `${projectName}-s3-raw-upload`,
      description: 'Trigger DS DAG when raw data arrives in S3',
      eventPattern: {
        source:     ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [s3BucketName] },
          object: { key: [{ prefix: 'raw/' }] },
        },
      },
    });
    s3UploadRule.addTarget(new targets.LambdaFunction(triggerFn, { retryAttempts: 2 }));

    // DMS task complete → post-sync DAG
    const dmsCompleteRule = new events.Rule(this, 'DmsCompleteRule', {
      ruleName:    `${projectName}-dms-task-complete`,
      description: 'Trigger DS DAG when DMS replication task stops',
      eventPattern: {
        source:     ['aws.dms'],
        detailType: ['DMS Replication Task State Change'],
        detail:     { replicationTaskStatus: ['stopped'] },
      },
    });
    dmsCompleteRule.addTarget(new targets.LambdaFunction(triggerFn, { retryAttempts: 2 }));

    // DataSync task success → downstream ETL DAG  (§7.7 补全)
    const dataSyncRule = new events.Rule(this, 'DataSyncCompleteRule', {
      ruleName:    `${projectName}-datasync-complete`,
      description: 'Trigger DS DAG when DataSync task execution succeeds',
      eventPattern: {
        source:     ['aws.datasync'],
        detailType: ['DataSync Task Execution State Change'],
        detail:     { State: ['SUCCESS'] },
      },
    });
    dataSyncRule.addTarget(new targets.LambdaFunction(triggerFn, { retryAttempts: 2 }));

    // EMR Serverless job failure → alert SNS  (§11)
    const emrFailureRule = new events.Rule(this, 'EmrFailureRule', {
      ruleName:    `${projectName}-emr-job-failure`,
      description: 'Alert when any EMR Serverless job fails',
      eventPattern: {
        source:     ['aws.emr-serverless'],
        detailType: ['EMR Serverless Job Run State Change'],
        detail:     { state: ['FAILED', 'CANCELLED'] },
      },
    });
    emrFailureRule.addTarget(new targets.SnsTopic(alertTopic));

    // ── CloudWatch Alarms  (§11) ───────────────────────────────────────────

    // Aurora CPU
    const auroraCpuAlarm = new cloudwatch.Alarm(this, 'AuroraCpuAlarm', {
      alarmName:          `${projectName}-aurora-cpu-high`,
      alarmDescription:   'Aurora CPU > 80% for 15 consecutive minutes',
      metric: new cloudwatch.Metric({
        namespace:     'AWS/RDS',
        metricName:    'CPUUtilization',
        dimensionsMap: { DBClusterIdentifier: auroraCluster.clusterIdentifier },
        period:        cdk.Duration.minutes(5),
        statistic:     'Average',
      }),
      threshold:           80,
      evaluationPeriods:   3,
      datapointsToAlarm:   3,
      comparisonOperator:  cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData:    cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    auroraCpuAlarm.addAlarmAction(new cw_actions.SnsAction(alertTopic));

    // Aurora ServerlessDatabaseCapacity (ACU) near max
    const auroraAcuAlarm = new cloudwatch.Alarm(this, 'AuroraAcuAlarm', {
      alarmName:        `${projectName}-aurora-acu-high`,
      alarmDescription: 'Aurora Serverless ACU approaching max capacity',
      metric: new cloudwatch.Metric({
        namespace:     'AWS/RDS',
        metricName:    'ServerlessDatabaseCapacity',
        dimensionsMap: { DBClusterIdentifier: auroraCluster.clusterIdentifier },
        period:        cdk.Duration.minutes(5),
        statistic:     'Maximum',
      }),
      threshold:          props.aurora.maxCapacity * 0.85,
      evaluationPeriods:  3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    auroraAcuAlarm.addAlarmAction(new cw_actions.SnsAction(alertTopic));

    // Trigger Lambda errors
    const lambdaErrorAlarm = new cloudwatch.Alarm(this, 'LambdaTriggerErrorAlarm', {
      alarmName:        `${projectName}-trigger-lambda-errors`,
      alarmDescription: 'EventBridge→DS trigger Lambda has errors',
      metric:           triggerFn.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold:        1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData:  cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    lambdaErrorAlarm.addAlarmAction(new cw_actions.SnsAction(alertTopic));

    // Worker queue depth (DS custom metric pushed by DS itself via its alert plugin)
    const workerQueueAlarm = new cloudwatch.Alarm(this, 'WorkerQueueAlarm', {
      alarmName:        `${projectName}-worker-queue-deep`,
      alarmDescription: 'DS worker task queue > 50 — possible throughput bottleneck',
      metric: new cloudwatch.Metric({
        namespace:     `${projectName}/DolphinScheduler`,
        metricName:    'WorkerQueueDepth',
        period:        cdk.Duration.minutes(5),
        statistic:     'Maximum',
      }),
      threshold:          50,
      evaluationPeriods:  2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    workerQueueAlarm.addAlarmAction(new cw_actions.SnsAction(alertTopic));

    // ── Outputs ────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value:      triggerFn.functionName,
      exportName: `${projectName}-trigger-lambda`,
    });
    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value:      alertTopic.topicArn,
      exportName: `${projectName}-alert-topic-arn`,
    });
    new cdk.CfnOutput(this, 'EsoRoleArn', {
      value:      esoRole.roleArn,
      exportName: `${projectName}-eso-role-arn`,
    });
    new cdk.CfnOutput(this, 'EmrJobRoleArn', {
      value:      emrJobRole.roleArn,
      exportName: `${projectName}-emr-job-role-arn`,
    });
    new cdk.CfnOutput(this, 'NotifyWebhookSecretArn', {
      value:      webhookSecret.secretArn,
      exportName: `${projectName}-notify-webhook-secret-arn`,
    });
  }
}
