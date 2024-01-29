/* eslint-disable import/no-extraneous-dependencies */
import { Duration } from 'aws-cdk-lib';
import {
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
  Connections,
} from 'aws-cdk-lib/aws-ec2';
import { ApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { S3EventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Bucket, EventType } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface LambdaResourcesProps {
  sourceBucket: Bucket;
  applicationLoadBalancer: ApplicationLoadBalancer;
  applicationLoadBalancerSecurityGroup: SecurityGroup;
  vpc: Vpc;
}

export class LambdaResources extends Construct {
  constructor(scope: Construct, id: string, props: LambdaResourcesProps) {
    super(scope, id);

    const s3TriggerLambdaRole = new Role(this, 's3TriggerLambdaRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
        ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole',
        ),
      ],
    });

    const lambdaSecurityGroup = new SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: props.vpc,
    });

    props.applicationLoadBalancerSecurityGroup.connections.allowFrom(
      new Connections({
        securityGroups: [lambdaSecurityGroup],
      }),
      Port.tcp(80),
      'allow traffic on port 80 from the Lambda security group',
    );

    const s3TriggerLambda = new NodejsFunction(this, 's3TriggerLambda', {
      entry: 'src/resources/s3Trigger/index.ts',
      runtime: Runtime.NODEJS_LATEST,
      architecture: Architecture.ARM_64,
      role: s3TriggerLambdaRole,
      timeout: Duration.seconds(60),
      allowPublicSubnet: true,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        APPLICATION_LOAD_BALANCER_URL:
          props.applicationLoadBalancer.loadBalancerDnsName,
      },
    });

    const s3TriggerEvent = new S3EventSource(props.sourceBucket, {
      events: [EventType.OBJECT_CREATED],
    });

    s3TriggerLambda.addEventSource(s3TriggerEvent);
  }
}
