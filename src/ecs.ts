import { Stack } from 'aws-cdk-lib';
import { SecurityGroup, Port, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import {
  ContainerImage,
  CpuArchitecture,
  OperatingSystemFamily,
} from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import { ApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {
  ManagedPolicy,
  Role,
  PolicyStatement,
  PolicyDocument,
  ServicePrincipal,
  AccountPrincipal,
  ArnPrincipal,
  CompositePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { MediaInsightsPipeline } from 'cdk-amazon-chime-resources';
import { Construct } from 'constructs';

interface ECSResourcesProps {
  vpc: Vpc;
  CallAnalyticsProducerAlbSecurityGroup: SecurityGroup;
  sourceBucket: Bucket;
  logLevel: string;
  countFrequency: string;
  mediaInsightsPipelineConfiguration: MediaInsightsPipeline;
}

export class ECSResources extends Construct {
  fargateService: ApplicationLoadBalancedFargateService;
  applicationLoadBalancer: ApplicationLoadBalancer;
  kinesisRole: Role;

  constructor(scope: Construct, id: string, props: ECSResourcesProps) {
    super(scope, id);

    const CallAnalyticsProducerRole = new Role(
      this,
      'CallAnalyticsProducerRole',
      {
        assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
        inlinePolicies: {
          ['KinesisVideoPolicy']: new PolicyDocument({
            statements: [
              new PolicyStatement({
                resources: [
                  `arn:aws:kinesisvideo:${Stack.of(this).region}:${
                    Stack.of(this).account
                  }:stream/CallAnalyticsProducer*`,
                ],
                actions: ['kinesisvideo:*'],
              }),
            ],
          }),
          ['ChimePolicy']: new PolicyDocument({
            statements: [
              new PolicyStatement({
                resources: ['*'],
                actions: ['chime:CreateMediaInsightsPipeline'],
              }),
            ],
          }),
        },
        managedPolicies: [
          ManagedPolicy.fromAwsManagedPolicyName(
            'service-role/AWSLambdaBasicExecutionRole',
          ),
        ],
      },
    );
    props.sourceBucket.grantRead(CallAnalyticsProducerRole);

    this.kinesisRole = new Role(this, 'kinesisRole', {
      assumedBy: new CompositePrincipal(
        new ArnPrincipal(CallAnalyticsProducerRole.roleArn),
      ),
      inlinePolicies: {
        ['KinesisVideoPolicy']: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: ['*'],
              actions: ['kinesisvideo:PutMedia'],
            }),
          ],
        }),
      },
    });

    CallAnalyticsProducerRole.grantAssumeRole(
      new AccountPrincipal(Stack.of(this).account),
    );

    this.applicationLoadBalancer = new ApplicationLoadBalancer(
      this,
      'applicationLoadBalancer',
      {
        vpc: props.vpc,
        vpcSubnets: { subnetType: SubnetType.PUBLIC },
        internetFacing: false,
        securityGroup: props.CallAnalyticsProducerAlbSecurityGroup,
      },
    );

    this.fargateService = new ApplicationLoadBalancedFargateService(
      this,
      'fargateService',
      {
        taskImageOptions: {
          image: ContainerImage.fromAsset(
            'src/resources/callAnalyticsProducer',
          ),
          taskRole: CallAnalyticsProducerRole,
          environment: {
            SOURCE_BUCKET: props.sourceBucket.bucketName,
            COUNT_FREQUENCY: props.countFrequency,
            ECS_ROLE: this.kinesisRole.roleArn,
            ECS_LOGLEVEL: props.logLevel,
            MEDIA_INSIGHT_CONFIGURATION_ARN:
              props.mediaInsightsPipelineConfiguration
                .mediaInsightsPipelineConfigurationArn,
          },
        },
        publicLoadBalancer: true,
        cpu: 2048,
        memoryLimitMiB: 4096,
        vpc: props.vpc,
        assignPublicIp: true,
        openListener: false,
        loadBalancer: this.applicationLoadBalancer,
        listenerPort: 80,
        taskSubnets: {
          subnetType: SubnetType.PUBLIC,
        },
        securityGroups: [props.CallAnalyticsProducerAlbSecurityGroup],
        runtimePlatform: {
          operatingSystemFamily: OperatingSystemFamily.LINUX,
          cpuArchitecture: CpuArchitecture.ARM64,
        },
      },
    );

    this.fargateService.service.connections.allowFrom(
      props.CallAnalyticsProducerAlbSecurityGroup,
      Port.tcp(80),
    );
  }
}
