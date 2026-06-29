import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as redshift from 'aws-cdk-lib/aws-redshift';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { DsConfig } from '../config';

export interface DataStackProps extends cdk.StackProps, DsConfig {
  vpc: ec2.Vpc;
  auroraSg: ec2.SecurityGroup;
  efsSg: ec2.SecurityGroup;
  redshiftSg: ec2.SecurityGroup;
}

export class DataStack extends cdk.Stack {
  readonly auroraCluster: rds.DatabaseCluster;
  readonly fileSystem: efs.FileSystem;
  readonly pluginsAccessPoint: efs.AccessPoint;
  readonly redshiftEndpoint: string;
  readonly redshiftPort: number;
  readonly redshiftCopyRoleArn: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { projectName, vpc, auroraSg, efsSg, redshiftSg, aurora, s3BucketName } = props;
    const bucket = s3.Bucket.fromBucketName(this, 'DsBucket', s3BucketName);

    // ── Aurora Serverless v2 ───────────────────────────────────────────────

    this.auroraCluster = new rds.DatabaseCluster(this, 'Aurora', {
      clusterIdentifier: `${projectName}-aurora`,
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_17,
      }),
      credentials: rds.Credentials.fromGeneratedSecret('dsadmin', {
        secretName: `/${projectName}/aurora/password`,
      }),
      defaultDatabaseName: 'dolphinscheduler',
      writer: rds.ClusterInstance.serverlessV2('writer'),
      serverlessV2MinCapacity: aurora.minCapacity,
      serverlessV2MaxCapacity: aurora.maxCapacity,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [auroraSg],
      backup: { retention: cdk.Duration.days(7) },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── EFS Serverless ─────────────────────────────────────────────────────

    this.fileSystem = new efs.FileSystem(this, 'Efs', {
      fileSystemName: `${projectName}-efs`,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: efsSg,
      throughputMode: efs.ThroughputMode.ELASTIC,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.pluginsAccessPoint = this.fileSystem.addAccessPoint('PluginsAP', {
      path: '/plugins',
      posixUser:  { uid: '1000', gid: '1000' },
      createAcl:  { ownerUid: '1000', ownerGid: '1000', permissions: '755' },
    });

    // ── Redshift ───────────────────────────────────────────────────────────

    // IAM role Redshift assumes to COPY from S3
    const redshiftCopyRole = new iam.Role(this, 'RedshiftCopyRole', {
      roleName: `${projectName}-redshift-copy-role`,
      assumedBy: new iam.ServicePrincipal('redshift.amazonaws.com'),
    });
    redshiftCopyRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['s3:GetObject', 's3:ListBucket'],
      resources: [bucket.bucketArn, `${bucket.bucketArn}/processed/*`],
    }));
    this.redshiftCopyRoleArn = redshiftCopyRole.roleArn;

    // Master password stored in Secrets Manager
    const redshiftSecret = new secretsmanager.Secret(this, 'RedshiftSecret', {
      secretName: `/${projectName}/redshift/password`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'dsadmin' }),
        generateStringKey:    'password',
        excludePunctuation:   true,
        passwordLength:       24,
      },
    });

    const redshiftSubnetGroup = new redshift.CfnClusterSubnetGroup(this, 'RedshiftSubnetGroup', {
      description: `${projectName} Redshift subnet group`,
      subnetIds:   vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });

    const redshiftCluster = new redshift.CfnCluster(this, 'RedshiftCluster', {
      clusterIdentifier:     `${projectName}-redshift`,
      clusterType:           'single-node',
      nodeType:              'ra3.large',
      dbName:                'analytics',
      masterUsername:        'dsadmin',
      masterUserPassword:    cdk.SecretValue.secretsManager(
        redshiftSecret.secretArn, { jsonField: 'password' }
      ).unsafeUnwrap(),
      clusterSubnetGroupName: redshiftSubnetGroup.ref,
      vpcSecurityGroupIds:   [redshiftSg.securityGroupId],
      iamRoles:              [redshiftCopyRole.roleArn],
      enhancedVpcRouting:    true,
      publiclyAccessible:    false,
    });

    this.redshiftEndpoint = redshiftCluster.attrEndpointAddress;
    this.redshiftPort     = 5439;

    // ── Outputs ────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'AuroraEndpoint', {
      value:      this.auroraCluster.clusterEndpoint.hostname,
      exportName: `${projectName}-aurora-endpoint`,
    });
    new cdk.CfnOutput(this, 'AuroraSecretArn', {
      value:      this.auroraCluster.secret!.secretArn,
      exportName: `${projectName}-aurora-secret-arn`,
    });
    new cdk.CfnOutput(this, 'EfsId', {
      value:      this.fileSystem.fileSystemId,
      exportName: `${projectName}-efs-id`,
    });
    new cdk.CfnOutput(this, 'RedshiftEndpoint', {
      value:      this.redshiftEndpoint,
      exportName: `${projectName}-redshift-endpoint`,
    });
    new cdk.CfnOutput(this, 'RedshiftCopyRoleArn', {
      value:      this.redshiftCopyRoleArn,
      exportName: `${projectName}-redshift-copy-role-arn`,
    });
  }
}
