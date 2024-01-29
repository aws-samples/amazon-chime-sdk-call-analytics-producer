import { S3Event } from 'aws-lambda';
import axios from 'axios';

const APPLICATION_LOAD_BALANCER_URL = process.env.APPLICATION_LOAD_BALANCER_URL;

export const handler = async (event: S3Event): Promise<null> => {
  console.info(JSON.stringify(event, null, 2));
  await startStreamer({
    bucketName: event.Records[0].s3.bucket.name,
    keyName: event.Records[0].s3.object.key,
  });
  return null;
};

async function startStreamer({
  bucketName,
  keyName,
}: {
  bucketName: string;
  keyName: string;
}) {
  console.log('Starting Streamer');
  try {
    const response = await axios.post(
      `http://${APPLICATION_LOAD_BALANCER_URL}/processObject`,
      { bucketName, keyName },
    );
    console.log('POST request response:', response.data);
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
}
