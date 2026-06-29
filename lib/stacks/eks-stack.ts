import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { KubectlV30Layer } from '@aws-cdk/lambda-layer-kubectl-v30';
import { Construct } from 'constructs';
import { DsConfig } from '../config';

export interface EksStackProps extends cdk.StackProps, DsConfig {
  vpc: ec2.Vpc;
  eksSg: ec2.SecurityGroup;
}

export class EksStack extends cdk.Stack {
  readonly cluster: eks.Cluster;
  readonly nodeRole: iam.Role;
  readonly oidcProviderArn: string;
  readonly oidcIssuerUrl: string;
  readonly oidcIssuerHost: string;
  readonly karpenterControllerRole: iam.Role;

  constructor(scope: Construct, id: string, props: EksStackProps) {
    super(scope, id, props);

    const { projectName, vpc, eksSg, eks: eksCfg, bastionAdminRoleName } = props;

    // ── Cluster ─────────────────────────────────────────────────────────────

    this.cluster = new eks.Cluster(this, 'Cluster', {
      clusterName: `${projectName}-eks`,
      version: eks.KubernetesVersion.of(eksCfg.version),
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      securityGroup: eksSg,
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      defaultCapacity: 0,
      kubectlLayer: new KubectlV30Layer(this, 'KubectlLayer'),
      albController: {
        version: eks.AlbControllerVersion.V2_8_2,
        // System NodeGroup carries CriticalAddonsOnly:NoSchedule; before Karpenter
        // exists it's the cluster's only capacity, so the controller needs a matching
        // toleration or its pods stay Pending and `helm --wait` hangs to timeout.
        // `tolerations` isn't in CDK's AlbControllerHelmChartOptions type but is a
        // valid chart value — cast past the incomplete typing to pass it through.
        additionalHelmChartValues: {
          tolerations: [
            { key: 'CriticalAddonsOnly', operator: 'Exists', effect: 'NoSchedule' },
          ],
        } as eks.AlbControllerOptions['additionalHelmChartValues'],
      },
    });

    this.oidcProviderArn = this.cluster.openIdConnectProvider.openIdConnectProviderArn;
    this.oidcIssuerUrl   = this.cluster.clusterOpenIdConnectIssuerUrl;
    // clusterOpenIdConnectIssuerUrl is a fully opaque deploy-time token, so a
    // plain JS `.replace('https://', '')` is a silent no-op — verified the hard
    // way: every IRSA trust policy built that way (Karpenter, ESO, tenants) kept
    // the literal "https://" prefix in its condition keys and got 403s on
    // AssumeRoleWithWebIdentity. Fn::Split/Fn::Select actually strip it because
    // they run against the resolved string at CloudFormation deploy time.
    this.oidcIssuerHost  = cdk.Fn.select(1, cdk.Fn.split('https://', this.oidcIssuerUrl));

    // Grants kubectl/helm access from the bastion this stack is deployed from.
    // The cluster uses CONFIG_MAP auth mode (not the newer Access Entries API),
    // so admin access has to go through the aws-auth ConfigMap, not `aws eks
    // create-access-entry`. Without this, only the CDK-internal cluster
    // creation role can reach the API server.
    //
    // The role name comes from context (bastionAdminRoleName), not a hardcoded
    // literal — a role called "AdminRole" existing in the deploying account is
    // an assumption specific to whichever account first stood this up, not
    // something every fork/redeploy of this stack can rely on. No context
    // value → skip the grant rather than guess a name and fail at deploy time
    // (or silently reference a role that doesn't exist and grant nothing).
    if (bastionAdminRoleName) {
      this.cluster.awsAuth.addMastersRole(
        iam.Role.fromRoleArn(this, 'BastionAdminRole', `arn:aws:iam::${this.account}:role/${bastionAdminRoleName}`),
      );
    }

    // ── System Node Group (On-Demand — hosts DS Master + system pods) ───────

    this.nodeRole = new iam.Role(this, 'NodeRole', {
      roleName: `${projectName}-eks-node-role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
    });

    this.cluster.addNodegroupCapacity('SystemNodes', {
      nodegroupName: `${projectName}-system`,
      nodeRole: this.nodeRole,
      instanceTypes: [new ec2.InstanceType(eksCfg.systemNodeType)],
      capacityType: eks.CapacityType.ON_DEMAND,
      minSize: 2,
      maxSize: 4,
      desiredSize: 2,
      taints: [{
        key:    'CriticalAddonsOnly',
        value:  'true',
        effect: eks.TaintEffect.NO_SCHEDULE,
      }],
      labels: { role: 'system' },
    });

    // ── Karpenter Controller Role (IRSA) ─────────────────────────────────────

    // The OIDC issuer host is only known at deploy time (Fn::GetAtt token), so the
    // StringEquals condition keys must be built via CfnJson rather than a plain
    // template-literal object key, which newer aws-cdk-lib rejects at synth time.
    const karpenterOidcCondition = new cdk.CfnJson(this, 'KarpenterOidcCondition', {
      value: {
        [`${this.oidcIssuerHost}:sub`]:
          'system:serviceaccount:karpenter:karpenter',
        [`${this.oidcIssuerHost}:aud`]:
          'sts.amazonaws.com',
      },
    });

    const oidcPrincipal = new iam.WebIdentityPrincipal(
      this.oidcProviderArn,
      {
        StringEquals: karpenterOidcCondition,
      }
    );

    this.karpenterControllerRole = new iam.Role(this, 'KarpenterControllerRole', {
      roleName: `${projectName}-karpenter-controller`,
      assumedBy: oidcPrincipal,
    });

    this.karpenterControllerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:CreateLaunchTemplate', 'ec2:DeleteLaunchTemplate',
        'ec2:CreateFleet', 'ec2:RunInstances', 'ec2:CreateTags',
        'ec2:TerminateInstances', 'ec2:DescribeInstances',
        'ec2:DescribeInstanceTypes', 'ec2:DescribeInstanceTypeOfferings',
        'ec2:DescribeAvailabilityZones', 'ec2:DescribeSpotPriceHistory',
        'ec2:DescribeSecurityGroups', 'ec2:DescribeSubnets',
        'ec2:DescribeLaunchTemplates', 'ec2:DescribeImages',
        'eks:DescribeCluster',
        'ssm:GetParameter',
        // Karpenter's pricing provider polls this on startup to make
        // cost-aware provisioning decisions; the Pricing API has no
        // resource-level permissions, so it's always "*". Without it every
        // reconcile loop logs an AccessDeniedException (harmless, but noisy
        // and means Karpenter never gets real On-Demand/Spot price data).
        'pricing:GetProducts',
      ],
      resources: ['*'],
    }));

    this.karpenterControllerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [this.nodeRole.roleArn],
    }));

    // Karpenter v1.0 self-manages an EC2 instance profile per NodeClass
    // (creates/tags/updates it directly) instead of requiring one to be
    // pre-provisioned, so the controller needs full CRUD on instance
    // profiles scoped to this cluster's node role path.
    this.karpenterControllerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'iam:GetInstanceProfile', 'iam:CreateInstanceProfile',
        'iam:TagInstanceProfile', 'iam:AddRoleToInstanceProfile',
        'iam:RemoveRoleFromInstanceProfile', 'iam:DeleteInstanceProfile',
      ],
      resources: ['*'],
    }));

    // ── Outputs ────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      exportName: `${projectName}-cluster-name`,
    });
    new cdk.CfnOutput(this, 'OidcProviderArn', {
      value: this.oidcProviderArn,
      exportName: `${projectName}-oidc-provider-arn`,
    });
    new cdk.CfnOutput(this, 'NodeRoleName', {
      value: this.nodeRole.roleName,
      exportName: `${projectName}-node-role-name`,
    });
    new cdk.CfnOutput(this, 'KarpenterRoleArn', {
      value: this.karpenterControllerRole.roleArn,
      exportName: `${projectName}-karpenter-role-arn`,
    });
  }
}
