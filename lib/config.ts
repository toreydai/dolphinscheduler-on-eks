import * as cdk from 'aws-cdk-lib';

export interface AuroraConfig {
  minCapacity: number;
  maxCapacity: number;
}

export interface EksConfig {
  version: string;
  systemNodeType: string;
}

export interface DsConfig {
  projectName: string;
  tenants: string[];
  s3BucketName: string;
  aurora: AuroraConfig;
  eks: EksConfig;
  // IAM role (in the deploying account) granted kubectl/helm cluster-admin via
  // the aws-auth ConfigMap — see EksStack. Undefined skips the grant entirely
  // rather than assuming a role of this name exists; don't hardcode a name in
  // source, since "the deploying account happens to have a role called X" is
  // an assumption specific to whoever first stood this up, not a property of
  // the stack itself.
  bastionAdminRoleName?: string;
}

export function loadConfig(app: cdk.App): DsConfig {
  const s3BucketName = app.node.tryGetContext('s3BucketName') as string;
  if (!s3BucketName) {
    throw new Error(
      'Required CDK context missing: s3BucketName\n' +
      'Pass it with: cdk deploy -c s3BucketName=your-bucket'
    );
  }

  return {
    projectName: (app.node.tryGetContext('projectName') as string) ?? 'ds-aws',
    tenants:     (app.node.tryGetContext('tenants') as string[])   ?? ['tenant-a', 'tenant-b'],
    s3BucketName,
    aurora: (app.node.tryGetContext('aurora') as AuroraConfig) ?? { minCapacity: 0.5, maxCapacity: 16 },
    eks:    (app.node.tryGetContext('eks')    as EksConfig)    ?? { version: '1.30', systemNodeType: 'm5.large' },
    bastionAdminRoleName: app.node.tryGetContext('bastionAdminRoleName') as string | undefined,
  };
}
