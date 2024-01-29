/* eslint-disable import/no-extraneous-dependencies */
import { Stack, StackProps } from 'aws-cdk-lib';
import {
  Role,
  ServicePrincipal,
  PolicyDocument,
  PolicyStatement,
  PrincipalWithConditions,
  CompositePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Stream } from 'aws-cdk-lib/aws-kinesis';
import {
  ElementsType,
  LanguageCode,
  MediaInsightsPipeline,
} from 'cdk-amazon-chime-resources';
import { Construct } from 'constructs';

interface MediaPipelineResourcesProps extends StackProps {
  kinesisDataStream: Stream;
}

export class MediaPipelineResources extends Construct {
  public transcribeMediaInsightsPipeline: MediaInsightsPipeline;
  constructor(
    scope: Construct,
    id: string,
    props: MediaPipelineResourcesProps,
  ) {
    super(scope, id);

    const kdsSinkPolicy = new PolicyDocument({
      statements: [
        new PolicyStatement({
          resources: [
            `arn:aws:kinesis:${Stack.of(this).region}:${
              Stack.of(this).account
            }:stream/${props.kinesisDataStream.streamName}`,
          ],
          actions: ['kinesis:PutRecord'],
        }),
        new PolicyStatement({
          resources: [
            `arn:aws:kms:${Stack.of(this).region}:${
              Stack.of(this).account
            }:key/*`,
          ],
          actions: ['kms:GenerateDataKey'],
          conditions: {
            StringLike: { 'aws:ResourceTag/AWSServiceName': 'ChimeSDK' },
          },
        }),
      ],
    });

    const kvsRole = new Role(this, 'kvsRole', {
      assumedBy: new CompositePrincipal(
        new PrincipalWithConditions(
          new ServicePrincipal('mediapipelines.chime.amazonaws.com'),
          {
            StringEquals: {
              'aws:SourceAccount': Stack.of(this).account,
            },
            ArnLike: {
              'aws:SourceArn': `arn:aws:chime:*:${Stack.of(this).account}:*`,
            },
          },
        ),
      ),
      inlinePolicies: {
        ['mediaInsightsPolicy']: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: ['*'],
              actions: [
                'transcribe:StartCallAnalyticsStreamTranscription',
                'transcribe:StartStreamTranscription',
              ],
            }),
            new PolicyStatement({
              resources: [
                `arn:aws:kinesisvideo:${Stack.of(this).region}:${
                  Stack.of(this).account
                }:stream/CallAnalyticsProducer*`,
              ],
              actions: [
                'kinesisvideo:GetDataEndpoint',
                'kinesisvideo:GetMedia',
              ],
            }),
            new PolicyStatement({
              resources: [
                `arn:aws:kms:${Stack.of(this).region}:${
                  Stack.of(this).account
                }:key/*`,
              ],
              actions: ['kms:Decrypt'],
              conditions: {
                StringLike: { 'aws:ResourceTag/AWSServiceName': 'ChimeSDK' },
              },
            }),
          ],
        }),
        ['kinesisDataStreamSinkPolicy']: kdsSinkPolicy,
      },
    });

    this.transcribeMediaInsightsPipeline = new MediaInsightsPipeline(
      this,
      'transcribeConfiguration',
      {
        resourceAccessRoleArn: kvsRole.roleArn,
        mediaInsightsPipelineConfigurationName: 'CallAnalyticsProducer',
        elements: [
          {
            type: ElementsType.AMAZON_TRANSCRIBE_PROCESSOR,
            amazonTranscribeProcessorConfiguration: {
              languageCode: LanguageCode.EN_US,
            },
          },
          {
            type: ElementsType.KINESIS_DATA_STREAM_SINK,
            kinesisDataStreamSinkConfiguration: {
              insightsTarget: props.kinesisDataStream.streamArn,
            },
          },
        ],
      },
    );
  }
}
