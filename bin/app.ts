#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { loadConfig }       from '../lib/config';
import { NetworkingStack }  from '../lib/stacks/networking-stack';
import { DataStack }        from '../lib/stacks/data-stack';
import { EksStack }         from '../lib/stacks/eks-stack';
import { AppStack }         from '../lib/stacks/app-stack';

const app    = new cdk.App();
const config = loadConfig(app);

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const stackTags = { Project: config.projectName, ManagedBy: 'cdk' };

// Stack 1 — VPC, SGs (incl. Redshift), VPC Endpoints
const networking = new NetworkingStack(app, 'DsNetworkingStack', {
  ...config, env, tags: stackTags,
  description: 'DolphinScheduler on AWS — VPC, security groups, VPC endpoints',
});

// Stack 2 — Aurora Serverless v2, EFS, Redshift
const data = new DataStack(app, 'DsDataStack', {
  ...config, env, tags: stackTags,
  vpc:        networking.vpc,
  auroraSg:   networking.auroraSg,
  efsSg:      networking.efsSg,
  redshiftSg: networking.redshiftSg,
  description: 'DolphinScheduler on AWS — Aurora Serverless v2, EFS, Redshift',
});

// Stack 3 — EKS cluster, node group, Karpenter IRSA
const eksStack = new EksStack(app, 'DsEksStack', {
  ...config, env, tags: stackTags,
  vpc:   networking.vpc,
  eksSg: networking.eksSg,
  description: 'DolphinScheduler on AWS — EKS cluster, Karpenter controller role',
});

// Stack 4 — EMR Serverless, IRSA per-tenant, Athena WorkGroups, Glue Crawlers,
//            Lambda triggers, EventBridge rules, CloudWatch alarms, SNS
new AppStack(app, 'DsAppStack', {
  ...config, env, tags: stackTags,
  cluster:             eksStack.cluster,
  nodeRole:            eksStack.nodeRole,
  auroraCluster:       data.auroraCluster,
  redshiftSg:          networking.redshiftSg,
  oidcProviderArn:     eksStack.oidcProviderArn,
  oidcIssuerHost:      eksStack.oidcIssuerHost,
  redshiftEndpoint:    data.redshiftEndpoint,
  redshiftPort:        data.redshiftPort,
  redshiftCopyRoleArn: data.redshiftCopyRoleArn,
  description: 'DolphinScheduler on AWS — application layer: EMR, IRSA, EventBridge, monitoring',
});

app.synth();
