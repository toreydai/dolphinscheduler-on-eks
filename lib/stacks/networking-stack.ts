import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { DsConfig } from '../config';

export interface NetworkingStackProps extends cdk.StackProps, DsConfig {}

export class NetworkingStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly albSg: ec2.SecurityGroup;
  readonly eksSg: ec2.SecurityGroup;
  readonly auroraSg: ec2.SecurityGroup;
  readonly efsSg: ec2.SecurityGroup;
  readonly redshiftSg: ec2.SecurityGroup;
  readonly endpointSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkingStackProps) {
    super(scope, id, props);

    const { projectName } = props;

    // ── VPC ────────────────────────────────────────────────────────────────

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${projectName}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      // Pinned rather than maxAzs: the DMS interface VPC endpoint in this account/region
      // is only available in us-east-1b/c/d, not us-east-1a (the default maxAzs:2 pick).
      availabilityZones: ['us-east-1b', 'us-east-1c'],
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public',      subnetType: ec2.SubnetType.PUBLIC,             cidrMask: 24, mapPublicIpOnLaunch: true },
        { name: 'PrivateApp',  subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'PrivateData', subnetType: ec2.SubnetType.PRIVATE_ISOLATED,    cidrMask: 24 },
      ],
    });

    this.vpc.privateSubnets.forEach(subnet => {
      cdk.Tags.of(subnet).add('karpenter.sh/discovery', `${projectName}-eks`);
      cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
    });
    this.vpc.publicSubnets.forEach(subnet => {
      cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
    });

    // ── Security Groups ────────────────────────────────────────────────────

    this.endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      securityGroupName: `${projectName}-endpoint-sg`,
      description: 'VPC Interface Endpoint - ingress from EKS',
      allowAllOutbound: false,
    });

    this.eksSg = new ec2.SecurityGroup(this, 'EksSg', {
      vpc: this.vpc,
      securityGroupName: `${projectName}-eks-sg`,
      description: 'EKS nodes',
    });
    this.eksSg.addIngressRule(this.eksSg, ec2.Port.allTraffic(), 'Intra-cluster');
    this.endpointSg.addIngressRule(this.eksSg, ec2.Port.tcp(443), 'EKS to VPC Endpoints');

    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      securityGroupName: `${projectName}-alb-sg`,
      description: 'Public ALB',
    });
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet');
    this.eksSg.addIngressRule(this.albSg, ec2.Port.tcp(12345), 'ALB to DS UI');

    this.auroraSg = new ec2.SecurityGroup(this, 'AuroraSg', {
      vpc: this.vpc,
      securityGroupName: `${projectName}-aurora-sg`,
      description: 'Aurora Serverless v2',
      allowAllOutbound: false,
    });
    this.auroraSg.addIngressRule(this.eksSg, ec2.Port.tcp(5432), 'EKS to Aurora');

    this.efsSg = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc: this.vpc,
      securityGroupName: `${projectName}-efs-sg`,
      description: 'EFS mount targets',
      allowAllOutbound: false,
    });
    this.efsSg.addIngressRule(this.eksSg, ec2.Port.tcp(2049), 'EKS to EFS');

    this.redshiftSg = new ec2.SecurityGroup(this, 'RedshiftSg', {
      vpc: this.vpc,
      securityGroupName: `${projectName}-redshift-sg`,
      description: 'Redshift cluster',
      allowAllOutbound: false,
    });
    this.redshiftSg.addIngressRule(this.eksSg, ec2.Port.tcp(5439), 'EKS to Redshift');
    // Enhanced VPC Routing (on by default for this cluster) forces every
    // COPY/UNLOAD's S3 + STS (AssumeRole on IAM_ROLE) traffic through the
    // VPC instead of Redshift's normal public network path — with
    // allowAllOutbound false and no egress rule at all, that traffic had
    // nowhere to go. Verified live: COPY hung indefinitely in STARTED with
    // an open, ungranted lock on the target table (no error, no timeout —
    // just silently dropped SYNs) rather than failing fast.
    this.redshiftSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'COPY/UNLOAD to S3 gateway + STS/Redshift interface endpoints');
    this.endpointSg.addIngressRule(this.redshiftSg, ec2.Port.tcp(443), 'Redshift to VPC Endpoints (STS for COPY IAM_ROLE assumption)');

    // ── VPC Endpoints ──────────────────────────────────────────────────────

    // S3 Gateway — free, zero NAT cost for all S3 traffic
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // Interface endpoints — private DNS, no NAT path
    const interfaceServices: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      'EMR':            ec2.InterfaceVpcEndpointAwsService.EMR,
      'Athena':         ec2.InterfaceVpcEndpointAwsService.ATHENA,
      'SecretsManager': ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      'DMS':            new ec2.InterfaceVpcEndpointAwsService('dms'),
      'DataSync':       new ec2.InterfaceVpcEndpointAwsService('datasync'),
      'Redshift':       new ec2.InterfaceVpcEndpointAwsService('redshift'),   // ← §3.2 补全
      'EcrApi':         ec2.InterfaceVpcEndpointAwsService.ECR,
      'EcrDkr':         ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      'STS':            ec2.InterfaceVpcEndpointAwsService.STS,
      'CloudWatchLogs': ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    };

    for (const [name, service] of Object.entries(interfaceServices)) {
      this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
        service,
        subnets:           { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups:    [this.endpointSg],
        privateDnsEnabled: true,
      });
    }

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId, exportName: `${projectName}-vpc-id` });
  }
}
