import { App, CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { config } from 'dotenv';
import {
  ECSResources,
  VPCResources,
  S3Resources,
  KinesisResources,
  MediaPipelineResources,
  Site,
  ApiGatewayResources,
  DatabaseResources,
  LambdaResources,
} from '.';
config();

interface CallAnalyticsProducerProps extends StackProps {
  logLevel: string;
  countFrequency: string;
}

export class CallAnalyticsProducer extends Stack {
  constructor(scope: Construct, id: string, props: CallAnalyticsProducerProps) {
    super(scope, id, props);

    const s3Resources = new S3Resources(this, 'S3Resources');
    const databaseResources = new DatabaseResources(this, 'DatabaseResources');
    const kinesisResources = new KinesisResources(this, 'KinesisResources');
    const apiGatewayResources = new ApiGatewayResources(
      this,
      'apiGatewayResources',
      {
        kinesisDataStream: kinesisResources.kinesisDataStream,
        connectionTable: databaseResources.connectionTable,
        transcribeTable: databaseResources.transcribeTable,
        logLevel: props.logLevel,
      },
    );
    const mediaPipelineResources = new MediaPipelineResources(
      this,
      'MediaPipelineResources',
      {
        kinesisDataStream: kinesisResources.kinesisDataStream,
      },
    );
    const vpcResources = new VPCResources(this, 'VPCResources');
    const ecsResources = new ECSResources(this, 'ECSResources', {
      vpc: vpcResources.vpc,
      sourceBucket: s3Resources.sourceBucket,
      logLevel: props.logLevel,
      countFrequency: props.countFrequency,
      CallAnalyticsProducerAlbSecurityGroup:
        vpcResources.applicationLoadBalancerSecurityGroup,
      mediaInsightsPipelineConfiguration:
        mediaPipelineResources.transcribeMediaInsightsPipeline,
    });

    new LambdaResources(this, 'LambdaResources', {
      sourceBucket: s3Resources.sourceBucket,
      applicationLoadBalancer: ecsResources.applicationLoadBalancer,
      applicationLoadBalancerSecurityGroup:
        vpcResources.applicationLoadBalancerSecurityGroup,
      vpc: vpcResources.vpc,
    });

    const siteResources = new Site(this, 'SiteResource', {
      webSocketApi: apiGatewayResources.webSocketApi,
      webSocketStage: apiGatewayResources.webSocketStage,
    });

    new CfnOutput(this, 'ecsRole', {
      value: ecsResources.kinesisRole.roleArn,
    });
    new CfnOutput(this, 'mediaInsightPipeline', {
      value:
        mediaPipelineResources.transcribeMediaInsightsPipeline
          .mediaInsightsPipelineConfigurationArn,
    });
    new CfnOutput(this, 'siteBucket', {
      value: siteResources.siteBucket.bucketName,
    });

    new CfnOutput(this, 'siteUrl', {
      value: siteResources.distribution.distributionDomainName,
    });
  }
}

const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1',
};

const stackProps = {
  logLevel: process.env.LOG_LEVEL || 'INFO',
  countFrequency: process.env.COUNT_FREQUENCY || '30',
};

const app = new App();

new CallAnalyticsProducer(app, 'CallAnalyticsProducer', {
  ...stackProps,
  env: devEnv,
});

app.synth();
